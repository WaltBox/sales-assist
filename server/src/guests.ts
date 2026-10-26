import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Deps } from "./assistant.js";
import type { LeadEmail } from "./close.js";
import { store } from "./store.js";
import { LineCardError, sendLineCard } from "./linecard.js";
import { memeFor } from "./memes.js";

/**
 * Guest links (Walt 10/15): someone on a work trial calls off a spreadsheet and sends line cards, but from
 * walt@westgatesupply.com, not their own email. A guest gets a private link (no password) that does one thing:
 * type a company, a name and an email, and the line card goes out from Walt's Close account with the PDF. The link
 * can be switched off any time. Every send lands on the lead in Close with a note saying which guest sent it, so it
 * shows up in the app, the heat map and the two-day email sequence like any line card Walt sends.
 */

export type GuestSend = { at: string; company: string; to: string; name: string | null; leadId: string; newLead: boolean };
export type Guest = { id: string; name: string; tokenHash: string; createdAt: string; active: boolean; offAt: string | null; sends: GuestSend[];
  /** Their own email, CC'd on every line card they send (10/16). */
  ccEmail?: string | null };

const KEY = "guests";
/** A day's sends per link: plenty for a full day of calling, and a cap if a link ends up somewhere it shouldn't. */
export const GUEST_DAILY_CAP = 150;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|comcast|att|sbcglobal|verizon|me|protonmail)\./i;

export class GuestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function listGuests(repId: string): Promise<Guest[]> {
  return (await store.getSetting<Guest[]>(repId, KEY)) ?? [];
}
async function saveGuests(repId: string, guests: Guest[]) {
  await store.putSetting(repId, KEY, guests);
}

/** A new link. The token is only ever shown once, here; the store keeps a hash of it. */
export async function createGuest(repId: string, name: string): Promise<{ guest: Guest; token: string }> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new GuestError(400, "Give the guest a name, so their sends are labeled in Close.");
  const token = randomBytes(24).toString("base64url");
  const guest: Guest = { id: randomUUID(), name: clean, tokenHash: hash(token), createdAt: new Date().toISOString(), active: true, offAt: null, sends: [] };
  await saveGuests(repId, [...(await listGuests(repId)), guest]);
  return { guest, token };
}

export async function setGuestActive(repId: string, id: string, active: boolean): Promise<Guest> {
  const guests = await listGuests(repId);
  const g = guests.find((x) => x.id === id);
  if (!g) throw new GuestError(404, "No guest link with that id.");
  g.active = active;
  g.offAt = active ? null : new Date().toISOString();
  await saveGuests(repId, guests);
  return g;
}

/** The link's guest and whose account it sends from. Off or unknown links get the same answer, on purpose. */
export async function guestFor(token: string, repIds: string[]): Promise<{ repId: string; guest: Guest } | null> {
  if (!token || token.length < 20) return null;
  const h = hash(token);
  for (const repId of repIds) {
    const g = (await listGuests(repId)).find((x) => x.tokenHash === h);
    if (g) return g.active ? { repId, guest: g } : null;
  }
  return null;
}

const sameDay = (a: string, b: Date) => new Date(a).toDateString() === b.toDateString();

/** The company in Close: by the exact address, then the company's email domain, then the company name. */
export async function findLead(d: Deps, company: string, email: string): Promise<{ id: string; name: string } | null> {
  const byEmail = (await d.close.findLeads(`"${email}"`).catch(() => []))[0];
  if (byEmail) return { id: byEmail.id, name: byEmail.display_name };
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (domain && !FREE_MAIL.test(domain)) {
    for (const l of (await d.close.findLeads(`"${domain}"`).catch(() => [])).slice(0, 5)) {
      const lead = await d.close.lead(l.id).catch(() => null);
      const emails = (lead?.contacts ?? []).flatMap((c) => c.emails.map((e) => e.email.toLowerCase()));
      if (emails.some((e) => e.endsWith(`@${domain}`)) || (lead?.url ?? "").toLowerCase().includes(domain)) return { id: l.id, name: l.display_name };
    }
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(inc|llc|co|corp|company|ltd)$/, "");
  const byName = (await d.close.findLeads(`name:"${company.replace(/"/g, "")}"`).catch(() => [])).find((l) => norm(l.display_name) === norm(company));
  return byName ? { id: byName.id, name: byName.display_name } : null;
}

