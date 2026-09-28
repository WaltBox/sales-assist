import { classifyOpen, lineCardAttachments, RFQ_TAG, taskTitle, type Deps } from "./assistant.js";
import { bumpBody, nameFromEmail } from "./linecard.js";
import { stripDashes } from "./benchmark.js";
import type { CloseCall, CloseLead, LeadEmail } from "./close.js";
import { formatLocal } from "./rules.js";
import { store, type Automation } from "./store.js";
import { realAttachments } from "./stats.js";

// The accounts page (Walt 9/26): one row per account we've sent the line card
// to: where it stands, everything that's happened since, and what to do next.
// The next step comes from the calls and notes too, not just the emails
// ("Michael said no RFQs right now, check in Oct 15" means hold, not bump).
// Everything is read from Close; nothing is stored.

const LINE_CARD = "Westgate_Supply_Line_Card.pdf";
const DAY = 24 * 3600 * 1000;
/** Walt 9/26: bump every thread every 1-2 weeks until they send an RFQ. */
export const BUMP_AFTER_DAYS = 7;
/** Not opened by a person after this long: rescue it (call, send it again while they're on the phone). */
export const RESCUE_AFTER_DAYS = 2;
/**
 * Walt 9/28: once you've talked to them or emailed them, a rescue account drops off the list for this long,
 * then comes back if they still haven't opened the line card or sent an RFQ.
 */
export const HOLD_AFTER_TOUCH_DAYS = 7;

export type Seen = "bounced" | "replied" | "confirmed" | "opened" | "maybe" | "not_opened";
export type NextKind = "reply" | "quote" | "call_due" | "rescue" | "bump" | "scheduled" | "waiting";
export type Event = { at: string; kind: "line_card" | "email" | "reply" | "rfq" | "quote" | "opened" | "filter" | "call" | "note" | "auto"; text: string };

export type Account = {
  leadId: string;
  company: string;
  contact: { name: string | null; email: string | null; phone: string | null };
  cardSentAt: string;
  seen: Seen;
  opens: { person: number; maybe: number; filter: number; last: string | null; app: string | null };
  rfqPromised: boolean;
  /** The rescue email, drafted in Close ahead of the call (Walt 9/26): the rep clicks Send there once the buyer is on the phone. */
  rescueDraft: { id: string } | null;
  /** Their RFQ: an email from them with a real file (Matt's "Westgate pricing check.xlsx", 9/23). */
  rfq: { at: string; files: string[]; quotedAt: string | null } | null;
  /** tag: how ("Call", "Email · auto", "Quote", "Wait"); label: the goal ("Get the line card in front of Adrian"); detail: the why. label: a few words for the table ("Call Tammy: did they find it?"); detail: the why, shown when the row is open. */
  next: { kind: NextKind; tag: string; label: string; detail: string; due: string | null; rescue: boolean };
  events: Event[];
};

type Email = LeadEmail & { lead_id: string; user_id?: string; attachments?: Array<{ filename?: string }> };

const leadCache = new Map<string, { at: number; lead: CloseLead | null }>();
const boardCache = new Map<string, { at: number; value: Board }>();
type Board = { accounts: Account[]; counts: Record<NextKind, number> };

const addr = (s: string | null | undefined) => (s ?? "").match(/<([^>]+)>/)?.[1] ?? (s ?? "").trim();
const personName = (s: string | null | undefined) => (s ?? "").match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? null;
const appOf = (ua: string | null | undefined) =>
  /outlook|ms-office|microsoft office/i.test(ua ?? "") ? "Outlook" : /iphone|ipad/i.test(ua ?? "") ? "iPhone" : /googleimageproxy|ggpht|gmail/i.test(ua ?? "") ? "Gmail"
    : /macintosh/i.test(ua ?? "") ? "Apple Mail" : /android/i.test(ua ?? "") ? "Android" : null;
