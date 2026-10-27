import { background } from "./background.js";
import { classifyOpen, RFQ_ASKED_TAG, RFQ_IN_TAG, RFQ_TAG, type Deps } from "./assistant.js";
import type { CloseCall } from "./close.js";
import { transcriptText } from "./close.js";
import { callSummaries, tappedOutcomes } from "./queue.js";
import { store } from "./store.js";
import { config } from "./config.js";
import { localParts, zonedTime } from "./rules.js";

// Daily stats for the panel's strip, breakdown, and week view. Everything is
// counted from Close (calls, emails, notes, tasks) plus the rep's one-tap
// outcomes, so a refresh always converges on Close's numbers.

const LINE_CARD = "Westgate_Supply_Line_Card.pdf";
const VM_GREETING = /leave (a|your) message|after the (tone|beep)|mailbox/i;
const REACHED = new Set(["reached_buyer", "got_name"]);
const DAY_MS = 24 * 3600 * 1000;

/**
 * Line cards a person sent (West Game, 10/26): every email with the line card on it, replies included, except the ones
 * the automatic sequence sent, which are recorded by their Close email id. Counted by company, so a resend to a
 * corrected address doesn't count twice. (Counting attachments alone gave Walt 57 on a day he sent none by hand.)
 */
async function handLineCardLeads(lineCardMails: Array<Record<string, unknown>>, me: string, since: Date): Promise<Set<string>> {
  const rows = await store.listAutomations(me, new Date(since.getTime() - 21 * DAY_MS).toISOString()).catch(() => []);
  const automatic = new Set(rows.map((r) => r.id));
  return new Set(lineCardMails.filter((e) => !automatic.has(String(e.id))).map((e) => String(e.lead_id)));
}

export type DayStats = {
  day: string; // YYYY-MM-DD in the rep's time zone
  since: string; // the rep's local midnight, UTC
  dials: number;
  companies: number;
  reached: number;
  voicemails: number;
  emailsSent: number;
  lineCards: number;
  /** Line cards a person sent, by company: not the automatic sequence's (West Game, 10/26). */
  newLineCards: number;
  rfqs: number; // leads that promised an RFQ today
  rfqAsked: number; // leads we asked for a benchmark RFQ/PO today
  rfqReceived: number; // leads we'd asked or that promised (last 30 days) whose RFQ came in today
  tasks: number;
  best: { leadId: string; company: string; seconds: number } | null;
  pace: { onPaceFor: number; perHour: number; until: string } | null;
  approximate: boolean; // reached/voicemails/RFQs may still move: a recent call has no transcript yet
  callIds: string[]; // counted calls, so the panel can dedupe its own increments
  syncedAt: string;
};

export type WeekDay = { day: string; label: string; dials: number; reached: number; today: boolean };

const pad = (x: number) => String(x).padStart(2, "0");

/** The rep's local calendar day containing `at`, as UTC bounds. */
export function localDay(tz: string, at: Date): { day: string; since: Date; until: Date } {
  const p = localParts(at, tz);
  const since = zonedTime(p.year, p.month, p.day, 0, 0, tz);
  // Step to tomorrow from noon so DST days (23h/25h) land on the right date.
  const n = localParts(new Date(zonedTime(p.year, p.month, p.day, 12, 0, tz).getTime() + DAY_MS), tz);
  return { day: `${p.year}-${pad(p.month)}-${pad(p.day)}`, since, until: zonedTime(n.year, n.month, n.day, 0, 0, tz) };
}

const inRange = (iso: unknown, since: Date, until: Date) =>
  typeof iso === "string" && new Date(iso) >= since && new Date(iso) < until;

const bothSpoke = (c: CloseCall) => {
  const sides = new Set((c.recording_transcript?.utterances ?? []).map((u) => u.speaker_side));
  return sides.size >= 2;
};

export function isReached(c: CloseCall, tapped: Map<string, string>) {
  // A greeting plus the rep's message looks like two speakers; the rep's Voicemail tap wins.
  if (tapped.get(c.id) === "voicemail") return false;
  return (c.duration >= 45 && bothSpoke(c)) || REACHED.has(tapped.get(c.id) ?? "");
}

export function isVoicemail(c: CloseCall, tapped: Map<string, string>) {
  return tapped.get(c.id) === "voicemail" || c.disposition === "vm-left" || c.disposition === "vm-answer"
    || VM_GREETING.test(transcriptText(c.recording_transcript) ?? "") || VM_GREETING.test(transcriptText(c.voicemail_transcript) ?? "");
}

const SIGNATURE_IMAGE = /\.(png|jpe?g|gif|bmp|svg|webp)$/i;
/** The files on an email that aren't signature logos: a spreadsheet, a PDF, a drawing. */
export function realAttachments(a: unknown): string[] {
  return ((a as Array<{ filename?: string; content_type?: string }> | undefined) ?? [])
    // Not signature logos, and not the headers a bounce notice carries (text/rfc822-headers, message/*).
    .filter((x) => !/^(image\/|text\/rfc822|message\/)/.test(x.content_type ?? "") && !SIGNATURE_IMAGE.test(x.filename ?? ""))
    .map((x) => x.filename ?? "a file");
}
/** Their files, not ours quoted back in a reply: our line card, our quote PDFs (Air Tech Cooling 9/30: Matthew's
 *  "copying the team" reply carried our line card, and it was counted as his RFQ). */