/**
 * Send the line card for a guest, from the rep's account: find or create the lead, send it the way the call
 * screen does (PDF attached, a meme, "<guest> suggested I send this your way"), and note who sent it.
 */
export async function guestSend(d: Deps, guest: Guest, req: { company: string; name?: string | null; email: string; meme?: boolean }) {
  const now = d.now?.() ?? new Date();
  const company = req.company.trim().slice(0, 120);
  const email = req.email.trim().toLowerCase();
  const name = req.name?.trim().slice(0, 60) || null;
  if (!company) throw new GuestError(400, "Type the company name.");
  if (!EMAIL.test(email)) throw new GuestError(400, `"${req.email}" doesn't look like an email address.`);
  const guests = await listGuests(d.rep.closeUserId);
  const g = guests.find((x) => x.id === guest.id);
  if (!g || !g.active) throw new GuestError(403, "This link has been turned off.");
  if (g.sends.filter((s) => sameDay(s.at, now)).length >= GUEST_DAILY_CAP) throw new GuestError(429, `That's ${GUEST_DAILY_CAP} line cards today, the limit for this link. It resets tomorrow.`);

  let lead = await findLead(d, company, email);
  const newLead = !lead;
  if (!lead) {
    const made = await d.close.createLead({ name: company, contactName: name, email });
    lead = { id: made.id, name: made.display_name ?? company };
  }
  // No meme unless they tick "Add a meme" (Walt 10/15); then one this company hasn't had.
  const meme = req.meme ? await memeFor(d, lead.id).catch(() => null) : null;
  let r;
  try {
    r = await sendLineCard(d, lead.id, { to: email, name, referredBy: g.name.split(/\s+/)[0], format: "pdf_only", meme, cc: g.ccEmail ? [g.ccEmail] : [] });
  } catch (err) {
    if (err instanceof LineCardError) throw new GuestError(400, err.message);
    throw err;
  }
  await d.close.createNote(lead.id, `[Work trial] ${g.name} (work trial) sent the line card to ${name ? `${name} <${email}>` : email}${meme ? ` with the ${meme.name.replace(/\.[a-z0-9]+$/i, "")} meme` : ""}.`, false).catch(() => undefined);
  const send: GuestSend = { at: now.toISOString(), company: lead.name, to: email, name, leadId: lead.id, newLead };
  // Re-read before saving: another send from the same link could have landed meanwhile.
  const fresh = await listGuests(d.rep.closeUserId);
  const fg = fresh.find((x) => x.id === g.id);
  if (fg) { fg.sends = [send, ...fg.sends].slice(0, 500); await saveGuests(d.rep.closeUserId, fresh); }
  return { sent: true, company: lead.name, to: email, newLead, threaded: r.threaded, today: (fg?.sends ?? []).filter((s) => sameDay(s.at, now)).length, cap: GUEST_DAILY_CAP };
}

/** The guest's own email, CC'd on every line card they send; empty clears it. */
export async function setGuestCc(repId: string, guestId: string, raw: string | null) {
  const cc = String(raw ?? "").trim().toLowerCase().slice(0, 160);
  if (cc && !EMAIL.test(cc)) throw new GuestError(400, `"${raw}" doesn't look like an email address.`);
  const guests = await listGuests(repId);
  const g = guests.find((x) => x.id === guestId);
  if (!g || !g.active) throw new GuestError(403, "This link has been turned off.");
  g.ccEmail = cc || null;
  await saveGuests(repId, guests);
  return { ccEmail: g.ccEmail };
}

/** What the guest page shows: their name, today's count, their last sends. Nothing else of the rep's. */
export function guestView(g: Guest, now = new Date()) {
  return { name: g.name, ccEmail: g.ccEmail ?? null, today: g.sends.filter((s) => sameDay(s.at, now)).length, cap: GUEST_DAILY_CAP, recent: g.sends.slice(0, 15).map((s) => ({ at: s.at, company: s.company, to: s.to })) };
}

// ---------- the call list (Walt 10/15): the guest uploads their sheet and calls from it here ----------