/** A task's point in a few words: "Call Diane Townsend (Purchasing Manager)", not the whole briefing. */
export const shortTask = (text: string, company = "") => {
  let t = taskTitle(text);
  // Drop "at <company>" (company names often end in "Inc."), then keep the first sentence.
  const co = company.split(/[,(]/)[0].trim().slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (co) t = t.replace(new RegExp(`\\s+at\\s+${co}.*$`, "i"), "");
  t = t.split(/(?<=[a-z]{2}[.;])\s|\s\(\d{3}[)-]|, (?:ask|and|then|confirm|get)\b/i)[0].replace(/[.;,]$/, "").trim();
  // Emails and phone numbers in parentheses belong in Close, not the table.
  t = t.replace(/\s*\([^)]*(@|\d{3}[-.)\s]\d{3})[^)]*\)?/g, "").replace(/\s+(if|on|re:|about|regarding)\s.*$/i, "").trim();
  return t.length > 48 ? `${t.slice(0, 47).replace(/\s+\S*$/, "")}…` : t;
};
/** A task, said as a goal: "Call whoever handles purchasing" → "Find who buys at Hefco"; "Call Josipa Kristo" → "Reach Josipa Kristo". */
export function taskGoal(text: string, company: string, co: string) {
  const t = shortTask(text, company);
  if (/whoever handles purchasing|purchasing contact|the buyer\b|who (handles|does) (the )?(purchasing|buying)/i.test(t)) return `Find who buys at ${co}`;
  return t.replace(/^(call back|call|try)\s+/i, "Reach ").replace(/\s+again$/i, "");
}
// A note from a call where they said they have it ("she confirmed she got the line card, it was in junk").
// What the rep marks after a rescue call (written to Close as a note, so Close has it too).
export const FOUND_TAG = "[Got it]";
export const NOT_FOUND_TAG = "[Couldn't find it]";
const CONFIRMED = /\b(confirm(ed|s)?|said|says)\b[^.]{0,40}\b(got|received|has|have|saw|found)\b[^.]{0,30}\b(line card|line sheet|email)\b/i;
/** A bounce notice from their mail server: not a reply, and not an RFQ. */
export const isBounce = (e: { subject?: string | null; sender?: string | null }) =>
  /delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem)|returned mail|message blocked|delivery (has )?failed/i.test(e.subject ?? "")
  || /mailer-daemon|postmaster/i.test(e.sender ?? "");
const oneLine = (s: string, n = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export async function accountsBoard(d: Deps, opts: { days?: number; fresh?: boolean } = {}): Promise<Board> {
  const key = `${d.rep.closeUserId}:${opts.days ?? 45}`;
  const hit = boardCache.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < 60_000) return hit.value;

  const now = d.now?.() ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 45) * DAY);
  const ours = (who: string | null | undefined) => !who || /@westgatesupply\.com$/i.test(addr(who)) || addr(who).toLowerCase() === d.rep.email.toLowerCase();
  const [all, notes, tasks, calls, autos, drafts, autoOn] = await Promise.all([
    d.close.listSince<Email>("email", {
      since: new Date(since.getTime() - 14 * DAY).toISOString(), max: 5000,
      fields: "id,user_id,lead_id,status,direction,subject,date_sent,date_created,opens,to,sender,attachments,thread_id,contact_id",
    }),
    d.close.listSince<{ id: string; lead_id: string; note: string; date_created: string }>("note", { since: since.toISOString(), fields: "id,lead_id,note,date_created", max: 3000 }),
    d.close.openTasksFor(d.rep.closeUserId).catch(() => []),
    d.close.calls({ since: since.toISOString(), withTranscripts: false, max: 3000 }),
    store.listAutomations(d.rep.closeUserId, since.toISOString()).catch(() => [] as Automation[]),
    rescueDrafts(d),
    store.getSetting<boolean>(d.rep.closeUserId, "autoBumps").then((v) => v === true).catch(() => false),
  ]);
  const at = (e: Email) => e.date_sent ?? e.date_created ?? "";
  const cards = all.filter((e) => e.direction === "outgoing" && e.status === "sent" && e.user_id === d.rep.closeUserId && at(e) >= since.toISOString()
    && (e.attachments ?? []).some((a) => a.filename === LINE_CARD));
  const latestCard = new Map<string, Email>();
  for (const e of cards) if (!latestCard.has(e.lead_id) || at(e) > at(latestCard.get(e.lead_id)!)) latestCard.set(e.lead_id, e);

  // Company names and contact phones, remembered for 10 minutes.
  const ids = [...latestCard.keys()];
  const stale = ids.filter((id) => { const c = leadCache.get(id); return !c || Date.now() - c.at > 10 * 60_000; });
  for (let i = 0; i < stale.length; i += 5) {
    await Promise.all(stale.slice(i, i + 5).map(async (id) => leadCache.set(id, { at: Date.now(), lead: await d.close.lead(id).catch(() => null) })));
  }

  // Bounce notices: read the body to see which address bounced (CIBS 9/24: blocked; Metal Rise: a typo'd second address).
  const bounceIds = new Set(all.filter((e) => ids.includes(e.lead_id) && e.direction === "incoming" && isBounce(e)).map((e) => e.id));
  const bounceBodies = new Map<string, string>();
  for (const leadId of new Set(all.filter((e) => bounceIds.has(e.id)).map((e) => e.lead_id))) {
    for (const e of await d.close.leadEmails(leadId).catch(() => [])) if (bounceIds.has(e.id)) bounceBodies.set(e.id, e.body_text ?? "");
  }
  const accounts = ids.map((leadId) => buildAccount({
    d, now, card: latestCard.get(leadId)!, lead: leadCache.get(leadId)?.lead ?? null, ours,
    emails: all.filter((e) => e.lead_id === leadId && e.status !== "draft"),
    notes: notes.filter((n) => n.lead_id === leadId),
    tasks: tasks.filter((t) => t.lead_id === leadId),
    calls: calls.filter((c) => c.lead_id === leadId),
    autos: autos.filter((a) => a.leadId === leadId),
    rescueDraft: drafts[leadId] ?? null,
    autoOn,
    bounceBodies,
  }));
  const order: Record<NextKind, number> = { reply: 0, quote: 1, call_due: 2, rescue: 3, bump: 4, scheduled: 5, waiting: 6 };
  accounts.sort((a, b) => order[a.next.kind] - order[b.next.kind] || (a.next.due ?? "9").localeCompare(b.next.due ?? "9") || b.cardSentAt.localeCompare(a.cardSentAt));
  const counts = { reply: 0, quote: 0, call_due: 0, rescue: 0, bump: 0, scheduled: 0, waiting: 0 };
  for (const a of accounts) counts[a.next.kind]++;
  const value = { accounts, counts };
  boardCache.set(key, { at: Date.now(), value });
  return value;
}