export const OUR_FILE = /^Westgate_Supply_Line_Card\.pdf$|^WG-Quote-|^Westgate_Supply_Credit_Application|^w9_westgate_supply|resale-certificate/i;
export function theirFiles(a: unknown): string[] {
  return realAttachments(a).filter((f) => !OUR_FILE.test(f));
}
const hasRealAttachment = (a: unknown) => theirFiles(a).length > 0;
/** A Westgate quote ("WG-2YT8TF_Quote.pdf"): ours, even when a customer sends it back. */
export const OUR_QUOTE = /^WG-[A-Z0-9]+.*quote/i;

async function myCalls(d: Deps, since: Date, until: Date) {
  return (await d.close.calls({ since: since.toISOString(), max: 2000 }))
    .filter((c) => c.user_id === d.rep.closeUserId && c.direction === "outbound" && inRange(c.date_created, since, until));
}

const todayCache = new Map<string, { at: number; value: DayStats }>();

export async function dayStats(d: Deps, opts: { fresh?: boolean } = {}): Promise<DayStats> {
  const now = d.now?.() ?? new Date();
  const tz = d.rep.timeZone;
  const me = d.rep.closeUserId;
  const { day, since, until } = localDay(tz, now);
  const key = `${me}:${day}`;
  const hit = todayCache.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < 30_000) return hit.value;

  const [calls, emails, notes, tasks] = await Promise.all([
    myCalls(d, since, until),
    // A draft can be sent days after it was written: look back two weeks and count by send date.
    d.close.listSince<Record<string, unknown>>("email", {
      since: new Date(since.getTime() - 14 * DAY_MS).toISOString(), userId: me, max: 2000,
      fields: "id,user_id,lead_id,status,direction,subject,date_sent,date_created,date_updated,attachments",
    }),
    // A month of the rep's notes: an RFQ that arrives today may have been promised weeks ago.
    d.close.listSince<Record<string, unknown>>("note", { since: new Date(since.getTime() - 30 * DAY_MS).toISOString(), userId: me, fields: "id,note,user_id,lead_id,date_created", max: 3000 }),
    d.close.listSince<Record<string, unknown>>("task", { since: since.toISOString(), fields: "id,created_by,date_created", max: 2000 }),
  ]);
  const tapped = await tappedOutcomes(me);

  const reached = calls.filter((c) => isReached(c, tapped));
  const sent = emails.filter((e) => e.user_id === me && e.status === "sent" && e.direction !== "incoming"
    && inRange(e.date_sent ?? e.date_updated, since, until));
  const lineCards = sent.filter((e) => ((e.attachments as Array<{ filename?: string }> | undefined) ?? []).some((a) => a.filename === LINE_CARD));
  const tagged = (tag: string, today: boolean) => new Set(notes
    .filter((n) => n.user_id === me && String(n.note ?? "").includes(tag) && (!today || inRange(n.date_created, since, until)))
    .map((n) => n.lead_id));
  const rfqLeads = tagged(RFQ_TAG, true);
  // Received (the side panel's "promised → received"): an inbound email today with a real attachment
  // (not a signature image) from a lead we asked or that promised.
  const waitingOn = new Set([...tagged(RFQ_TAG, false), ...tagged(RFQ_ASKED_TAG, false)]);
  const received = new Set(emails.filter((e) => e.direction === "incoming" && waitingOn.has(e.lead_id)
    && inRange(e.date_created, since, until) && hasRealAttachment(e.attachments)).map((e) => e.lead_id));
  for (const id of tagged(RFQ_IN_TAG, true)) received.add(id); // marked "RFQ came in" (outside Close)

  // Best call: the longest reached call with a positive outcome (a real conversation or a tapped Reached/Got a name).
  const top = [...reached].sort((a, b) => b.duration - a.duration)[0];
  const best = top
    ? { leadId: top.lead_id, seconds: top.duration, company: (await d.close.lead(top.lead_id).catch(() => null))?.display_name ?? "A lead" }
    : null;

  // Pace: dials per hour since the first dial, carried to the end of the calling day (3:30 PM local, Walt 9/29).
  let pace: DayStats["pace"] = null;
  if (calls.length) {
    const first = Math.min(...calls.map((c) => new Date(c.date_created).getTime()));
    const hoursIn = Math.max((now.getTime() - first) / 3600e3, 0.25);
    const p = localParts(now, tz);
    const [endH, endM] = config.dayEnd.split(":").map(Number);
    const hoursLeft = Math.max((zonedTime(p.year, p.month, p.day, endH, endM, tz).getTime() - now.getTime()) / 3600e3, 0);
    const perHour = calls.length / hoursIn;
    const until = `${endH % 12 || 12}${endM ? `:${String(endM).padStart(2, "0")}` : ""} ${endH < 12 ? "AM" : "PM"}`;
    pace = { perHour: Math.round(perHour * 10) / 10, onPaceFor: Math.round(calls.length + perHour * hoursLeft), until };
  }

  // Never wait on transcripts: flag the transcript-based counts as approximate
  // while any call that ended in the last 3 minutes is still missing one.
  const approximate = calls.some((c) => {
    const ended = new Date(c.date_created).getTime() + (c.duration ?? 0) * 1000;
    return now.getTime() - ended < 3 * 60_000 && !c.recording_transcript?.utterances?.length && !c.voicemail_transcript?.utterances?.length;
  });

  const value: DayStats = {
    day, since: since.toISOString(),
    dials: calls.length,
    companies: new Set(calls.map((c) => c.lead_id)).size,
    reached: reached.length,
    voicemails: calls.filter((c) => isVoicemail(c, tapped)).length,
    emailsSent: sent.length,
    lineCards: lineCards.length,
    newLineCards: (await handLineCardLeads(lineCards, me, since)).size,
    rfqs: rfqLeads.size,
    rfqAsked: tagged(RFQ_ASKED_TAG, true).size,
    rfqReceived: received.size,
    tasks: tasks.filter((t) => t.created_by === me && inRange(t.date_created, since, until)).length,
    best, pace, approximate,
    callIds: calls.map((c) => c.id),
    syncedAt: now.toISOString(),
  };
  todayCache.set(key, { at: Date.now(), value });
  return value;
}

