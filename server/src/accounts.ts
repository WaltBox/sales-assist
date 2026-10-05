import { classifyOpen, lineCardAttachments, RFQ_IN_TAG, RFQ_TAG, taskTitle, type Deps } from "./assistant.js";
import { greetName } from "./followup.js";
import { bumpBody, nameFromEmail } from "./linecard.js";
import { bumpHtml, memeFor, rememberMeme, type Meme } from "./memes.js";
import { stripDashes } from "./benchmark.js";
import type { CloseCall, CloseLead, LeadEmail } from "./close.js";
import { businessDaysAt, businessDaysBetween, formatLocal, isOutStatus, localParts } from "./rules.js";
import { store, type Automation } from "./store.js";
import { realAttachments, theirFiles } from "./stats.js";

// The accounts page (Walt 9/26): one row per account we've sent the line card
// to: where it stands, everything that's happened since, and what to do next.
// The next step comes from the calls and notes too, not just the emails
// ("Michael said no RFQs right now, check in Oct 15" means hold, not bump).
// Everything is read from Close; nothing is stored.

const LINE_CARD = "Westgate_Supply_Line_Card.pdf";
const DAY = 24 * 3600 * 1000;
/**
 * Walt 9/26: bump every thread until they send an RFQ. Walt 10/5: the gaps count business days, not calendar
 * days (a Friday email isn't followed up on Monday as if three days had passed). A business week by default;
 * an account in the follow-up test uses its own cadence (3, 5 or 7 business days) instead.
 */
export const BUMP_AFTER_BUSINESS_DAYS = 5;
/** Not opened by a person after this many business days: rescue it (call, send it again while they're on the phone). */
export const RESCUE_AFTER_DAYS = 2; // never the day right after a touch (Walt 9/30)
/** Business days after a quote goes out, or after the last email to someone who promised an RFQ, before asking again. */
export const ASK_AGAIN_BUSINESS_DAYS = 3;
/**
 * Walt 9/28: once you've talked to them or emailed them, a rescue account drops off the list for this long,
 * then comes back if they still haven't opened the line card or sent an RFQ.
 */
export const HOLD_AFTER_TOUCH_DAYS = 7;

export type Seen = "bounced" | "replied" | "confirmed" | "opened" | "maybe" | "not_opened";
export type NextKind = "reply" | "quote" | "call_due" | "rescue" | "bump" | "scheduled" | "waiting";
/** The board's sections, in the order to work them (Walt 9/29: "how should we prioritize these"). */
export type Section = "rfq" | "answer" | "callback" | "hot" | "seen" | "followup" | "today" | "rest" | "later";
export const SECTION_ORDER: Section[] = ["answer", "callback", "hot", "seen", "followup", "today", "rest", "later", "rfq"];