export function buildAccount(x: {
  d: Deps; now: Date; card: Email; lead: CloseLead | null; ours: (who: string | null | undefined) => boolean;
  emails: Email[]; notes: Array<{ note: string; date_created: string }>; tasks: Array<{ text: string; date: string }>; calls: CloseCall[];
  bounceBodies?: Map<string, string>;
  autos?: Automation[];
  rescueDraft?: string | null;
  autoOn?: boolean;
}): Account {
  const { d, now, card, lead } = x;
  const at = (e: Email) => e.date_sent ?? e.date_created ?? "";
  const tz = d.rep.timeZone;
  const t0 = at(card);
  const toAddr = addr(card.to?.[0]);
  const contact = lead?.contacts.find((c) => c.emails.some((e) => e.email.toLowerCase() === toAddr.toLowerCase()));
  const phone = contact?.phones[0]?.phone ?? lead?.contacts.flatMap((c) => c.phones)[0]?.phone ?? null;

  const outgoing = x.emails.filter((e) => e.direction === "outgoing" && at(e) >= t0).sort((a, b) => at(a).localeCompare(at(b)));
  const bounces = x.emails.filter((e) => e.direction === "incoming" && at(e) >= t0 && isBounce(e));
  // Only a bounce for the address the line card went to counts (or one we can't read, to be safe).
  const bounce = bounces.find((e) => { const body = x.bounceBodies?.get(e.id); return body === undefined || !toAddr || body.toLowerCase().includes(toAddr.toLowerCase()); });
  const blocked = !!bounce && /blocked|rejected|spam|policy/i.test(x.bounceBodies?.get(bounce.id) ?? "");
  const replies = x.emails.filter((e) => e.direction === "incoming" && at(e) >= t0 && !x.ours(e.sender) && !isBounce(e)).sort((a, b) => at(a).localeCompare(at(b)));
  const opens = outgoing.flatMap((e) => (e.opens ?? []).filter((o) => !x.ours(o.opened_by)).map((o) => ({ ...o, kind: classifyOpen(o, at(e)) })));
  const person = opens.filter((o) => o.kind === "person").sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  const maybe = opens.filter((o) => o.kind === "maybe");
  const filter = opens.filter((o) => o.kind === "filter");
  // Said on a call around the send (Josipa, 9/24: "confirmed she got the line card, it was in junk").
  const recent = x.notes.filter((n) => n.date_created >= new Date(new Date(t0).getTime() - 3 * DAY).toISOString()).sort((a, b) => a.date_created.localeCompare(b.date_created));
  const marks = recent.filter((n) => n.note.includes(FOUND_TAG) || n.note.includes(NOT_FOUND_TAG));
  const lastMark = marks[marks.length - 1];
  const notFound = !!lastMark && lastMark.note.includes(NOT_FOUND_TAG);
  const confirmed = !notFound && (!!lastMark || recent.some((n) => CONFIRMED.test(n.note)));
  const seen: Seen = replies.length ? "replied" : bounce ? "bounced" : confirmed ? "confirmed" : person.length ? "opened" : maybe.length ? "maybe" : "not_opened";
  const lastOut = outgoing.map(at).pop() ?? t0;
  const lastIn = replies.map(at).pop() ?? null;
  const rfqPromised = x.notes.some((n) => n.note.includes(RFQ_TAG));
  // An RFQ is an email from them with a real file; a quote is ours back with a file or "quote"/"pricing" in the subject.
  const windowStart = new Date(new Date(t0).getTime() - 3 * DAY).toISOString();
  const rfqMail = x.emails.filter((e) => e.direction === "incoming" && at(e) >= windowStart && !x.ours(e.sender) && !isBounce(e) && realAttachments(e.attachments).length)
    .sort((a, b) => at(b).localeCompare(at(a)))[0];
  const quoteMail = rfqMail && x.emails.filter((e) => e.direction === "outgoing" && at(e) > at(rfqMail)
    && (realAttachments(e.attachments).some((f) => f !== LINE_CARD) || /\b(quote|quotation|pricing|proposal)\b/i.test(e.subject ?? "")))
    .sort((a, b) => at(a).localeCompare(at(b)))[0];
  const rfq = rfqMail ? { at: at(rfqMail), files: realAttachments(rfqMail.attachments), quotedAt: quoteMail ? at(quoteMail) : null } : null;

  // ---------- what happened, newest first ----------
  const events: Event[] = [];
  const who = personName(card.to?.[0]) ?? contact?.name ?? toAddr;
  for (const e of outgoing) {
    const isCard = e.id === card.id;
    events.push({ at: at(e), kind: isCard ? "line_card" : "email", text: isCard ? `Line card sent to ${who}` : `Email sent: ${e.subject ?? "(no subject)"}` });
  }
  if (person.length) {
    const app = appOf(person[0].user_agent);
    events.push({ at: person[0].opened_at, kind: "opened", text: `Opened by ${personName(person[0].opened_by) ?? person[0].opened_by}${app ? ` in ${app}` : ""}${person.length > 1 ? ` (${person.length}× total)` : ""}` });
  } else if (filter.length && !maybe.length) {
    events.push({ at: filter[0].opened_at, kind: "filter", text: "Only their spam filter touched it: no person has opened it" });
  }
  if (maybe.length && !person.length) events.push({ at: maybe[0].opened_at, kind: "opened", text: "Maybe opened (can't tell if it was a person)" });
  for (const r of replies) {
    const files = realAttachments(r.attachments);
    events.push(files.length
      ? { at: at(r), kind: "rfq", text: `${personName(r.sender) ?? addr(r.sender)} sent ${files.join(", ")}` }
      : { at: at(r), kind: "reply", text: `${personName(r.sender) ?? addr(r.sender)} replied: ${r.subject ?? ""}` });
  }
  for (const au of x.autos ?? []) {
    const time = au.scheduledFor ? formatLocal(new Date(au.scheduledFor), d.rep.timeZone, true) : "";
    if (au.status === "scheduled") events.push({ at: au.createdAt, kind: "auto", text: `Automatic bump scheduled for ${time}` });
    else if (au.status === "skipped") events.push({ at: au.statusAt ?? au.createdAt, kind: "auto", text: "Automatic bump skipped (left as a draft)" });
    else if (au.status === "stopped") events.push({ at: au.statusAt ?? au.createdAt, kind: "auto", text: au.note ?? "Automatic bump pulled back" });
  }
  // A sent automatic bump shows up as an email; mark it so you can tell it apart.
  for (const ev of events) if (ev.kind === "email" && (x.autos ?? []).some((au) => au.status === "sent" && au.subject && ev.text.endsWith(au.subject))) ev.text = ev.text.replace("Email sent:", "Automatic bump sent:");
  if (bounce) events.push({ at: at(bounce), kind: "filter", text: blocked ? `Their mail server blocked it: ${toAddr} never got it` : `Bounced: ${toAddr} didn't take it` });
  if (quoteMail) events.push({ at: at(quoteMail), kind: "quote", text: `Quote sent: ${quoteMail.subject ?? ""}` });
  const since = new Date(new Date(t0).getTime() - 3 * DAY).toISOString(); // the call that led to the line card, too
  // A real conversation since the line card went out (not a voicemail, not a pickup that hung up).
  const lastTalk = x.calls
    .filter((c) => c.direction === "outbound" && c.date_created > t0 && c.disposition === "answered" && c.duration >= 20
      && !/voicemail/i.test(c.note ?? ""))
    .map((c) => c.date_created).sort().pop() ?? null;
  for (const c of x.calls.filter((c) => c.date_created >= since && c.direction === "outbound")) {
    // Close marks a voicemail pickup "answered" too, so this says connected, not talked; the note says what happened.
    const connected = c.disposition === "answered" && c.duration >= 20;
    const vm = c.disposition === "vm-left" || /voicemail/i.test(c.note ?? "");
    const mins = c.duration >= 60 ? `${Math.round(c.duration / 60)} min` : `${c.duration}s`;
    events.push({ at: c.date_created, kind: "call", text: `${vm ? "Left a voicemail" : connected ? `Call connected (${mins})` : "Called, no answer"}${c.note ? `: ${oneLine(c.note, 110)}` : ""}` });
  }
  for (const n of x.notes.filter((n) => n.date_created >= since)) {
    events.push({ at: n.date_created, kind: "note", text: oneLine(n.note.replace(/\[RFQ (promised|asked)\]\s*/g, ""), 180) });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));

  return {
    leadId: card.lead_id, company: lead?.display_name ?? "Unknown account",
    contact: { name: contact?.name ?? personName(card.to?.[0]), email: toAddr || null, phone },
    cardSentAt: t0, seen, rfqPromised, rfq,
    // Only while it's still unsent: once it's sent it shows up as an email after the line card.
    rescueDraft: x.rescueDraft && !outgoing.some((e) => e.id === x.rescueDraft) ? { id: x.rescueDraft } : null,
    opens: { person: person.length, maybe: maybe.length, filter: filter.length, last: person.map((o) => o.opened_at).pop() ?? null, app: appOf(person[0]?.user_agent) },
    next: scheduledBump(x.autos, d.rep.timeZone, (contact?.name ?? personName(card.to?.[0]) ?? "").split(/\s+/)[0] || null) ?? nextStep({
      seen, cardSentAt: t0, lastOut, lastIn, lastTalk, rfqPromised, tasks: x.tasks, now, tz, company: lead?.display_name ?? "",
      who: (contact?.name ?? personName(card.to?.[0]) ?? "").split(/\s+/)[0] || null, notFound, markedAt: lastMark?.date_created ?? null, rfq, bounced: bounce ? (blocked ? "blocked" : "bounced") : null, toAddr, autoOn: x.autoOn,
    }),
    events,
  };
}