// Finished days never change, so they're computed once.
const pastDays = new Map<string, WeekDay>();

/** Mon–Fri of the rep's current week: dials and reached per day. */
export async function weekStats(d: Deps): Promise<{ days: WeekDay[] }> {
  const now = d.now?.() ?? new Date();
  const tz = d.rep.timeZone;
  const me = d.rep.closeUserId;
  const p = localParts(now, tz);
  const mondayNoon = zonedTime(p.year, p.month, p.day - ((p.weekday + 6) % 7), 12, 0, tz);
  const days = Array.from({ length: 5 }, (_, i) => localDay(tz, new Date(mondayNoon.getTime() + i * DAY_MS)));
  const today = localDay(tz, now).day;
  const label = (x: { since: Date }) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(x.since.getTime() + 12 * 3600e3));

  const missing = days.filter((x) => x.day < today && !pastDays.has(`${me}:${x.day}`));
  if (missing.length) {
    const calls = await myCalls(d, missing[0].since, localDay(tz, now).since);
    const tapped = await tappedOutcomes(me);
    for (const x of missing) {
      const dayCalls = calls.filter((c) => inRange(c.date_created, x.since, x.until));
      pastDays.set(`${me}:${x.day}`, { day: x.day, label: label(x), dials: dayCalls.length, reached: dayCalls.filter((c) => isReached(c, tapped)).length, today: false });
    }
  }
  const t = days.some((x) => x.day === today) ? await dayStats(d) : null;
  return {
    days: days.map((x) => {
      if (x.day === today && t) return { day: x.day, label: label(x), dials: t.dials, reached: t.reached, today: true };
      return pastDays.get(`${me}:${x.day}`) ?? { day: x.day, label: label(x), dials: 0, reached: 0, today: false };
    }),
  };
}

/** Tests only. */
export function resetStatsCache() {
  todayCache.clear();
  pastDays.clear();
}

// ---------- any period: today, this week, this month, all time (Walt 9/26) ----------

export type Period = "today" | "week" | "month" | "all";
const BOUNCE = /delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem)|returned mail|message blocked|delivery (has )?failed/i;
export type PeriodStats = {
  period: Period; since: string;
  dials: number; companies: number; reached: number; voicemails: number;
  emailsSent: number; lineCards: number; newLineCards: number; rfqs: number; rfqAsked: number; rfqReceived: number;
  /** Accounts that wrote back (not bounce notices). What outreach is for. */
  replied: number;
};

/** Where a period starts, in the rep's time zone: midnight today, Monday, the 1st, or the beginning. */
export function periodStart(period: Period, tz: string, now: Date): Date {
  const p = localParts(now, tz);
  if (period === "today") return zonedTime(p.year, p.month, p.day, 0, 0, tz);
  if (period === "week") {
    const back = (p.weekday + 6) % 7; // Monday = 0
    const monday = new Date(zonedTime(p.year, p.month, p.day, 12, 0, tz).getTime() - back * DAY_MS);
    const m = localParts(monday, tz);
    return zonedTime(m.year, m.month, m.day, 0, 0, tz);
  }
  if (period === "month") return zonedTime(p.year, p.month, 1, 0, 0, tz);
  return new Date("2015-01-01T00:00:00Z");
}

/** The same counts as the daily strip, for any period. Same rules, so the numbers add up. */
type PeriodData = {
  value: PeriodStats;
  calls: CloseCall[]; tapped: Map<string, string>;
  lineCardMails: Array<Record<string, unknown>>; replyMails: Array<Record<string, unknown>>; rfqInMails: Array<Record<string, unknown>>;
  rfqNotes: Array<Record<string, unknown>>; rfqInNotes: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
};
const periodData = new Map<string, { at: number; data: PeriodData }>();