export const OUTCOMES = ["Reached buyer", "Wants line card", "Sending an RFQ", "Got a name", "Voicemail", "No answer", "Not interested", "Wrong number"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type ListLead = {
  i: number; company: string; phone: string; askFor: string; what: string; city: string; state: string;
  email: string; notes: string; outcome: Outcome | null; outcomeAt: string | null; leadId: string | null;
  /** The name they got on the call ("Got a name", 10/15): who to ask for next time. */
  gotName?: string;
};
export type CallList = { name: string; uploadedAt: string; leads: ListLead[] };
const LIST_MAX = 3000;
const listKey = (guestId: string) => `guestList:${guestId}`;

export async function getList(repId: string, guestId: string): Promise<CallList | null> {
  return store.getSetting<CallList>(repId, listKey(guestId));
}

/** A new list from the guest's sheet (already split into rows in their browser); replaces any earlier one. */
export async function putList(repId: string, guest: Guest, body: { name?: string; rows: Array<Record<string, unknown>> }): Promise<CallList> {
  const s = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const rows = (body.rows ?? []).slice(0, LIST_MAX);
  const leads: ListLead[] = rows.map((r, i) => ({
    i, company: s(r.company, 160), phone: s(r.phone, 40), askFor: s(r.askFor, 120) || "Purchasing manager", what: s(r.what, 400),
    city: s(r.city, 60), state: s(r.state, 30).toUpperCase().slice(0, 2), email: s(r.email, 160), notes: s(r.notes, 1000),
    outcome: (OUTCOMES as readonly string[]).includes(s(r.outcome, 40)) ? (s(r.outcome, 40) as Outcome) : null, outcomeAt: null, leadId: null,
  })).filter((l) => l.company && l.phone);
  if (!leads.length) throw new GuestError(400, "Couldn't find any rows with a company and a phone number in that file.");
  const list: CallList = { name: s(body.name, 80) || "Call list", uploadedAt: new Date().toISOString(), leads };
  await store.putSetting(repId, listKey(guest.id), list);
  return list;
}

/**
 * The guest marks a lead: an outcome, notes, the email they got. A note goes on the lead in Close when the company
 * is found there (notes only: no status changes, no tasks).
 */
export type MarkPatch = { outcome?: string | null; notes?: string | null; email?: string | null; gotName?: string | null };

/**
 * Several marks in one save (10/15): the page queues taps and sends them one request at a time, so two saves never
 * overwrite each other (that's how marks were getting lost). The Close notes are written after the answer, in the
 * background, so a tap never waits on Close.
 */
export async function markListLeads(d: Deps, guest: Guest, marks: Array<{ i: number } & MarkPatch>) {
  const list = await getList(d.rep.closeUserId, guest.id);
  if (!list) throw new GuestError(404, "Upload your list first.");
  const notes: Array<() => Promise<unknown>> = [];
  const out: ListLead[] = [];
  for (const m of marks.slice(0, 200)) {
    const lead = list.leads.find((l) => l.i === m.i);
    if (!lead) continue;
    const r = applyMark(d, guest, lead, m);
    if (r) notes.push(r);
    out.push(lead);
  }
  await store.putSetting(d.rep.closeUserId, listKey(guest.id), list);
  return { leads: out, called: list.leads.filter((l) => l.outcome).length, total: list.leads.length, notes };
}

/** Apply one mark; returns the Close note to write later, if one is due. */
function applyMark(d: Deps, guest: Guest, lead: ListLead, patch: MarkPatch): (() => Promise<unknown>) | null {
  const before = lead.outcome;
  if (patch.outcome !== undefined) {
    if (patch.outcome !== null && !(OUTCOMES as readonly string[]).includes(patch.outcome)) throw new GuestError(400, "Pick an outcome from the list.");
    lead.outcome = (patch.outcome as Outcome | null) ?? null;
    lead.outcomeAt = patch.outcome ? (d.now?.() ?? new Date()).toISOString() : null;
  }
  if (patch.notes !== undefined) lead.notes = String(patch.notes ?? "").slice(0, 1000);
  if (patch.email !== undefined) lead.email = String(patch.email ?? "").trim().slice(0, 160);
  const nameBefore = lead.gotName ?? "";
  if (patch.gotName !== undefined) lead.gotName = String(patch.gotName ?? "").trim().slice(0, 120);
  const newName = !!lead.gotName && lead.gotName !== nameBefore;
  if (!lead.outcome || (lead.outcome === before && !newName)) return null;
  const snap = { ...lead };
  return async () => {
    const id = snap.leadId ?? (await findLead(d, snap.company, snap.email || "nobody@invalid.invalid").catch(() => null))?.id ?? null;
    if (id && !lead.leadId) {
      lead.leadId = id;
      // Remember which Close lead this row is, for the follow-ups tab (kept apart from the list so it never races a save).
      const ids = (await store.getSetting<Record<string, string>>(d.rep.closeUserId, idsKey(guest.id)).catch(() => null)) ?? {};
      if (ids[snap.i] !== id) await store.putSetting(d.rep.closeUserId, idsKey(guest.id), { ...ids, [snap.i]: id }).catch(() => undefined);
    }
    if (id) await d.close.createNote(id, `[Work trial] Called by ${guest.name} (work trial): ${snap.outcome}.${snap.gotName ? ` Ask for: ${snap.gotName}.` : ""}${snap.notes ? ` Notes: ${snap.notes}` : ""}${snap.email ? ` Email: ${snap.email}` : ""}`, false);
  };
}

/** One mark, saved and noted in Close before returning (tests, and the old single-mark route). */
export async function markListLead(d: Deps, guest: Guest, i: number, patch: MarkPatch) {
  const list = await getList(d.rep.closeUserId, guest.id);
  const lead = list?.leads.find((l) => l.i === i);
  if (!list || !lead) throw new GuestError(404, "That lead isn't on your list.");
  const r = await markListLeads(d, guest, [{ i, ...patch }]);
  for (const n of r.notes) await n().catch(() => undefined);
  return r.leads[0];
}

/** Counts by outcome, for the rep's Guests tab. */
export function listSummary(list: CallList | null) {
  if (!list) return null;
  const by: Record<string, number> = {};
  for (const l of list.leads) if (l.outcome) by[l.outcome] = (by[l.outcome] ?? 0) + 1;
  return { name: list.name, uploadedAt: list.uploadedAt, total: list.leads.length, called: list.leads.filter((l) => l.outcome).length, by };
}

/** The list back as a spreadsheet (CSV), with what the guest filled in. */
export function listCsv(list: CallList) {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ["Company", "Phone", "Ask for", "What they do", "City", "State", "Outcome", "Called at", "Name they got", "Email (for line card)", "Notes"];
  const rows = list.leads.map((l) => [l.company, l.phone, l.askFor, l.what, l.city, l.state, l.outcome ?? "", l.outcomeAt ?? "", l.gotName ?? "", l.email, l.notes].map((v) => q(String(v))).join(","));
  return [head.join(","), ...rows].join("\n");
}

// ---------- follow-ups (Walt 10/15): the guest sees where the companies they called stand now ----------

const idsKey = (guestId: string) => `guestLeadIds:${guestId}`;
/** Every Close lead a guest has touched: the line cards they sent and the list rows matched to a lead (West Game, 10/25). */
export async function guestLeadIds(repId: string, guest: Guest): Promise<Set<string>> {
  const ids = (await store.getSetting<Record<string, string>>(repId, idsKey(guest.id)).catch(() => null)) ?? {};
  return new Set([...guest.sends.map((s) => s.leadId), ...Object.values(ids)].filter(Boolean));
}
const followKey = (guestId: string) => `guestFollow:${guestId}`;
/** Statuses Walt has taken over: the RFQ is in, the guest doesn't need to call. */
const RFQ_STATUSES = /rfq|quoted|customer|vendor/i;
const FOLLOW_TTL_MS = 10 * 60 * 1000;
const FOLLOW_MAX = 200;

export type FollowUp = {
  i: number | null; company: string; phone: string; askFor: string; state: string;
  outcome: string | null; calledAt: string | null; notes: string;
  /** From Close: the lead's status now, the last line card email, its opens, and any reply after it. */
  inClose: boolean; status: string | null; rfq: boolean;
  lineCardAt: string | null; lineCardTo: string | null; opens: number; lastOpenAt: string | null; repliedAt: string | null;
};

async function eachLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let at = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (at < items.length) await fn(items[at++]); }));
}