/** What to do next, with the calls in mind: a scheduled check-in means hold, not bump. */
/**
 * What to do next. A line card nobody has opened comes first (Walt 9/26): a person calls, asks if they found
 * it, and sends it again while they're on the line so it lands on top of whichever inbox it's in. Once they've
 * found it, the regular RFQ check-ins can start. After that, the calls decide: a scheduled check-in means hold, not bump.
 */
export function nextStep(a: {
  seen: Seen; cardSentAt: string; lastOut: string; lastIn: string | null; rfqPromised: boolean;
  /** The last real conversation since the line card went out (connected, not a voicemail). */
  lastTalk?: string | null;
  tasks: Array<{ text: string; date: string }>; now: Date; tz: string; company?: string;
  who?: string | null; notFound?: boolean; markedAt?: string | null;
  rfq?: Account["rfq"]; bounced?: "blocked" | "bounced" | null; toAddr?: string;
  autoOn?: boolean;
}): Account["next"] {
  const days = (iso: string) => Math.floor((a.now.getTime() - new Date(iso).getTime()) / DAY);
  const plus = (iso: string, n: number) => new Date(new Date(iso).getTime() + n * DAY).toISOString();
  const short = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: a.tz, month: "short", day: "numeric" });
  const endOfToday = new Date(a.now.getTime() + 12 * 3600 * 1000).toISOString();
  const open = [...a.tasks].sort((x, y) => x.date.localeCompare(y.date));
  const due = open.find((t) => t.date <= endOfToday);
  const later = open.find((t) => t.date > endOfToday);
  const unseen = a.seen === "not_opened";
  const who = a.who || null;
  const whose = who ? `${who}'s` : "their";
  const co = (a.company ?? "").split(/[,(]| - /)[0].replace(/\s+(Inc|LLC|Co|Corp|Company)\.?$/i, "").trim() || "them";
  const auto = a.autoOn ? "Email · auto" : "Email";
  // label = the goal (what we want from this account); tag = how we get it.
  const n = (kind: NextKind, tag: string, label: string, detail: string, due: string | null, rescue = false) => ({ kind, tag, label, detail, due, rescue });

  if (a.lastIn && a.lastIn >= a.lastOut) return n("reply", "Email", who ? `Answer ${who}` : "Answer them", "They wrote back and haven't heard from you since. Answer them in Close.", a.lastIn);

  // It never arrived: call for an address that works (or to have their IT let westgatesupply.com through).
  if (a.bounced && !(a.lastOut > a.cardSentAt)) {
    return a.bounced === "blocked"
      ? n("rescue", "Call", `Get past ${whose} mail filter`, `Their mail server blocked the line card to ${a.toAddr ?? "them"}. Call, ask for another address, or ask them to have IT allow westgatesupply.com.`, a.cardSentAt, false)
      : n("rescue", "Call", `Get a working email for ${who ?? co}`, `The line card bounced from ${a.toAddr ?? "that address"}. Call and get the right email.`, a.cardSentAt, false);
  }
  // Their RFQ is in: the next move is our quote, then following up on it. Old "nudge for the list" tasks don't apply.
  if (a.rfq && !a.rfq.quotedAt) {
    return n("quote", "Quote", `Price ${whose} RFQ`, `${who ?? "They"} sent ${a.rfq.files.join(", ")} on ${short(a.rfq.at)}. Get pricing back to them. (If you already quoted from another inbox, it won't show here.)`, a.rfq.at);
  }
  if (a.rfq?.quotedAt) {
    const since = days(a.rfq.quotedAt);
    return since >= 3
      ? n("bump", auto, "Hear back on the quote", `You quoted on ${short(a.rfq.quotedAt)} and haven't heard back. Ask if they have questions or need anything adjusted.`, plus(a.rfq.quotedAt, 3))
      : n("waiting", "Wait", `Quote out · follow up ${short(plus(a.rfq.quotedAt, 3))}`, `You quoted on ${short(a.rfq.quotedAt)}. If there's no answer by ${short(plus(a.rfq.quotedAt, 3))}, follow up.`, plus(a.rfq.quotedAt, 3));
  }

  if (unseen && days(a.cardSentAt) >= RESCUE_AFTER_DAYS) {
    // Walt 9/28: you talked to them or emailed them since the line card: off the list for a few days, then back
    // if they still haven't opened it or sent an RFQ. (A "couldn't find it" mark from that call still shows now.)
    const emailed = a.lastOut > a.cardSentAt ? a.lastOut : null;
    const talked = a.lastTalk && a.lastTalk > a.cardSentAt ? a.lastTalk : null;
    const touch = [emailed, talked].filter((t): t is string => !!t).sort().pop() ?? null;
    const marked = !!(touch && a.markedAt && a.markedAt >= touch);
    if (touch && days(touch) < HOLD_AFTER_TOUCH_DAYS && !a.notFound && !marked) {
      const back = plus(touch, HOLD_AFTER_TOUCH_DAYS);
      const how = touch === talked ? `talked ${short(touch)}` : `emailed ${short(touch)}`;
      return n("waiting", "Wait", `${who ?? "They"} finding it · ${how}`,
        `You ${touch === talked ? "talked to" : "emailed"} ${who ?? "them"} on ${short(touch)}. It's off the list until ${short(back)}; if the line card still isn't opened and no RFQ has come by then, it's back as a call.`,
        back);
    }
    const task = due ? " There's also a callback due today." : later ? ` There's also a task open for ${short(later.date)}.` : "";
    if (a.notFound) return n("rescue", "Call", `Get a working email for ${who ?? co}`, `${who ?? "They"} couldn't find the line card last time. Confirm the email address, then send it again while you have them.${task}`, plus(a.cardSentAt, RESCUE_AFTER_DAYS), true);
    return n("rescue", "Call", who ? `Get the line card in front of ${who}` : "Get the line card seen",
      `No one has opened the line card (sent ${short(a.cardSentAt)}). The rescue email is ready. Call from Close, and once you have the buyer on the phone, hit Send now in the Chrome extension so it lands at the top of their inbox (or spam).${task}`,
      plus(a.cardSentAt, RESCUE_AFTER_DAYS), true);
  }
  // They have your email and promised an RFQ (Josipa, 9/26): a one-line reply in the thread beats another call.
  // It lands on top of their inbox and they can answer with the file. Call if the email gets nothing.
  if (a.rfqPromised && !unseen && days(a.lastOut) >= 1 && (due || days(a.lastOut) >= 3)) {
    return n("bump", auto, `Get the RFQ ${who ?? "they"} promised`, `${who ?? "They"} promised an RFQ and already has your email. A one-line reply in the same thread puts it back on top of their inbox, and they can answer with the file.${due ? " Do this instead of the callback; call if the email gets nothing in 2 days." : ""}`, due?.date ?? plus(a.lastOut, 3));
  }
  if (due) return n("call_due", "Call", taskGoal(due.text, a.company ?? "", co), `Callback due today: ${taskTitle(due.text)}`, due.date);
  if (later) return n("scheduled", `Call · ${short(later.date)}`, taskGoal(later.text, a.company ?? "", co), `Next task, ${formatLocal(new Date(later.date), a.tz, true)}: ${taskTitle(later.text)}`, later.date);
  if (unseen) return n("waiting", "Wait", `Let the line card land · ${short(plus(a.cardSentAt, RESCUE_AFTER_DAYS))}`, `Sent ${short(a.cardSentAt)}. If no one opens it by ${short(plus(a.cardSentAt, RESCUE_AFTER_DAYS))}, it becomes a rescue call.`, plus(a.cardSentAt, RESCUE_AFTER_DAYS));
  if (a.seen === "replied") return n("waiting", "Wait", `In conversation with ${who ?? co}`, `They replied and you answered ${days(a.lastOut) === 0 ? "today" : `${days(a.lastOut)} days ago`}.`, null);
  const quiet = days(a.lastOut);
  if (quiet >= BUMP_AFTER_DAYS) {
    return n("bump", auto, `Get a first RFQ from ${who ?? co}`, `They've seen it, no RFQ yet, and it's been ${quiet} days since your last email. Bump the same thread.`, plus(a.lastOut, BUMP_AFTER_DAYS));
  }
  const on = short(plus(a.lastOut, BUMP_AFTER_DAYS));
  if (a.rfqPromised) {
    const ask = short(plus(a.lastOut, 3));
    return n("waiting", "Wait", `${who ?? "They"} owes an RFQ · email ${ask}`, `They promised an RFQ. If it hasn't come by ${ask}, a one-line email in the thread asks for it.`, plus(a.lastOut, 3));
  }
  return n("waiting", "Wait", `${who ?? "They"} has it · bump ${on}`, `They've seen it. If there's no RFQ by ${on} (a week after your last email), bump the thread.`, plus(a.lastOut, BUMP_AFTER_DAYS));
}