async function loadPeriod(d: Deps, period: Period, opts: { fresh?: boolean } = {}): Promise<PeriodData> {
  const now = d.now?.() ?? new Date();
  const tz = d.rep.timeZone;
  const me = d.rep.closeUserId;
  const since = periodStart(period, tz, now);
  const until = now;
  const key = `${me}:${period}:${since.toISOString()}`;
  const hit = periodData.get(key);
  const ttl = period === "today" ? 30_000 : period === "all" ? 60 * 60_000 : 5 * 60_000;
  if (hit && !opts.fresh && Date.now() - hit.at < ttl) return hit.data;

  const [calls, emails, notes] = await Promise.all([
    d.close.calls({ since: since.toISOString(), max: 5000 }).then((cs) => cs.filter((c) => c.user_id === me && c.direction === "outbound" && inRange(c.date_created, since, until))),
    d.close.listSince<Record<string, unknown>>("email", {
      since: new Date(since.getTime() - 14 * DAY_MS).toISOString(), userId: me, max: 10000,
      fields: "id,user_id,lead_id,status,direction,subject,sender,to,date_sent,date_created,date_updated,attachments,opens",
    }),
    d.close.listSince<Record<string, unknown>>("note", { since: new Date(since.getTime() - 30 * DAY_MS).toISOString(), userId: me, fields: "id,note,user_id,lead_id,date_created", max: 10000 }),
  ]);
  const tapped = await tappedOutcomes(me);
  const sent = emails.filter((e) => e.user_id === me && e.status === "sent" && e.direction !== "incoming" && inRange(e.date_sent ?? e.date_updated, since, until));
  const tagged = (tag: string, inPeriod: boolean) => new Set(notes
    .filter((n) => n.user_id === me && String(n.note ?? "").includes(tag) && (!inPeriod || inRange(n.date_created, since, until)))
    .map((n) => n.lead_id));
  const lineCardMails = sent.filter((e) => ((e.attachments as Array<{ filename?: string }> | undefined) ?? []).some((a) => a.filename === LINE_CARD));
  const replyMails = emails.filter((e) => e.direction === "incoming" && inRange(e.date_created, since, until) && !BOUNCE.test(String(e.subject ?? "")) && !/mailer-daemon|postmaster|@westgatesupply\.com/i.test(String(e.sender ?? "")));
  // RFQs in (the web page): any account that emailed a real file (a spreadsheet, PDF, drawing; not a signature
  // logo or a bounce notice), promised or not. Matt's pricing sheet wasn't tagged "promised" (9/26).
  const rfqInMails = emails.filter((e) => e.direction === "incoming" && inRange(e.date_created, since, until) && hasRealAttachment(e.attachments));
  const rfqNotes = notes.filter((n) => n.user_id === me && String(n.note ?? "").includes(RFQ_TAG) && inRange(n.date_created, since, until));
  const rfqInNotes = notes.filter((n) => n.user_id === me && String(n.note ?? "").includes(RFQ_IN_TAG) && inRange(n.date_created, since, until));
  const value: PeriodStats = {
    period, since: since.toISOString(),
    dials: calls.length,
    companies: new Set(calls.map((c) => c.lead_id)).size,
    reached: calls.filter((c) => isReached(c, tapped)).length,
    voicemails: calls.filter((c) => isVoicemail(c, tapped)).length,
    emailsSent: sent.length,
    // Accounts, not emails: a resend to a fixed address doesn't count twice.
    lineCards: new Set(lineCardMails.map((e) => e.lead_id)).size,
    newLineCards: (await handLineCardLeads(lineCardMails, me, since)).size,
    replied: new Set(replyMails.map((e) => e.lead_id)).size,
    rfqs: tagged(RFQ_TAG, true).size,
    rfqAsked: tagged(RFQ_ASKED_TAG, true).size,
    rfqReceived: new Set([...rfqInMails.map((e) => e.lead_id), ...rfqInNotes.map((n) => n.lead_id)]).size,
  };
  const data = { value, calls, tapped, lineCardMails, replyMails, rfqInMails, rfqNotes, rfqInNotes, notes };
  periodData.set(key, { at: Date.now(), data });
  return data;
}

export async function periodStats(d: Deps, period: Period, opts: { fresh?: boolean } = {}): Promise<PeriodStats> {
  return (await loadPeriod(d, period, opts)).value;
}

// ---------- click a number, see the rows behind it (Walt 9/26) ----------

export type Metric = "dials" | "reached" | "lineCards" | "replied" | "rfqs" | "rfqReceived";
export type DetailTable = { metric: Metric; columns: string[]; rows: Array<{ leadId: string; cells: string[] }> };

const outcomeCache = new Map<string, { at: number; map: Map<string, string> }>();
async function closeOutcomes(d: Deps): Promise<Map<string, string>> {
  const hit = outcomeCache.get(d.rep.closeUserId);
  if (hit && Date.now() - hit.at < 3600e3) return hit.map;
  const map = await d.close.callOutcomes().catch(() => new Map<string, string>());
  outcomeCache.set(d.rep.closeUserId, { at: Date.now(), map });
  return map;
}
const prettyPhone = (p: string | null | undefined) => { const n = (p ?? "").replace(/\D/g, "").slice(-10); return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : p ?? ""; };

/** Company names for a set of leads, remembered for a month (they rarely change). */
async function leadNames(d: Deps, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const hit = await store.cacheGet<string>(`name:${id}`).catch(() => null);
    if (hit) out.set(id, hit); else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 6) {
    await Promise.all(missing.slice(i, i + 6).map(async (id) => {
      const name = await d.close.leadName(id).catch(() => null);
      if (name) { out.set(id, name); await store.cacheSet(`name:${id}`, name, 30 * DAY_MS).catch(() => {}); }
    }));
  }
  return out;
}