const isLineCard = (e: LeadEmail) => e.direction === "outgoing" && e.status === "sent"
  && ((e.attachments ?? []).some((a) => /line.?card/i.test(a.filename ?? "")) || /line card/i.test(`${e.subject ?? ""} ${(e.body_text ?? "").slice(0, 400)}`));

/**
 * Everyone the guest called (any outcome) and everyone they sent a line card to, with where each stands in Close.
 * Line cards first, so tomorrow they call back the people who got one. Cached ten minutes; `fresh` skips it.
 */
export async function guestFollowUps(d: Deps, guest: Guest, opts: { fresh?: boolean } = {}): Promise<{ at: string; rows: FollowUp[] }> {
  const repId = d.rep.closeUserId;
  const now = d.now?.() ?? new Date();
  // What Close said about each company, kept ten minutes per company: new calls show at once, and only stale
  // companies are looked up again.
  type Seen = { at: string; status: string | null; lineCardAt: string | null; lineCardTo: string | null; opens: number; lastOpenAt: string | null; replies: string[] };
  const seen = (await store.getSetting<Record<string, Seen>>(repId, followKey(guest.id))) ?? {};
  let seenChanged = false;
  const list = await getList(repId, guest.id);
  const g = (await listGuests(repId)).find((x) => x.id === guest.id) ?? guest;
  const ids = (await store.getSetting<Record<string, string>>(repId, idsKey(guest.id))) ?? {};
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const rows: Array<FollowUp & { leadId: string | null; email: string }> = [];
  for (const l of (list?.leads ?? []).filter((x) => x.outcome)) {
    const send = g.sends.find((s) => (l.email && s.to === l.email.toLowerCase()) || norm(s.company) === norm(l.company));
    rows.push({ i: l.i, company: l.company, phone: l.phone, askFor: l.gotName || l.askFor, state: l.state, outcome: l.outcome, calledAt: l.outcomeAt, notes: l.notes,
      leadId: ids[l.i] ?? l.leadId ?? send?.leadId ?? null, email: l.email || send?.to || "",
      inClose: false, status: null, rfq: false, lineCardAt: send?.at ?? null, lineCardTo: send?.to ?? null, opens: 0, lastOpenAt: null, repliedAt: null });
  }
  // Line cards sent from the "Send a line card" tab for companies that aren't on the sheet.
  for (const s of g.sends) {
    if (rows.some((r) => r.leadId === s.leadId || norm(r.company) === norm(s.company))) continue;
    rows.push({ i: null, company: s.company, phone: "", askFor: s.name ?? "", state: "", outcome: "Wants line card", calledAt: s.at, notes: "",
      leadId: s.leadId, email: s.to, inClose: false, status: null, rfq: false, lineCardAt: s.at, lineCardTo: s.to, opens: 0, lastOpenAt: null, repliedAt: null });
  }
  rows.sort((a, b) => (b.calledAt ?? "").localeCompare(a.calledAt ?? ""));
  const work = rows.slice(0, FOLLOW_MAX);

  let found = false;
  await eachLimit(work, 4, async (r) => {
    try {
      if (!r.leadId) {
        r.leadId = (await findLead(d, r.company, r.email || "nobody@invalid.invalid").catch(() => null))?.id ?? null;
        if (r.leadId && r.i != null) { ids[r.i] = r.leadId; found = true; }
      }
      if (!r.leadId) return;
      let c = seen[r.leadId];
      if (opts.fresh || !c || now.getTime() - Date.parse(c.at) > FOLLOW_TTL_MS) {
        const [lead, emails] = await Promise.all([d.close.lead(r.leadId), d.close.leadEmails(r.leadId).catch(() => [] as LeadEmail[])]);
        const when = (e: LeadEmail) => e.date_sent ?? e.date_created ?? "";
        const card = emails.filter(isLineCard).sort((a, b) => when(b).localeCompare(when(a)))[0];
        const opens = (card?.opens ?? []).map((o) => o.opened_at).sort();
        c = { at: now.toISOString(), status: (lead as { status_label?: string }).status_label ?? null, lineCardAt: card ? when(card) || null : null, lineCardTo: card?.to?.[0] ?? null,
          opens: opens.length, lastOpenAt: opens.at(-1) ?? null, replies: emails.filter((e) => e.direction === "incoming").map(when).filter(Boolean).sort() };
        seen[r.leadId] = c; seenChanged = true;
      }
      r.inClose = true;
      r.status = c.status;
      r.rfq = !!r.status && RFQ_STATUSES.test(r.status);
      if (c.lineCardAt) { r.lineCardAt = c.lineCardAt; r.lineCardTo = c.lineCardTo ?? r.lineCardTo; r.opens = c.opens; r.lastOpenAt = c.lastOpenAt; }
      const since = r.lineCardAt ?? r.calledAt ?? "";
      r.repliedAt = c.replies.filter((x) => x > since).at(-1) ?? null;
    } catch { /* one company failing to load shouldn't hide the rest */ }
  });
  if (found) await store.putSetting(repId, idsKey(guest.id), ids);

  const rank = (r: FollowUp) => (r.rfq ? 6 : r.repliedAt ? 0 : r.lineCardAt && r.opens ? 1 : r.lineCardAt ? 2 : r.outcome === "Sending an RFQ" ? 3 : r.outcome === "Got a name" || r.outcome === "Reached buyer" ? 4 : 5);
  const out = work.map(({ leadId: _l, email: _e, ...r }) => r).sort((a, b) => rank(a) - rank(b) || (b.lineCardAt ?? b.calledAt ?? "").localeCompare(a.lineCardAt ?? a.calledAt ?? ""));
  if (seenChanged) await store.putSetting(repId, followKey(guest.id), seen);
  return { at: now.toISOString(), rows: out };
}