// Once they send an RFQ it's off the rep's action list and onto the RFQs page (Walt 9/29): where it stands and
// who it's waiting on. Worked out from the emails, unless a newer "[RFQ status]" note in Close says otherwise.
export const RFQ_STATUS_TAG = "[RFQ status]";
export const RFQ_STAGES = ["With pricing", "Quote sent", "Buyer answered", "Order in", "Won", "Lost"] as const;
export type RfqStage = (typeof RFQ_STAGES)[number];
export type RfqStatus = { stage: RfqStage; waitingOn: "westgate" | "buyer" | "you" | "nobody"; since: string; note: string | null; manual: boolean };
const WAITING_ON: Record<RfqStage, RfqStatus["waitingOn"]> = {
  "With pricing": "westgate", "Quote sent": "buyer", "Buyer answered": "you", "Order in": "westgate", Won: "nobody", Lost: "nobody",
};
export const isPurchaseOrder = (files: string[]) => files.some((f) => /purchase.?order|\bP\.?O\.?\s*#?\d/i.test(f));

/** An RFQ typed or pasted into the email itself (Josipa 9/25: "Item Description Ordered WELDNUT OFFSET 1/4-20…"). */
export function rfqInBody(subject: string | null | undefined, body: string | null | undefined): boolean {
  const own = (body ?? "").split(/\n\s*On .{5,120}wrote:|\n-{2,}\s*Original Message|\nFrom: .+\n(Sent|Date): /i)[0];
  // The subject counts on a new email ("RFQ 26-0100"), not a reply to one ("RE: 26-407 Equipment, RFQ" was a thank-you).
  // In their words it has to be an ask, not a mention ("I'll reach out when we have a materials list or RFQ", Metal Rise).
  const askBody = /\b(please (quote|price)|can you (please )?(also )?(quote|price)|could you (please )?(quote|price)|quote the following|price the following|pricing (on|for) the following|request for (a )?quote|quote request|(rfq|materials? list|bom) (is )?attached|attached (is|are) (our|the|an?) (rfq|materials? list|bom))\b/i;
  const askSubject = /\b(rfq|request for (a )?quote|quote request)\b/i;
  if (askBody.test(own) || (!/^\s*(re|aw|sv|fw|fwd)\s*:/i.test(subject ?? "") && askSubject.test(subject ?? ""))) return true;
  return /\b(item|part)(\s*#|\s+no\.?)?\b[\s\S]{0,60}\bdescription\b/i.test(own) && /\b(qty|quantity|ordered|each|ea)\b/i.test(own);
}

export function rfqStatus(rfq: { at: string; files: string[]; quotedAt: string | null }, lastIn: string | null, marks: Array<{ note: string; date_created: string }>, handoff: { at: string; who: string } | null = null): RfqStatus {
  const auto: RfqStatus = isPurchaseOrder(rfq.files) ? { stage: "Order in", waitingOn: "westgate", since: rfq.at, note: null, manual: false }
    : !rfq.quotedAt && handoff ? { stage: "With pricing", waitingOn: "westgate", since: handoff.at, note: `${handoff.who} has it`, manual: false }
    : !rfq.quotedAt ? { stage: "With pricing", waitingOn: "westgate", since: rfq.at, note: null, manual: false }
      : lastIn && lastIn > rfq.quotedAt ? { stage: "Buyer answered", waitingOn: "you", since: lastIn, note: null, manual: false }
        : { stage: "Quote sent", waitingOn: "buyer", since: rfq.quotedAt, note: null, manual: false };
  // The rep's own update wins while it's the newest thing that happened.
  const newestEmail = [rfq.at, rfq.quotedAt, lastIn].filter((t): t is string => !!t).sort().pop()!;
  const mark = marks.filter((n) => n.note.includes(RFQ_STATUS_TAG) && n.date_created >= rfq.at).sort((a, b) => a.date_created.localeCompare(b.date_created)).pop();
  if (!mark || mark.date_created < newestEmail) return auto;
  const text = mark.note.slice(mark.note.indexOf(RFQ_STATUS_TAG) + RFQ_STATUS_TAG.length).trim();
  const stage = RFQ_STAGES.find((st) => text.toLowerCase().startsWith(st.toLowerCase()));
  if (!stage) return auto;
  const note = text.slice(stage.length).replace(/^\s*[·:\-–]\s*/, "").trim() || null;
  return { stage, waitingOn: WAITING_ON[stage], since: mark.date_created, note, manual: true };
}

/** "RFQ came in" from the side panel: out of the calls and automatic emails, onto the RFQs page. */
export async function markRfqReceived(d: Deps, leadId: string, what: string | null) {
  const nowIso = new Date(d.now?.() ?? new Date()).toISOString();
  const already = (await d.close.notes(leadId, 20).catch(() => [])).some((n) => n.note.includes(RFQ_IN_TAG) && Date.parse(nowIso) - Date.parse(n.date_created) < 12 * 3600e3);
  const note = `${RFQ_IN_TAG} ${what?.trim() || "Came in outside Close"}`;
  if (!already) await d.close.createNote(leadId, note, false);
  await advanceStatus(d, leadId, "RFQ Received").catch(() => null);
  // The calls chasing the RFQ are done (due this week); long-range check-ins stay.
  const weekOut = new Date(Date.parse(nowIso) + 7 * DAY).toISOString();
  let completed = 0;
  for (const t of (await d.close.openTasksFor(d.rep.closeUserId).catch(() => [])).filter((t) => t.lead_id === leadId && t.date <= weekOut)) { await d.close.completeTask(t.id); completed++; }
  for (const k of boardCache.keys()) if (k.startsWith(`${d.rep.closeUserId}:`)) boardCache.delete(k);
  return { ok: true, note, saved: !already, completedTasks: completed };
}

// ---------- shot down (Walt 10/5) ----------
// They said no. One tap in the side panel: the lead goes to Not Interested in Close with a note, its open
// callbacks are marked done, and it's off the board and out of the automatic emails (the board reads the status).

export const NOT_INTERESTED = "Not Interested";
export const NOT_INTERESTED_TAG = "[Not interested]";
export class ShotDownError extends Error {}

const forgetLead = (d: Deps, leadId: string) => {
  leadCache.delete(leadId);
  for (const k of boardCache.keys()) if (k.startsWith(`${d.rep.closeUserId}:`)) boardCache.delete(k);
};

export async function markNotInterested(d: Deps, leadId: string, why: string | null) {
  const nowIso = new Date(d.now?.() ?? new Date()).toISOString();
  const lead = await d.close.lead(leadId);
  const prevStatus = lead.status_label ?? null;
  const target = (await d.close.leadStatuses()).find((s) => s.label.trim().toLowerCase() === NOT_INTERESTED.toLowerCase());
  if (!target) throw new ShotDownError(`Close has no "${NOT_INTERESTED}" lead status. Add it in Close (Settings → Statuses) and try again.`);
  const already = prevStatus?.trim().toLowerCase() === NOT_INTERESTED.toLowerCase();
  if (!already) await d.close.updateLeadStatus(leadId, target.id);
  const noted = (await d.close.notes(leadId, 20).catch(() => [])).some((n) => n.note.startsWith(NOT_INTERESTED_TAG) && !n.note.includes("Undone") && Date.parse(nowIso) - Date.parse(n.date_created) < 12 * 3600e3);
  const note = `${NOT_INTERESTED_TAG} ${why?.trim() || "They said no on the call."}`;
  if (!noted) await d.close.createNote(leadId, note, false);
  // No more callbacks: every open one of yours on this lead is marked done (not deleted).
  let completed = 0;
  for (const t of (await d.close.openTasksFor(d.rep.closeUserId).catch(() => [])).filter((t) => t.lead_id === leadId)) {
    await d.close.completeTask(t.id).then(() => completed++).catch((e) => console.error(`[shot down ${leadId}] task ${t.id}:`, (e as Error).message));
  }
  forgetLead(d, leadId);
  return { ok: true, status: target.label, prevStatus: already ? null : prevStatus, note, completedTasks: completed };
}

/** Tapped by mistake: the status goes back to what it was. The callbacks it cleared stay done; set a new one. */
export async function undoNotInterested(d: Deps, leadId: string, prevStatus: string | null) {
  const lead = await d.close.lead(leadId);
  const back = prevStatus ? (await d.close.leadStatuses()).find((s) => s.label === prevStatus) : undefined;
  if (!back) throw new ShotDownError("Couldn't tell which status to put it back to. Set it in Close.");
  if (lead.status_label?.trim().toLowerCase() !== NOT_INTERESTED.toLowerCase()) throw new ShotDownError(`It's already ${lead.status_label ?? "changed"} in Close.`);
  await d.close.updateLeadStatus(leadId, back.id);
  await d.close.createNote(leadId, `${NOT_INTERESTED_TAG} Undone: marked by mistake. Status back to ${back.label}.`, false);
  forgetLead(d, leadId);
  return { ok: true, status: back.label };
}

export async function setRfqStatus(d: Deps, leadId: string, stage: RfqStage, note: string | null) {
  const text = `${RFQ_STATUS_TAG} ${stage}${note ? ` · ${note}` : ""}`;
  await d.close.createNote(leadId, text, false);
  for (const k of boardCache.keys()) if (k.startsWith(`${d.rep.closeUserId}:`)) boardCache.delete(k);
  return { ok: true, note: text };
}
/** Opened this many times by a person with no RFQ yet: interested, call now. */
export const HOT_OPENS = 3;
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
  rfq: { at: string; files: string[]; quotedAt: string | null; status: RfqStatus } | null;
  /** tag: how ("Call", "Email · auto", "Quote", "Wait"); label: the goal ("Get the line card in front of Adrian"); detail: the why. label: a few words for the table ("Call Tammy: did they find it?"); detail: the why, shown when the row is open. */
  next: { kind: NextKind; tag: string; label: string; detail: string; due: string | null; rescue: boolean };
  /** Which section of the board it sits in. */
  section: Section;
  /** You talked, left a voicemail, emailed, or marked "got it" today (rep's time): no second touch today. */
  touchedToday: string | null;
  /** A real touch on the last business day: it rests today (never two days in a row). */
  touchedLastDay?: string | null;
  /** The lead's status in Close. */
  status: string | null;
  /** Callbacks set before they replied or confirmed: marked done in Close in the background. */
  staleTaskIds?: string[];
  /** Every touch so far (Walt 9/29: "how many times I've called, how many times we've talked"). */
  touches: { dials: number; talked: number; voicemails: number; noAnswer: number; emailsOut: number; emailsIn: number; firstTouch: string | null; lastTalk: string | null };
  events: Event[];
};

/** Money first, then people waiting on you, then promised times, then the hottest calls, then chasing. */
export function sectionOf(a: Pick<Account, "next" | "seen" | "opens" | "rfq"> & { touchedToday?: string | null; touchedLastDay?: string | null }): Section {
  const k = a.next.kind;
  if (a.rfq) return "rfq";
  // Already reached out today: don't be annoying, it comes back tomorrow (Walt 9/29). Their reply still needs an answer.
  if (a.touchedToday && k !== "reply") return "today";
  // Reached or emailed them on the last business day: give them a day, not two days in a row (Walt 9/30).
  if (a.touchedLastDay && k !== "reply") return "rest";
  if (k === "reply") return "answer";
  if (k === "call_due") return "callback";
  if (k === "rescue") return "seen";
  // A callback you set for later (Steel West, Oct 15) wins: they asked for that time.
  if (a.seen === "opened" && a.opens.person >= HOT_OPENS && !a.rfq && k !== "scheduled") return "hot";
  if (k === "bump") return /auto/.test(a.next.tag) ? "later" : "followup";
  return "later";
}

// ---------- lead status in Close follows the funnel (Walt 9/29) ----------
// Potential → Good lead → Called → Qualified → Sent Line Card → RFQ Received → Quoted, forward only. Any other
// status (Customer, Vendor, Bad Fit, Not Interested…) is the rep's call and is never touched.
export const FUNNEL = ["Potential", "Good lead", "Called", "Qualified", "Sent Line Card", "RFQ Received", "Quoted"] as const;
export type FunnelStatus = (typeof FUNNEL)[number];

export function funnelStatusFor(a: Pick<Account, "rfq">): FunnelStatus {
  if (!a.rfq) return "Sent Line Card";
  return ["Quote sent", "Buyer answered"].includes(a.rfq.status.stage) ? "Quoted" : "RFQ Received";
}

/** Move a lead forward to `want`, if it's still earlier in the funnel. Returns the new label, or null if unchanged. */
export async function advanceStatus(d: Deps, leadId: string, want: FunnelStatus, current?: string | null): Promise<string | null> {
  const cur = current ?? (await d.close.lead(leadId).catch(() => null))?.status_label ?? null;
  const at = FUNNEL.indexOf(cur as FunnelStatus);
  if (!cur || at < 0 || FUNNEL.indexOf(want) <= at) return null;
  const id = (await d.close.leadStatuses()).find((s) => s.label === want)?.id;
  if (!id) return null;
  await d.close.updateLeadStatus(leadId, id);
  return want;
}

/** Bring every account on the board up to date (from the board load, at most every 10 minutes, and the daily cron). */
const statusSyncedAt = new Map<string, number>();
export async function syncStatuses(d: Deps, accounts: Account[], force = false) {
  const last = statusSyncedAt.get(d.rep.closeUserId) ?? 0;
  if (!force && Date.now() - last < 10 * 60_000) return { updated: 0, skipped: true };
  statusSyncedAt.set(d.rep.closeUserId, Date.now());
  let updated = 0;
  for (const a of accounts) {
    const want = funnelStatusFor(a), at = FUNNEL.indexOf(a.status as FunnelStatus);
    if (at < 0 || FUNNEL.indexOf(want) <= at) continue; // nothing to do, going by the (cached) status
    // Re-read it from Close first: the rep may have just set Qualified or Customer by hand.
    const done = await advanceStatus(d, a.leadId, want).catch((e) => { console.error(`[status ${a.leadId}]`, (e as Error).message); return null; });
    if (done) { a.status = done; updated++; }
  }
  if (updated) console.info(`${new Date().toISOString()} [status] moved ${updated} lead${updated === 1 ? "" : "s"} forward in the funnel`);
  return { updated, skipped: false };
}

/** Mark done (not delete) the callbacks a reply or a "got it" made moot, once each. */
const clearedTasks = new Set<string>();
export async function clearStaleCallbacks(d: Deps, accounts: Account[]) {
  let n = 0;
  for (const a of accounts) {
    if (a.section === "rfq") continue;
    for (const id of a.staleTaskIds ?? []) {
      if (clearedTasks.has(id)) continue;
      clearedTasks.add(id);
      await d.close.completeTask(id).then(() => n++).catch((e) => { clearedTasks.delete(id); console.error(`[stale callback ${id}]`, (e as Error).message); });
    }
  }
  if (n) console.info(`${new Date().toISOString()} [tasks] marked ${n} callback${n === 1 ? "" : "s"} done: they'd already replied or said they have it`);
  return n;
}

/** The rep's own test leads ("Test Lead Fabrication", a westgatesupply.com contact) never show on the board. */
export const isOwnLead = (a: Pick<Account, "company" | "contact">) =>
  /^test lead\b/i.test(a.company) || /@westgatesupply\.com$/i.test(a.contact.email ?? "");

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
  const [all, notes, tasks, calls, autos, drafts, autoOn, arms] = await Promise.all([
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
    // The follow-up test (10/2): the account's own gap between automatic emails, once it's been dealt one.
    store.getSetting<Record<string, number>>(d.rep.closeUserId, "cadenceArms").then((v) => v ?? {}).catch(() => ({} as Record<string, number>)),
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
  // The bulk list has no email text, so fetch it for the few that need reading: bounce notices (which address
  // bounced), and their replies with no file (an RFQ typed into the email, Josipa 9/25).
  const bounceIds = new Set(all.filter((e) => ids.includes(e.lead_id) && e.direction === "incoming"
    && (isBounce(e) || (!ours(e.sender) && !theirFiles(e.attachments).length))).map((e) => e.id));
  const bounceBodies = new Map<string, string>();
  await Promise.all([...new Set(all.filter((e) => bounceIds.has(e.id)).map((e) => e.lead_id))].map(async (leadId) => {
    for (const e of await d.close.leadEmails(leadId).catch(() => [])) if (bounceIds.has(e.id)) bounceBodies.set(e.id, e.body_text ?? "");
  }));
  const built = ids.map((leadId) => buildAccount({
    d, now, card: latestCard.get(leadId)!, lead: leadCache.get(leadId)?.lead ?? null, ours,
    emails: all.filter((e) => e.lead_id === leadId && e.status !== "draft"),
    // Not the call screen's saved "Say" lines: they're what you said, not what happened.
    notes: notes.filter((n) => n.lead_id === leadId && !n.note.startsWith("Opener:") && !n.note.startsWith("[Said on the call]")),
    tasks: tasks.filter((t) => t.lead_id === leadId),
    calls: calls.filter((c) => c.lead_id === leadId),
    autos: autos.filter((a) => a.leadId === leadId),
    rescueDraft: drafts[leadId] ?? null,
    autoOn,
    gap: arms[leadId] ?? null,
    bounceBodies,
  }));
  // Not Interested, Bad Fit, Disqualified in Close (by hand, or Shot down in the side panel): off the board and
  // out of the automatic emails (Walt 10/5: West Coast Air Conditioning was Not Interested and still in line for
  // a rescue call). One that already sent an RFQ stays on the RFQs page.
  const accounts = built.filter((a) => !isOwnLead(a) && !(isOutStatus(a.status) && !a.rfq));
  // By section; inside one, oldest first (the longest wait), except hot: most opens first.
  const rank = (a: Account) => SECTION_ORDER.indexOf(a.section);
  accounts.sort((a, b) => rank(a) - rank(b)
    // Hot, and callbacks due today: the ones reading your email (3+ opens) first, most opens first.
    || (a.section === "hot" || a.section === "callback" ? Math.min(b.opens.person, 99) * +(b.opens.person >= HOT_OPENS) - Math.min(a.opens.person, 99) * +(a.opens.person >= HOT_OPENS) : 0)
    || (a.next.due ?? "9").localeCompare(b.next.due ?? "9") || b.cardSentAt.localeCompare(a.cardSentAt));
  const counts = { reply: 0, quote: 0, call_due: 0, rescue: 0, bump: 0, scheduled: 0, waiting: 0 };
  for (const a of accounts) counts[a.next.kind]++;
  const sections = Object.fromEntries(SECTION_ORDER.map((k) => [k, 0])) as Record<Section, number>;
  for (const a of accounts) sections[a.section]++;
  const value = { accounts, counts, sections };
  // Keep lead statuses in Close in step with the funnel, and clear callbacks they made moot by replying, in the background.
  void syncStatuses(d, accounts).catch((e) => console.error("[status sync]", (e as Error).message));
  void clearStaleCallbacks(d, accounts).catch((e) => console.error("[stale callbacks]", (e as Error).message));
  boardCache.set(key, { at: Date.now(), value });
  return value;
}

export function buildAccount(x: {
  d: Deps; now: Date; card: Email; lead: CloseLead | null; ours: (who: string | null | undefined) => boolean;
  emails: Email[]; notes: Array<{ note: string; date_created: string }>; tasks: Array<{ id?: string; text: string; date: string; date_created?: string }>; calls: CloseCall[];
  bounceBodies?: Map<string, string>;
  autos?: Automation[];
  rescueDraft?: string | null;
  autoOn?: boolean;
  /** Business days between this account's automatic emails (its cadence in the follow-up test), if it has one. */
  gap?: number | null;
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
  // "Address not found" beats "blocked": Office 365's not-found notice also says "rejected" (Three Peaks, 9/28).
  const bounceText = bounce ? (x.bounceBodies?.get(bounce.id) ?? "") : "";
  const addressGone = /wasn't found|was not found|couldn't be found|could not be found|doesn't exist|does not exist|no such user|user unknown|unknown (to )?address|recipient not found|address not found|invalid recipient|mailbox unavailable|5\.1\.1/i.test(bounceText);
  const blocked = !!bounce && !addressGone && /blocked|rejected|spam|policy/i.test(bounceText);
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
  // They wrote back, or told you they have it: the calls set before that (to confirm they got it, to reach them)
  // are done, and the automatic emails take it from here (Walt 9/30: RAM and Rock Electric "Replied" but still a call).
  const heardAt = [replies[0] ? at(replies[0]) : null, lastMark?.date_created ?? null, recent.find((n) => CONFIRMED.test(n.note))?.date_created ?? null]
    .filter((t): t is string => !!t).sort()[0] ?? null;
  const weekOut = new Date(now.getTime() + 7 * DAY).toISOString();
  const staleTasks = heardAt ? x.tasks.filter((t) => t.date <= weekOut && t.date_created && t.date_created < heardAt) : [];
  const liveTasks = x.tasks.filter((t) => !staleTasks.includes(t));
  const seen: Seen = replies.length ? "replied" : bounce ? "bounced" : confirmed ? "confirmed" : person.length ? "opened" : maybe.length ? "maybe" : "not_opened";
  const lastOut = outgoing.map(at).pop() ?? t0;
  const lastIn = replies.map(at).pop() ?? null;
  const rfqPromised = x.notes.some((n) => n.note.includes(RFQ_TAG));
  // An RFQ is an email from them with a real file; a quote is ours back with a file or "quote"/"pricing" in the subject.
  const windowStart = new Date(new Date(t0).getTime() - 3 * DAY).toISOString();
  const rfqMail = x.emails.filter((e) => e.direction === "incoming" && at(e) >= windowStart && !x.ours(e.sender) && !isBounce(e)
    && (theirFiles(e.attachments).length || rfqInBody(e.subject, x.bounceBodies?.get(e.id) ?? e.body_text)))
    .sort((a, b) => at(b).localeCompare(at(a)))[0];
  const quoteMail = rfqMail && x.emails.filter((e) => e.direction === "outgoing" && at(e) > at(rfqMail)
    && (realAttachments(e.attachments).some((f) => f !== LINE_CARD) || /\b(quote|quotation|pricing|proposal)\b/i.test(e.subject ?? "")))
    .sort((a, b) => at(a).localeCompare(at(b)))[0];
  const rfqFiles = rfqMail ? theirFiles(rfqMail.attachments) : [];
  // Or marked by the rep with "RFQ came in" when it arrived outside Close.
  const rfqMark = x.notes.filter((n) => n.note.includes(RFQ_IN_TAG)).sort((a, b) => a.date_created.localeCompare(b.date_created)).pop();
  const markText = rfqMark ? rfqMark.note.slice(rfqMark.note.indexOf(RFQ_IN_TAG) + RFQ_IN_TAG.length).trim() : "";
  const rfqBase = rfqMail ? { at: at(rfqMail), files: rfqFiles.length ? rfqFiles : ["Items listed in the email"], quotedAt: quoteMail ? at(quoteMail) : null }
    : rfqMark ? { at: rfqMark.date_created, files: [markText || "Came in outside Close"], quotedAt: x.emails.filter((e) => e.direction === "outgoing" && at(e) > rfqMark.date_created && (realAttachments(e.attachments).some((f) => f !== LINE_CARD) || /\b(quote|quotation|pricing|proposal)\b/i.test(e.subject ?? ""))).map(at).sort()[0] ?? null }
      : null;
  // Handed to a teammate to price (Walt looped in Jacob for Josipa, 9/28): a later email of ours copying a westgatesupply.com address.
  const handoff = rfqMail && x.emails.filter((e) => e.direction === "outgoing" && at(e) > at(rfqMail))
    .map((e) => ({ at: at(e), to: (e.to ?? []).find((t) => /@westgatesupply\.com/i.test(t) && !t.toLowerCase().includes(d.rep.email.toLowerCase())) }))
    .filter((h) => h.to).pop();
  const rfq = rfqBase ? { ...rfqBase, status: rfqStatus(rfqBase, lastIn, x.notes, handoff ? { at: handoff.at, who: nameFromEmail(handoff.to!.replace(/^.*</, "").replace(/>.*$/, "")) ?? handoff.to! } : null) } : null;

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
  // A touch today, in the rep's time: a call that connected or left a voicemail, an email out, a "got it" mark.
  const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
  const today = dayOf(now.toISOString());
  const touches = [
    // Any call counts, answered or not (Walt 9/30: "I'm calling these and they aren't removing from the table").
    // A no-answer retry is set for the next business day anyway.
    ...x.calls.filter((c) => c.direction === "outbound" && (!c.user_id || c.user_id === d.rep.closeUserId)).map((c) => c.date_created),
    ...outgoing.map(at),
    ...x.notes.filter((n) => n.note.includes(FOUND_TAG)).map((n) => n.date_created),
  ].filter((t) => dayOf(t) === today).sort();
  const touchedToday = touches.pop() ?? null;
  // The last business day (Friday, on a Monday): a real touch then (someone picked up, a voicemail, an email out) rests the account today.
  const lastBiz = (() => { let t = now.getTime(); do { t -= DAY; } while ([0, 6].includes(localParts(new Date(t), tz).weekday)); return dayOf(new Date(t).toISOString()); })();
  const touchedLastDay = [
    ...x.calls.filter((c) => c.direction === "outbound" && (!c.user_id || c.user_id === d.rep.closeUserId)
      && ((c.disposition === "answered" && c.duration >= 20) || c.disposition === "vm-left" || /voicemail/i.test(c.note ?? ""))).map((c) => c.date_created),
    ...outgoing.map(at),
  ].filter((t) => dayOf(t) === lastBiz).sort().pop() ?? null;
  // The tally: your calls on this lead (a talk is a connected call over 20 seconds that wasn't a voicemail),
  // your emails out, and their emails in (not bounce notices).
  const myCalls = x.calls.filter((c) => c.direction === "outbound" && (!c.user_id || c.user_id === d.rep.closeUserId));
  const isVm = (c: CloseCall) => c.disposition === "vm-left" || c.disposition === "vm-answer" || /voicemail/i.test(c.note ?? "");
  const talkedCalls = myCalls.filter((c) => c.disposition === "answered" && c.duration >= 20 && !isVm(c));
  const vms = myCalls.filter(isVm);
  const sentMail = x.emails.filter((e) => e.direction === "outgoing" && ["sent", "outbox"].includes(e.status));
  const theirMail = x.emails.filter((e) => e.direction === "incoming" && !x.ours(e.sender) && !isBounce(e));
  const tally = {
    dials: myCalls.length, talked: talkedCalls.length, voicemails: vms.length,
    noAnswer: myCalls.length - talkedCalls.length - vms.length,
    emailsOut: sentMail.length, emailsIn: theirMail.length,
    firstTouch: [...myCalls.map((c) => c.date_created), ...sentMail.map(at)].sort()[0] ?? null,
    lastTalk: talkedCalls.map((c) => c.date_created).sort().pop() ?? null,
  };

  const acct = {
    leadId: card.lead_id, company: lead?.display_name ?? "Unknown account",
    // The name they reply under beats the contact's name in Close (10/1: jives@ is Jennifer, not "Sam Ives").
    contact: { name: (() => { const s = replies.find((e) => toAddr && addr(e.sender).toLowerCase() === toAddr.toLowerCase())?.sender?.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim(); return s && /[a-z]/i.test(s) && !s.includes("@") ? s : null; })() ?? contact?.name ?? personName(card.to?.[0]), email: toAddr || null, phone },
    cardSentAt: t0, seen, rfqPromised, rfq,
    // Only while it's still unsent: once it's sent it shows up as an email after the line card.
    rescueDraft: x.rescueDraft && !outgoing.some((e) => e.id === x.rescueDraft) ? { id: x.rescueDraft } : null,
    opens: { person: person.length, maybe: maybe.length, filter: filter.length, last: person.map((o) => o.opened_at).pop() ?? null, app: appOf(person[0]?.user_agent) },
    next: scheduledBump(x.autos, d.rep.timeZone, (contact?.name ?? personName(card.to?.[0]) ?? "").split(/\s+/)[0] || null) ?? nextStep({
      seen, cardSentAt: t0, lastOut, lastIn, lastTalk, rfqPromised, tasks: liveTasks, now, tz, company: lead?.display_name ?? "",
      who: (contact?.name ?? personName(card.to?.[0]) ?? "").split(/\s+/)[0] || null, notFound, markedAt: lastMark?.date_created ?? null, rfq, bounced: bounce ? (blocked ? "blocked" : "bounced") : null, toAddr, autoOn: x.autoOn, gap: x.gap ?? null,
    }),
    events,
    touchedToday,
    touchedLastDay,
    status: lead?.status_label ?? null,
    touches: tally,
    staleTaskIds: staleTasks.map((t) => t.id).filter((id): id is string => !!id),
  } as Omit<Account, "section">;
  return { ...acct, section: sectionOf(acct) };
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
  rfq?: { at: string; files: string[]; quotedAt: string | null } | null; bounced?: "blocked" | "bounced" | null; toAddr?: string;
  autoOn?: boolean;
  /** Business days between automatic emails for this account (its cadence in the follow-up test); a business week if not set. */
  gap?: number | null;
}): Account["next"] {
  const days = (iso: string) => Math.floor((a.now.getTime() - new Date(iso).getTime()) / DAY);
  const plus = (iso: string, n: number) => new Date(new Date(iso).getTime() + n * DAY).toISOString();
  // Business days, counted by calendar date in the rep's time zone (Walt 10/5). The morning run is at 7am: an
  // email that went out at 9:20 the Friday before is a business week old that morning, not "6.9 days".
  const biz = (iso: string) => businessDaysBetween(new Date(iso), a.now, a.tz);
  const plusBiz = (iso: string, n: number) => businessDaysAt(a.tz, new Date(iso), n, 7, 0).toISOString();
  const gap = a.gap && a.gap > 0 ? a.gap : BUMP_AFTER_BUSINESS_DAYS;
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

  // Their RFQ is in and not quoted: pricing it is the answer (VGas 9/29: Mayra's reply was the RFQ).
  if (a.rfq && !a.rfq.quotedAt) {
    return n("quote", "Quote", `Price ${whose} RFQ`, `${who ?? "They"} sent ${a.rfq.files.join(", ")} on ${short(a.rfq.at)}. Get pricing back to them. (If you already quoted from another inbox, it won't show here.)`, a.rfq.at);
  }
  if (a.lastIn && a.lastIn >= a.lastOut) return n("reply", "Email", who ? `Answer ${who}` : "Answer them", "They wrote back and haven't heard from you since. Answer them in Close.", a.lastIn);

  // It never arrived: call for an address that works (or to have their IT let westgatesupply.com through).
  if (a.bounced && !(a.lastOut > a.cardSentAt)) {
    return a.bounced === "blocked"
      ? n("rescue", "Call", `Get past ${whose} mail filter`, `Their mail server blocked the line card to ${a.toAddr ?? "them"}. Call, ask for another address, or ask them to have IT allow westgatesupply.com.`, a.cardSentAt, false)
      : n("rescue", "Call", `Get a working email for ${who ?? co}`, `The line card bounced from ${a.toAddr ?? "that address"}. Call and get the right email.`, a.cardSentAt, false);
  }
  // Quoted: following up on it. Old "nudge for the list" tasks don't apply.
  if (a.rfq?.quotedAt) {
    const since = biz(a.rfq.quotedAt);
    return since >= ASK_AGAIN_BUSINESS_DAYS
      ? n("bump", "Call or email", "Hear back on the quote", `You quoted on ${short(a.rfq.quotedAt)} and haven't heard back. Ask if they have questions or need anything adjusted.`, plusBiz(a.rfq.quotedAt, ASK_AGAIN_BUSINESS_DAYS))
      : n("waiting", "Wait", `Quote out · follow up ${short(plusBiz(a.rfq.quotedAt, ASK_AGAIN_BUSINESS_DAYS))}`, `You quoted on ${short(a.rfq.quotedAt)}. If there's no answer by ${short(plusBiz(a.rfq.quotedAt, ASK_AGAIN_BUSINESS_DAYS))}, follow up.`, plusBiz(a.rfq.quotedAt, ASK_AGAIN_BUSINESS_DAYS));
  }

  if (unseen && biz(a.cardSentAt) >= RESCUE_AFTER_DAYS) {
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
    if (a.notFound) return n("rescue", "Call", `Get a working email for ${who ?? co}`, `${who ?? "They"} couldn't find the line card last time. Confirm the email address, then send it again while you have them.${task}`, plusBiz(a.cardSentAt, RESCUE_AFTER_DAYS), true);
    return n("rescue", "Call", who ? `Get the line card in front of ${who}` : "Get the line card seen",
      `No one has opened the line card (sent ${short(a.cardSentAt)}). The rescue email is ready. Call from Close, and once you have the buyer on the phone, hit Send now in the Chrome extension so it lands at the top of their inbox (or spam).${task}`,
      plusBiz(a.cardSentAt, RESCUE_AFTER_DAYS), true);
  }
  // They have your email and promised an RFQ (Josipa, 9/26): a one-line reply in the thread beats another call.
  // It lands on top of their inbox and they can answer with the file. Call if the email gets nothing.
  if (a.rfqPromised && !unseen && days(a.lastOut) >= 1 && (due || biz(a.lastOut) >= ASK_AGAIN_BUSINESS_DAYS)) {
    return n("bump", auto, `Get the RFQ ${who ?? "they"} promised`, `${who ?? "They"} promised an RFQ and already has your email. A one-line reply in the same thread puts it back on top of their inbox, and they can answer with the file.${due ? " Do this instead of the callback; call if the email gets nothing in 2 days." : ""}`, due?.date ?? plusBiz(a.lastOut, ASK_AGAIN_BUSINESS_DAYS));
  }
  if (due) return n("call_due", "Call", taskGoal(due.text, a.company ?? "", co), `Callback due today: ${taskTitle(due.text)}`, due.date);
  // They told you they have it: the automatic emails carry it, not a far-off call (Walt 9/29).
  if (later && a.seen !== "confirmed") return n("scheduled", `Call · ${short(later.date)}`, taskGoal(later.text, a.company ?? "", co), `Next task, ${formatLocal(new Date(later.date), a.tz, true)}: ${taskTitle(later.text)}`, later.date);
  if (unseen) return n("waiting", "Wait", `Let the line card land · ${short(plusBiz(a.cardSentAt, RESCUE_AFTER_DAYS))}`, `Sent ${short(a.cardSentAt)}. If no one opens it by ${short(plusBiz(a.cardSentAt, RESCUE_AFTER_DAYS))}, it becomes a rescue call.`, plusBiz(a.cardSentAt, RESCUE_AFTER_DAYS));
  // They replied and you answered: the automatic emails carry it, same as "has it" (Walt 9/30).
  const quiet = days(a.lastOut);
  if (a.seen === "replied") {
    const when = short(plusBiz(a.lastOut, gap));
    return biz(a.lastOut) >= gap
      ? n("bump", auto, `Get a first RFQ from ${who ?? co}`, `They replied and you answered ${quiet} days ago, no RFQ yet. Bump the same thread.`, plusBiz(a.lastOut, gap))
      : n("waiting", "Wait", `${who ?? co} replied · bump ${when}`, `They replied and you answered ${quiet === 0 ? "today" : `${quiet} days ago`}. If there's no RFQ by ${when}, the thread gets a bump.`, plusBiz(a.lastOut, gap));
  }
  if (biz(a.lastOut) >= gap) {
    return n("bump", auto, `Get a first RFQ from ${who ?? co}`, `They've seen it, no RFQ yet, and it's been ${quiet} days since your last email. Bump the same thread.`, plusBiz(a.lastOut, gap));
  }
  const on = short(plusBiz(a.lastOut, gap));
  if (a.rfqPromised) {
    const ask = short(plusBiz(a.lastOut, ASK_AGAIN_BUSINESS_DAYS));
    return n("waiting", "Wait", `${who ?? "They"} owes an RFQ · email ${ask}`, `They promised an RFQ. If it hasn't come by ${ask}, a one-line email in the thread asks for it.`, plusBiz(a.lastOut, ASK_AGAIN_BUSINESS_DAYS));
  }
  return n("waiting", "Wait", `${who ?? "They"} has it · bump ${on}`, `They've seen it. If there's no RFQ by ${on} (${gap} business days after your last email), bump the thread.`, plusBiz(a.lastOut, gap));
}

// ---------- the rescue call (Walt 9/26) ----------
// A short reply in the line card's thread, line card attached again, saved as a draft in Close.
// The rep calls from Close and clicks Send there once the buyer is on the phone.

export class RescueError extends Error {}

export async function prepareRescue(d: Deps, leadId: string, opts: { meme?: Meme | null } = {}) {
  const emails = (await d.close.leadEmails(leadId)) as Email[];
  const at = (e: Email) => e.date_sent ?? e.date_created ?? "";
  const card = emails.filter((e) => e.direction === "outgoing" && e.status === "sent" && (e.attachments ?? []).some((a) => a.filename === LINE_CARD)).sort((a, b) => at(b).localeCompare(at(a)))[0]
    ?? emails.filter((e) => e.direction === "outgoing" && e.status === "sent").sort((a, b) => at(b).localeCompare(at(a)))[0];
  if (!card) throw new RescueError("There's no email on this account to resend.");
  const to = card.to?.[0];
  if (!to) throw new RescueError("Can't tell who the line card went to.");
  // Greet by the contact's name in Close when we have it, else the To name; an initial ("B. Kelley") or a
  // mailbox word is not a name, so those get "Hi there" (10/1 rule, same as the automatic bumps).
  const lead = await d.close.lead(leadId).catch(() => null);
  const contact = lead?.contacts.find((c) => c.emails.some((e) => e.email.toLowerCase() === addr(to).toLowerCase()));
  const greet = greetName(contact?.name ?? null) ?? greetName(personName(to) ?? null);
  // A short bump in the line card's thread, no attachment: the card is in the email right under it (Walt 9/26).
  const body = bumpBody(greet, d.rep.name);
  // A meme, like the automatic bumps (10/2): one the company hasn't had, and remembered so they never get it twice.
  const meme = opts.meme !== undefined ? opts.meme : await memeFor(d, leadId).catch(() => null);
  const attachments: Awaited<ReturnType<typeof lineCardAttachments>> = [];
  const subject = /^re:/i.test(card.subject ?? "") ? card.subject! : `Re: ${card.subject ?? "Westgate Supply – line card"}`;
  const draft = await d.close.createDraftEmail(leadId, {
    contactId: card.contact_id ?? null, to: [to], subject, body, attachments,
    sender: d.rep.sender ?? null, emailAccountId: d.rep.emailAccountId ?? null, inReplyToId: card.id, threadId: card.thread_id ?? null,
    html: meme ? bumpHtml(body, d.rep.name, meme) : null,
  });
  if (meme) await rememberMeme(d, leadId, meme.name);
  return { draftId: draft.id, to, subject, body, attachedLineCard: attachments.length > 0, meme: meme?.name ?? null };
}


/** After the rescue call: did they find it? Written to Close as a note, which the accounts page reads back. */
export async function markRescue(d: Deps, leadId: string, found: boolean, name: string | null, where: "rescue" | "call" = "rescue") {
  const when = new Date(d.now?.() ?? new Date()).toLocaleDateString("en-US", { timeZone: d.rep.timeZone, month: "numeric", day: "numeric" });
  const who = name || "They";
  // Ticked "They got it" on the call screen (Walt 9/29): same tag, so the board and automations treat it as seen.
  const note = found && where === "call"
    ? `${FOUND_TAG} ${who} confirmed on the call ${when} that the line card email came through (not in spam). OK to send RFQ check-ins.`
    : found
    ? `${FOUND_TAG} ${who} found the line card email on the rescue call ${when} and moved it out of spam. OK to send RFQ check-ins.`
    : `${NOT_FOUND_TAG} ${who} couldn't find the line card email on the rescue call ${when}. Check the email address.`;
  // Once per day: a second tick (or two boxes on one screen) doesn't write a second note (Hefco 9/29).
  const tag = found ? FOUND_TAG : NOT_FOUND_TAG;
  const nowIso = new Date(d.now?.() ?? new Date()).toISOString();
  const today = (await d.close.notes(leadId, 20).catch(() => [])).some((n) => n.note.includes(tag) && Date.parse(nowIso) - Date.parse(n.date_created) < 12 * 3600e3);
  if (!today) await d.close.createNote(leadId, note, false);
  // They have it: the calls to get it in front of them are done, and the automatic emails take over (Walt 9/29).
  // Callbacks due in the next week are marked done in Close; a long-range check-in (Nov 12) stays.
  let completed = 0;
  if (found) {
    const weekOut = new Date(Date.parse(nowIso) + 7 * DAY).toISOString();
    const open = (await d.close.openTasksFor(d.rep.closeUserId).catch(() => [])).filter((t) => t.lead_id === leadId && t.date <= weekOut);
    for (const t of open) { await d.close.completeTask(t.id); completed++; }
  }
  for (const k of boardCache.keys()) if (k.startsWith(`${d.rep.closeUserId}:`)) boardCache.delete(k);
  return { ok: true, note, saved: !today, completedTasks: completed };
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
      // Couldn't check (a Close timeout): assume it's still there. Drafting again here is how RH Machine
      // ended up with three copies (10/2).
      if (!e) continue;
      if (e.lead_id === a.leadId && e.status === "draft") continue; // still there, ready
      if (e.status !== "draft") continue; // sent: the board will see it as a resend
    }
    // A draft may already be waiting in the thread from another run (or an earlier store): reuse it, never add one.
    const waiting = (await d.close.leadEmails(a.leadId).catch(() => null))
      ?.find((e) => e.status === "draft" && e.direction === "outgoing" && /^re:/i.test(e.subject ?? "")
        && (!(e as { user_id?: string }).user_id || (e as { user_id?: string }).user_id === d.rep.closeUserId));
    if (waiting) {
      drafts[a.leadId] = waiting.id;
      await store.putSetting(d.rep.closeUserId, "rescueDrafts", drafts);
      continue;
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