// ---------- the rescue call (Walt 9/26) ----------
// A short reply in the line card's thread, line card attached again, saved as a draft in Close.
// The rep calls from Close and clicks Send there once the buyer is on the phone.

export class RescueError extends Error {}

export async function prepareRescue(d: Deps, leadId: string) {
  const emails = (await d.close.leadEmails(leadId)) as Email[];
  const at = (e: Email) => e.date_sent ?? e.date_created ?? "";
  const card = emails.filter((e) => e.direction === "outgoing" && e.status === "sent" && (e.attachments ?? []).some((a) => a.filename === LINE_CARD)).sort((a, b) => at(b).localeCompare(at(a)))[0]
    ?? emails.filter((e) => e.direction === "outgoing" && e.status === "sent").sort((a, b) => at(b).localeCompare(at(a)))[0];
  if (!card) throw new RescueError("There's no email on this account to resend.");
  const to = card.to?.[0];
  if (!to) throw new RescueError("Can't tell who the line card went to.");
  // Greet by the contact's name in Close when we have it (Krystal, not "Hi there"), else the To name, else the address.
  const lead = await d.close.lead(leadId).catch(() => null);
  const contact = lead?.contacts.find((c) => c.emails.some((e) => e.email.toLowerCase() === addr(to).toLowerCase()));
  const named = [contact?.name, personName(to)].find((n) => n && !/main|office|purchasing|front desk|reception/i.test(n))?.split(/\s+/)[0];
  const greet = named ?? nameFromEmail(addr(to));
  // A short bump in the line card's thread, no attachment: the card is in the email right under it (Walt 9/26).
  const body = bumpBody(greet, d.rep.name);
  const attachments: Awaited<ReturnType<typeof lineCardAttachments>> = [];
  const subject = /^re:/i.test(card.subject ?? "") ? card.subject! : `Re: ${card.subject ?? "Westgate Supply – line card"}`;
  const draft = await d.close.createDraftEmail(leadId, {
    contactId: card.contact_id ?? null, to: [to], subject, body, attachments,
    sender: d.rep.sender ?? null, emailAccountId: d.rep.emailAccountId ?? null, inReplyToId: card.id, threadId: card.thread_id ?? null,
  });
  return { draftId: draft.id, to, subject, body, attachedLineCard: attachments.length > 0 };
}