export async function periodDetail(d: Deps, period: Period, metric: Metric): Promise<DetailTable> {
  const data = await loadPeriod(d, period);
  const tz = d.rep.timeZone;
  const when = (iso: unknown) => iso ? new Date(String(iso)).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const person = (s: unknown) => { const t = String(s ?? ""); return t.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? t.replace(/[<>]/g, ""); };
  const mins = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  const one = (s: unknown, n = 90) => { const t = String(s ?? "").replace(/\[RFQ (promised|asked)\]\s*/g, "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

  if (metric === "dials" || metric === "reached") {
    const calls = metric === "reached" ? data.calls.filter((c) => isReached(c, data.tapped)) : data.calls;
    const [names, outcomes, summaries] = await Promise.all([leadNames(d, calls.map((c) => c.lead_id)), closeOutcomes(d), callSummaries(d.rep.closeUserId)]);
    const time = (iso: unknown) => new Date(String(iso)).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    // The outcome you picked in Close wins ("Answered - Send Line Card"); otherwise it's read from the call.
    const outcome = (c: CloseCall) => (c.outcome_id && outcomes.get(c.outcome_id))
      || (isReached(c, data.tapped) ? "Reached" : isVoicemail(c, data.tapped) ? "Voicemail" : c.disposition === "answered" ? "Picked up" : "No answer");
    // Emails and notes belong to the last call on that lead before them (two calls three minutes apart, 9/26).
    const byLead = new Map<string, CloseCall[]>();
    for (const c of data.calls) byLead.set(c.lead_id, [...(byLead.get(c.lead_id) ?? []), c]);
    const callBefore = (leadId: string, iso: unknown) => (byLead.get(leadId) ?? [])
      .filter((c) => c.date_created <= String(iso)).sort((a, b) => b.date_created.localeCompare(a.date_created))[0];
    const followed = (c: CloseCall) => {
      const card = data.lineCardMails.find((e) => e.lead_id === c.lead_id && callBefore(c.lead_id, e.date_sent)?.id === c.id
        && new Date(String(e.date_sent)).getTime() - new Date(c.date_created).getTime() < 3 * 3600e3);
      return card ? ` · line card sent ${time(card.date_sent)}` : "";
    };
    // The note: yours on the call in Close, else what the app wrote about that call, else the note written after it.
    const noteFor = (c: CloseCall) => {
      if (c.note) return one(c.note);
      const s = summaries.get(c.id);
      if (s) return one(s);
      const n = data.notes.filter((x) => x.lead_id === c.lead_id && callBefore(c.lead_id, x.date_created)?.id === c.id
        && new Date(String(x.date_created)).getTime() - new Date(c.date_created).getTime() < 30 * 60e3)
        .sort((a, b) => String(a.date_created).localeCompare(String(b.date_created)))[0];
      return n ? one(n.note) : "";
    };
    return {
      metric, columns: ["When", "Account", "Number", "Length", "Outcome", "Note"],
      rows: calls.map((c) => ({ leadId: c.lead_id, cells: [when(c.date_created), names.get(c.lead_id) ?? "", prettyPhone(c.remote_phone), mins(c.duration ?? 0), outcome(c) + followed(c), noteFor(c)] })),
    };
  }
  if (metric === "lineCards") {
    const mails = [...data.lineCardMails].sort((a, b) => String(b.date_sent).localeCompare(String(a.date_sent)));
    const names = await leadNames(d, mails.map((e) => String(e.lead_id)));
    const seen = new Set<string>();
    return {
      metric, columns: ["Sent", "Account", "To", "Opened"],
      rows: mails.filter((e) => !seen.has(String(e.lead_id)) && seen.add(String(e.lead_id))).map((e) => {
        const opens = ((e.opens as Array<{ opened_at: string; opened_by: string | null; user_agent?: string | null }> | undefined) ?? [])
          .filter((o) => o.opened_by && !/@westgatesupply\.com$/i.test(o.opened_by));
        const kinds = opens.map((o) => classifyOpen(o, String(e.date_sent ?? "")));
        const person_ = kinds.filter((k) => k === "person").length;
        return { leadId: String(e.lead_id), cells: [when(e.date_sent), names.get(String(e.lead_id)) ?? "", ((e.to as string[] | undefined) ?? []).map(person).join(", "), person_ ? `Yes, ${person_}×` : kinds.includes("maybe") ? "Maybe" : "Not yet"] };
      }),
    };
  }
  if (metric === "replied") {
    const mails = [...data.replyMails].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
    const names = await leadNames(d, mails.map((e) => String(e.lead_id)));
    return { metric, columns: ["When", "Account", "From", "Subject"], rows: mails.map((e) => ({ leadId: String(e.lead_id), cells: [when(e.date_created), names.get(String(e.lead_id)) ?? "", person(e.sender), one(e.subject, 70)] })) };
  }
  if (metric === "rfqReceived") {
    const mails = [...data.rfqInMails].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
    const marked = data.rfqInNotes ?? [];
    const names = await leadNames(d, [...mails.map((e) => String(e.lead_id)), ...marked.map((n) => String(n.lead_id))]);
    const rows = [
      ...mails.map((e) => ({ at: String(e.date_created), leadId: String(e.lead_id), cells: [when(e.date_created), names.get(String(e.lead_id)) ?? "", person(e.sender), realAttachments(e.attachments).join(", ")] })),
      ...marked.map((n) => ({ at: String(n.date_created), leadId: String(n.lead_id), cells: [when(n.date_created), names.get(String(n.lead_id)) ?? "", "Marked by you", one(String(n.note).replace(RFQ_IN_TAG, "").trim(), 70)] })),
    ].sort((a, b) => b.at.localeCompare(a.at)).map(({ leadId, cells }) => ({ leadId, cells }));
    return { metric, columns: ["When", "Account", "From", "Files"], rows };
  }
  const notes = [...data.rfqNotes].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
  const names = await leadNames(d, notes.map((n) => String(n.lead_id)));
  return { metric, columns: ["When", "Account", "What was said"], rows: notes.map((n) => ({ leadId: String(n.lead_id), cells: [when(n.date_created), names.get(String(n.lead_id)) ?? "", one(n.note, 140)] })) };
}

// ---------- RFQs over time (Walt 9/29: "a line graph, growth over time") ----------
// Every RFQ from the funnel (leads that got a line card from this rep), one per account per day, from the
// first line card on. An RFQ is an email from them with a real file (not a W-9, a tax form, a credit app or a
// cert), an ask typed into the email ("please quote the following"), or one the rep marked "RFQ came in".

export const ADMIN_DOC = /w-?9|tax|exempt|resale|credit|application|certificate|\bcoc\b|\bmtr|invoice|statement|insurance|\bcoi\b|packing|remit/i;
const timelineCache = new Map<string, { at: number; value: RfqTimeline }>();
export type RfqTimeline = {
  since: string; total: number; thisWeek: number; lastWeek: number;
  /** Companies sending their first RFQ ever (10/8: "new RFQ today, unique suppliers"). */
  firstToday: number; firstThisWeek: number; companies: number;
  /** New companies (their first RFQ ever) by calendar week (Mon–Sun) and month (Walt 10/12: "how many new companies
   *  have I brought in this week, this month"). */
  newThisWeek: number; newLastWeek: number; newThisMonth: number; newLastMonth: number;
  days: Array<{ day: string; count: number; total: number; newCompanies: number; companiesTotal: number; accounts: Array<{ leadId: string; company: string; how: "file" | "email" | "marked"; first: boolean; marked?: boolean }> }>;
  /** When this was worked out (the page shows a saved copy at once and refreshes it behind). */
  at?: string;
};

/**
 * The RFQ line, fast (10/8: "taking an annoying amount of time to load"): the last one worked out is kept in the
 * store, so a page load (even on a cold hosted server) gets it at once; if it's over 5 minutes old a fresh one is
 * built behind it for the next load.
 */
export async function rfqTimeline(d: Deps, opts: { fresh?: boolean; savedOk?: boolean; refreshAfterMs?: number } = {}): Promise<RfqTimeline | null> {
  const key = d.rep.closeUserId;
  // A teammate's line on the team's RFQs page (10/19): whatever's saved, rebuilt behind it, never waited on.
  // The race (10/25) asks for a rebuild sooner, so an RFQ is celebrated within minutes.
  if (opts.savedOk) {
    const saved = timelineCache.get(key)?.value ?? (await store.cacheGet<RfqTimeline>(`rfqline:${key}`).catch(() => null));
    const age = saved?.at ? Date.now() - Date.parse(saved.at) : Infinity;
    if (age > (opts.refreshAfterMs ?? 10 * 60_000) && !rebuilding.has(key)) {
      rebuilding.add(key);
      background(buildRfqTimeline(d).finally(() => rebuilding.delete(key)), "teammate rfq line");
    }
    return saved ?? null;
  }
  const hit = timelineCache.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < 5 * 60_000) return hit.value;
  if (!opts.fresh) {
    const saved = hit?.value ?? (await store.cacheGet<RfqTimeline>(`rfqline:${key}`).catch(() => null));
    // A saved count is shown only if it's from today and under 10 minutes old (10/9: the page said 1 new RFQ when
    // there were 3, from a stale copy). Otherwise it's worked out now.
    const age = saved?.at ? Date.now() - new Date(saved.at).getTime() : Infinity;
    const sameDay = saved?.at ? localDay(d.rep.timeZone, new Date(saved.at)).day === localDay(d.rep.timeZone, new Date()).day : false;
    if (saved && "firstToday" in saved && sameDay && age < 10 * 60_000) {
      if (!rebuilding.has(key)) {
        rebuilding.add(key);
        background(buildRfqTimeline(d).finally(() => rebuilding.delete(key)), "rfq line");
      }
      return saved;
    }
  }
  return buildRfqTimeline(d);
}
const rebuilding = new Set<string>();

async function buildRfqTimeline(d: Deps): Promise<RfqTimeline> {
  const tz = d.rep.timeZone;
  const key = d.rep.closeUserId;
  const { isBounce, rfqInBody } = await import("./accounts.js");
  const now = d.now?.() ?? new Date();
  const window = new Date(now.getTime() - 120 * DAY_MS).toISOString();
  const [emails, notes, changes] = await Promise.all([
    d.close.listSince<Record<string, unknown>>("email", { since: window, fields: "id,lead_id,user_id,direction,status,sender,subject,date_created,attachments,body_text", max: 8000 }),
    d.close.listSince<Record<string, unknown>>("note", { since: window, userId: key, fields: "id,note,user_id,lead_id,date_created", max: 3000 }),
    d.close.statusChangesSince(window, key).catch(() => []),
  ]);
  const me = d.rep.email.toLowerCase();
  const cards = emails.filter((e) => e.direction === "outgoing" && e.user_id === key && ["sent", "outbox"].includes(String(e.status))
    && ((e.attachments as Array<{ filename?: string }> | undefined) ?? []).some((a) => a.filename === LINE_CARD));
  // Leads you've emailed (BCS 9/29: a quote, no line card), for RFQs that come in by email.
  const funnel = new Set(emails.filter((e) => e.direction === "outgoing" && e.user_id === key && ["sent", "outbox"].includes(String(e.status))).map((e) => String(e.lead_id)));
  const start = cards.map((e) => String(e.date_created)).sort()[0] ?? now.toISOString();
  const ours = (s: unknown) => /@westgatesupply\.com/i.test(String(s ?? "")) || String(s ?? "").toLowerCase().includes(me);
  const found = new Map<string, { at: string; leadId: string; how: "file" | "email" | "marked" }>(); // lead|day → first
  const add = (leadId: string, at: string, how: "file" | "email" | "marked") => {
    const k = `${leadId}|${localDay(tz, new Date(at)).day}`;
    if (!found.has(k)) found.set(k, { at, leadId, how });
  };
  // Files we sent each company. Our own quote coming back in a forwarded chain isn't their RFQ (10/26: Reagan Power's
  // "FW: FW: FW:" with WG-2YT8TF_Quote.pdf counted as a new RFQ).
  const sentFiles = new Map<string, Set<string>>();
  for (const e of emails) {
    if (e.direction === "incoming") continue;
    const set = sentFiles.get(String(e.lead_id)) ?? new Set<string>();
    for (const a of (e.attachments as Array<{ filename?: string }> | undefined) ?? []) if (a.filename) set.add(a.filename.toLowerCase());
    sentFiles.set(String(e.lead_id), set);
  }
  for (const e of emails) {
    const leadId = String(e.lead_id);
    if (e.direction !== "incoming" || !funnel.has(leadId) || String(e.date_created) < start || ours(e.sender) || isBounce(e as never)) continue;
    const files = theirFiles(e.attachments).filter((f) => !ADMIN_DOC.test(f) && !OUR_QUOTE.test(f) && !sentFiles.get(leadId)?.has(f.toLowerCase()));
    if (files.length) add(leadId, String(e.date_created), "file");
    else if (rfqInBody(e.subject as string, e.body_text as string)) add(leadId, String(e.date_created), "email");
  }
  // This rep tapped "RFQ came in" (kept apart from how it was found: the file can land first, 10/26 Haley Contracting).
  const markedKeys = new Set<string>();
  for (const n of notes) if (String(n.note ?? "").includes(RFQ_IN_TAG) && String(n.date_created) >= start) {
    add(String(n.lead_id), String(n.date_created), "marked");
    markedKeys.add(`${n.lead_id}|${localDay(tz, new Date(String(n.date_created))).day}`);
  }
  // Or you set the lead to "RFQ Received" in Close yourself (BCS 9/29: it came by phone). Only for leads with no other
  // sign of an RFQ. Quoted on its own doesn't count (10/27: Liam caught Potts Welding up to Quoted today for a quote he
  // sent last week, and scored a new RFQ for today); the RFQ before a quote is what counts, from its file, email or tap.
  const counted = new Set([...found.values()].map((f) => f.leadId));
  const statusOnly = new Set<string>(); // lead|day keys found only from a status change
  for (const c of changes) {
    if (c.date_created < start || counted.has(c.lead_id)) continue;
    if (c.new_status_label === "RFQ Received") {
      const k = `${c.lead_id}|${localDay(tz, new Date(c.date_created)).day}`;
      if (!found.has(k)) statusOnly.add(k);
      add(c.lead_id, c.date_created, "marked"); counted.add(c.lead_id);
    }
  }

  const names = await leadNames(d, [...found.values()].map((f) => f.leadId));
  // Not the rep's own test leads ("Test Lead Fabrication"), and not suppliers quoting us (Valves & Fittings of
  // Houston, a Vendor: their quote on NAVCO valves isn't a customer's RFQ).
  const statusOf = new Map<string, string>();
  const addedOf = new Map<string, string>();
  await Promise.all([...new Set([...found.values()].map((f) => f.leadId))].map(async (id) => {
    const l = await d.close.lead(id).catch(() => null);
    if (l) { statusOf.set(id, l.status_label ?? ""); addedOf.set(id, String((l as { date_created?: string }).date_created ?? "")); }
  }));
  for (const [k, f] of found) if (/^test lead\b/i.test(names.get(f.leadId) ?? "") || /vendor/i.test(statusOf.get(f.leadId) ?? "")) found.delete(k);
  // A status set by mistake and changed back: the lead isn't at RFQ Received or past it any more, so it doesn't count.
  for (const k of statusOnly) if (!/rfq|quot|won|order|customer|\bpo\b/i.test(statusOf.get(found.get(k)?.leadId ?? "") ?? "")) found.delete(k);
  // Each company's first RFQ day: that's a new customer coming in, the number Walt wants to see grow.
  const firstDay = new Map<string, string>();
  for (const f of found.values()) {
    const day = localDay(tz, new Date(f.at)).day;
    if (!firstDay.has(f.leadId) || day < firstDay.get(f.leadId)!) firstDay.set(f.leadId, day);
  }
  const byDay = new Map<string, RfqTimeline["days"][number]["accounts"]>();
  for (const f of found.values()) {
    const day = localDay(tz, new Date(f.at)).day;
    // A new company, not an established one (Walt 10/26): their first RFQ here, and in Close only since this window
    // began. A long-standing customer quiet for four months isn't a new account.
    const newToUs = (addedOf.get(f.leadId) ?? "") >= window;
    byDay.set(day, [...(byDay.get(day) ?? []), { leadId: f.leadId, company: names.get(f.leadId) ?? "An account", how: f.how, first: firstDay.get(f.leadId) === day && newToUs, marked: markedKeys.has(`${f.leadId}|${day}`) }]);
  }
  // Every day from the first line card to today, so the line shows the quiet days too.
  const days: RfqTimeline["days"] = [];
  let total = 0, companiesTotal = 0;
  const today = localDay(tz, now).day;
  for (let t = new Date(`${localDay(tz, new Date(start)).day}T12:00:00Z`); ; t = new Date(t.getTime() + DAY_MS)) {
    const day = t.toISOString().slice(0, 10);
    const accounts = byDay.get(day) ?? [];
    const newCompanies = new Set(accounts.filter((a) => a.first).map((a) => a.leadId)).size;
    total += accounts.length;
    companiesTotal += newCompanies;
    days.push({ day, count: accounts.length, total, newCompanies, companiesTotal, accounts });
    if (day >= today) break;
  }
  // Calendar weeks (Monday start) and months, in the rep's time.
  const dow = (dd: string) => (new Date(`${dd}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  const shift = (dd: string, n: number) => new Date(Date.parse(`${dd}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
  const monday = shift(today, -dow(today)), lastMonday = shift(monday, -7);
  const month = today.slice(0, 7);
  const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 15)).toISOString().slice(0, 7);
  const sumLast = (from: number, to: number) => days.slice(Math.max(0, days.length - to), days.length - from).reduce((s, x) => s + x.count, 0);
  const weekAgo = days[Math.max(0, days.length - 7)].day;
  const firsts = [...firstDay.values()];
  const value: RfqTimeline = {
    since: start, total, thisWeek: sumLast(0, 7), lastWeek: sumLast(7, 14), days,
    firstToday: firsts.filter((x) => x === today).length, firstThisWeek: firsts.filter((x) => x >= weekAgo).length, companies: firstDay.size,
    newThisWeek: firsts.filter((x) => x >= monday).length, newLastWeek: firsts.filter((x) => x >= lastMonday && x < monday).length,
    newThisMonth: firsts.filter((x) => x.startsWith(month)).length, newLastMonth: firsts.filter((x) => x.startsWith(lastMonth)).length,
    at: new Date().toISOString(),
  };
  timelineCache.set(key, { at: Date.now(), value });
  await store.cacheSet(`rfqline:${key}`, value, 3 * DAY_MS).catch(() => undefined);
  return value;
}

// ---------- the team's RFQs (10/19: a second rep; everyone sees the team's RFQs on the RFQs page) ----------

/**
 * Every rep's RFQ line merged into one. A company counts once a day however many reps worked it, its first RFQ is
 * the team's first, and each one says whose it is. Built from each rep's own line (each cached on its own).
 */
export function mergeRfqTimelines(parts: Array<{ rep: string; line: RfqTimeline }>, tz: string, now = new Date()): RfqTimeline & { reps: string[] } {
  type Entry = { leadId: string; company: string; how: "file" | "email" | "marked"; day: string; reps: string[] };
  const byKey = new Map<string, Entry>();
  for (const { rep, line } of parts) for (const dd of line.days) for (const a of dd.accounts) {
    const k = `${a.leadId}|${dd.day}`;
    const e = byKey.get(k);
    if (e) { if (!e.reps.includes(rep)) e.reps.push(rep); } else byKey.set(k, { leadId: a.leadId, company: a.company, how: a.how, day: dd.day, reps: [rep] });
  }
  const today = localDay(tz, now).day;
  const since = parts.map((p) => p.line.since).sort()[0] ?? now.toISOString();
  const firstDay = new Map<string, string>();
  for (const e of byKey.values()) if (!firstDay.has(e.leadId) || e.day < firstDay.get(e.leadId)!) firstDay.set(e.leadId, e.day);
  const byDay = new Map<string, Entry[]>();
  for (const e of byKey.values()) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const days: Array<RfqTimeline["days"][number] & { accounts: Array<RfqTimeline["days"][number]["accounts"][number] & { reps: string[] }> }> = [];
  let total = 0, companiesTotal = 0;
  for (let t = new Date(`${localDay(tz, new Date(since)).day}T12:00:00Z`); ; t = new Date(t.getTime() + DAY_MS)) {
    const day = t.toISOString().slice(0, 10);
    const accounts = (byDay.get(day) ?? []).map((e) => ({ leadId: e.leadId, company: e.company, how: e.how, first: firstDay.get(e.leadId) === day, reps: e.reps }));
    const newCompanies = new Set(accounts.filter((a) => a.first).map((a) => a.leadId)).size;
    total += accounts.length; companiesTotal += newCompanies;
    days.push({ day, count: accounts.length, total, newCompanies, companiesTotal, accounts });
    if (day >= today || days.length > 2000) break;
  }
  const dow = (dd: string) => (new Date(`${dd}T12:00:00Z`).getUTCDay() + 6) % 7;
  const shift = (dd: string, n: number) => new Date(Date.parse(`${dd}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
  const monday = shift(today, -dow(today)), lastMonday = shift(monday, -7);
  const month = today.slice(0, 7);
  const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 15)).toISOString().slice(0, 7);
  const sumLast = (from: number, to: number) => days.slice(Math.max(0, days.length - to), days.length - from).reduce((s, x) => s + x.count, 0);
  const weekAgo = days[Math.max(0, days.length - 7)].day;
  const firsts = [...firstDay.values()];
  return {
    since, total, thisWeek: sumLast(0, 7), lastWeek: sumLast(7, 14), days,
    firstToday: firsts.filter((x) => x === today).length, firstThisWeek: firsts.filter((x) => x >= weekAgo).length, companies: firstDay.size,
    newThisWeek: firsts.filter((x) => x >= monday).length, newLastWeek: firsts.filter((x) => x >= lastMonday && x < monday).length,
    newThisMonth: firsts.filter((x) => x.startsWith(month)).length, newLastMonth: firsts.filter((x) => x.startsWith(lastMonth)).length,
    at: parts.map((p) => p.line.at ?? "").sort()[0] || new Date().toISOString(),
    reps: parts.map((p) => p.rep),
  };
}