// ---------- filling a sheet in from Close (10/21: a Close export has no phone column) ----------

type RawSheetRow = Record<string, unknown>;
type CloseLeadForSheet = { id: string; display_name: string; url: string | null; description?: string | null; addresses?: Array<{ city?: string; state?: string }>;
  contacts?: Array<{ name?: string | null; title?: string | null; phones?: Array<{ phone: string }>; emails?: Array<{ email: string }> }> };

/**
 * A row with a company but no phone (a Close export, or a list of names) is looked up in Close by name, then by
 * website, and gets the main line, the buyer to ask for, the city and state, and a line on what they do. Rows that
 * already have a phone are left as they are. Reading only.
 */
export async function fillFromClose(d: Deps, rows: RawSheetRow[]): Promise<{ rows: RawSheetRow[]; filled: number; notFound: number }> {
  const str = (v: unknown) => String(v ?? "").trim();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const host = (u: string) => u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
  const fmt = (p: string) => { const n = p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : p; };
  const fields = "id,display_name,url,description,addresses,contacts";
  const todo = rows.filter((r) => str(r.company) && !str(r.phone)).slice(0, 1500);
  let filled = 0, notFound = 0;
  const find = async (r: RawSheetRow): Promise<CloseLeadForSheet | null> => {
    const company = str(r.company), site = host(str(r.website));
    const byName = await d.close.searchLeads<CloseLeadForSheet>(`name:"${company.replace(/"/g, "")}"`, { skip: 0, limit: 10, fields }).catch(() => ({ data: [] as CloseLeadForSheet[] }));
    const hit = byName.data.find((l) => norm(l.display_name) === norm(company));
    if (hit || !site) return hit ?? null;
    const bySite = await d.close.searchLeads<CloseLeadForSheet>(`url:"${site}"`, { skip: 0, limit: 10, fields }).catch(() => ({ data: [] as CloseLeadForSheet[] }));
    return bySite.data.find((l) => host(l.url ?? "") === site) ?? null;
  };
  let at = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (at < todo.length) {
      const r = todo[at++];
      const l = await find(r).catch(() => null);
      if (!l) { notFound++; continue; }
      const cs = l.contacts ?? [];
      const person = (c: (typeof cs)[number]) => !!c.name && !/main office|office|front desk|reception|general/i.test(c.name);
      const buyer = cs.find((c) => person(c) && /purchas|buyer|procure/i.test(c.title ?? "")) ?? cs.find(person);
      const main = cs.find((c) => /main office/i.test(c.name ?? "") && c.phones?.length) ?? cs.find((c) => c.phones?.length);
      const phone = main?.phones?.[0]?.phone ?? buyer?.phones?.[0]?.phone;
      if (!phone) { notFound++; continue; }
      const addr = l.addresses?.[0] ?? {};
      const desc = str(l.description).replace(/\s+/g, " ");
      const sentence = desc ? (desc.match(/^.{60,300}?[.!?](?=\s+[A-Z]|$)/)?.[0] ?? desc.slice(0, 280)).trim() : "";
      r.phone = fmt(phone);
      if (!str(r.askFor) || /main office|\+\d/i.test(str(r.askFor))) r.askFor = buyer ? `${buyer.name}${buyer.title ? ` (${buyer.title})` : ""}` : "";
      if (!str(r.what) || str(r.what).length > 400) r.what = sentence || str(r.what);
      if (!str(r.city)) r.city = addr.city ?? "";
      if (!str(r.state)) r.state = addr.state ?? "";
      if (!str(r.email) && buyer?.emails?.[0]?.email) r.email = buyer.emails[0].email;
      filled++;
    }
  }));
  return { rows, filled, notFound };
}
