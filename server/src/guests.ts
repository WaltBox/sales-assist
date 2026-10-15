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
export async function guestSend(d: Deps, guest: Guest, req: { company: string; name?: string | null; email: string }) {
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
  const meme = await memeFor(d, lead.id).catch(() => null);
  let r;
  try {
    r = await sendLineCard(d, lead.id, { to: email, name, referredBy: g.name.split(/\s+/)[0], format: "pdf_only", meme });
  } catch (err) {
    if (err instanceof LineCardError) throw new GuestError(400, err.message);
    throw err;
  }
  await d.close.createNote(lead.id, `[Guest] ${g.name} sent the line card to ${name ? `${name} <${email}>` : email} from the guest link.`, false).catch(() => undefined);
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