/** After the rescue call: did they find it? Written to Close as a note, which the accounts page reads back. */
export async function markRescue(d: Deps, leadId: string, found: boolean, name: string | null) {
  const when = new Date(d.now?.() ?? new Date()).toLocaleDateString("en-US", { timeZone: d.rep.timeZone, month: "numeric", day: "numeric" });
  const who = name || "They";
  const note = found
    ? `${FOUND_TAG} ${who} found the line card email on the rescue call ${when} and moved it out of spam. OK to send RFQ check-ins.`
    : `${NOT_FOUND_TAG} ${who} couldn't find the line card email on the rescue call ${when}. Check the email address.`;
  await d.close.createNote(leadId, note, false);
  for (const k of boardCache.keys()) if (k.startsWith(`${d.rep.closeUserId}:`)) boardCache.delete(k);
  return { ok: true, note };
}

/** An automatic bump is already on its way: say when, instead of asking the rep to bump. */
function scheduledBump(autos: Automation[] | undefined, tz: string, who: string | null): Account["next"] | null {
  const a = (autos ?? []).find((x) => x.status === "scheduled");
  if (!a?.scheduledFor) return null;
  const when = formatLocal(new Date(a.scheduledFor), tz, true);
  return { kind: "waiting", tag: `Email · auto ${when}`, label: /promised/.test(a.label) ? `Get the RFQ ${who ?? "they"} promised` : /quote/i.test(a.label) ? "Hear back on the quote" : `Get a first RFQ from ${who ?? "them"}`, detail: `An automatic email is scheduled for ${when} (your time). Why: ${a.reason} Skip it on the Automatic emails page if you'd rather not.`, due: a.scheduledFor, rescue: false };
}

