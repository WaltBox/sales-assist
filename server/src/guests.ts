import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Deps } from "./assistant.js";
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
export type Guest = { id: string; name: string; tokenHash: string; createdAt: string; active: boolean; offAt: string | null; sends: GuestSend[] };

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
    r = await sendLineCard(d, lead.id, { to: email, name, referredBy: g.name.split(/\s+/)[0], format: "pdf_only", meme });
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

/** What the guest page shows: their name, today's count, their last sends. Nothing else of the rep's. */
export function guestView(g: Guest, now = new Date()) {
  return { name: g.name, today: g.sends.filter((s) => sameDay(s.at, now)).length, cap: GUEST_DAILY_CAP, recent: g.sends.slice(0, 15).map((s) => ({ at: s.at, company: s.company, to: s.to })) };
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
    if (id && !lead.leadId) lead.leadId = id;
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