// ---------- rescue drafts, made ahead of time (Walt 9/26) ----------
// Every account whose line card nobody opened gets its rescue email drafted in Close, so the rep can
// call from Close and click Send there once the buyer is on the phone. One draft per account.

async function rescueDrafts(d: Deps): Promise<Record<string, string>> {
  return (await store.getSetting<Record<string, string>>(d.rep.closeUserId, "rescueDrafts").catch(() => null)) ?? {};
}

const drafting = new Set<string>(); // one run per rep at a time, so two page loads can't draft the same email twice

export async function ensureRescueDrafts(d: Deps, max = 25) {
  if (drafting.has(d.rep.closeUserId)) return { made: 0 };
  drafting.add(d.rep.closeUserId);
  try {
    return await draftMissing(d, max);
  } finally {
    drafting.delete(d.rep.closeUserId);
  }
}

async function draftMissing(d: Deps, max: number) {
  const board = await accountsBoard(d);
  const drafts = await rescueDrafts(d);
  let made = 0;
  for (const a of board.accounts.filter((x) => x.next.rescue)) {
    if (made >= max) break;
    const existing = drafts[a.leadId];
    if (existing) {
      const e = await d.close.email(existing).catch(() => null);
      if (e && e.lead_id === a.leadId && e.status === "draft") continue; // still there, ready
      if (e && e.status !== "draft") continue; // sent: the board will see it as a resend
    }
    try {
      const r = await prepareRescue(d, a.leadId);
      drafts[a.leadId] = r.draftId;
      await store.putSetting(d.rep.closeUserId, "rescueDrafts", drafts); // saved as we go: never drafted twice
      made++;
    } catch (err) {
      console.error(`rescue draft ${a.company}:`, (err as Error).message);
    }
  }
  if (made) {
    for (const k of boardCache.keys()) if (k.startsWith(`${d.rep.closeUserId}:`)) boardCache.delete(k);
  }
  return { made };
}

// ---------- the rescue email in the side panel, during the call (Walt 9/26) ----------

/** The account's rescue draft, if one is waiting: shown on the call screen with a Send button. */
export async function rescueFor(d: Deps, leadId: string) {
  const id = (await rescueDrafts(d))[leadId];
  if (!id) return { draft: null };
  const e = await d.close.email(id).catch(() => null);
  if (!e || e.lead_id !== leadId || e.status !== "draft") return { draft: null };
  return { draft: { id, to: e.to[0] ?? null, subject: e.subject, body: e.body_text ?? "" } };
}

/** Send it: only that draft, only if it's still a draft, only on this rep's lead. One click, once. */
export async function sendRescue(d: Deps, leadId: string, draftId: string) {
  const e = await d.close.email(draftId).catch(() => null);
  if (!e || e.lead_id !== leadId || e.user_id !== d.rep.closeUserId) throw new RescueError("Can't find that draft anymore. Send it from Close.");
  if (e.status !== "draft") throw new RescueError("That email isn't a draft anymore (it may already be sent).");
  await d.close.sendDraft(draftId);
  for (const k of boardCache.keys()) if (k.startsWith(`${d.rep.closeUserId}:`)) boardCache.delete(k);
  return { sent: true, to: e.to[0] ?? null };
}
