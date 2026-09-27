import { classifyOpen, RFQ_ASKED_TAG, RFQ_TAG, type Deps } from "./assistant.js";
import type { CloseCall } from "./close.js";
import { transcriptText } from "./close.js";
import { callSummaries, tappedOutcomes } from "./queue.js";
import { store } from "./store.js";
import { localParts, zonedTime } from "./rules.js";

// Daily stats for the panel's strip, breakdown, and week view. Everything is
// counted from Close (calls, emails, notes, tasks) plus the rep's one-tap
// outcomes, so a refresh always converges on Close's numbers.

const LINE_CARD = "Westgate_Supply_Line_Card.pdf";
const VM_GREETING = /leave (a|your) message|after the (tone|beep)|mailbox/i;
const REACHED = new Set(["reached_buyer", "got_name"]);
const DAY_MS = 24 * 3600 * 1000;

export type DayStats = {
  day: string; // YYYY-MM-DD in the rep's time zone
  since: string; // the rep's local midnight, UTC
  dials: number;
  companies: number;
  reached: number;
  voicemails: number;
  emailsSent: number;
  lineCards: number;
  rfqs: number; // leads that promised an RFQ today
  rfqAsked: number; // leads we asked for a benchmark RFQ/PO today
  rfqReceived: number; // leads we'd asked or that promised (last 30 days) whose RFQ came in today
  tasks: number;
  best: { leadId: string; company: string; seconds: number } | null;
  pace: { onPaceFor: number; perHour: number } | null;
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
const hasRealAttachment = (a: unknown) => realAttachments(a).length > 0;

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
      fields: "id,user_id,lead_id,status,direction,date_sent,date_created,date_updated,attachments",
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

  // Best call: the longest reached call with a positive outcome (a real conversation or a tapped Reached/Got a name).
  const top = [...reached].sort((a, b) => b.duration - a.duration)[0];
  const best = top
    ? { leadId: top.lead_id, seconds: top.duration, company: (await d.close.lead(top.lead_id).catch(() => null))?.display_name ?? "A lead" }
    : null;

  // Pace: dials per hour since the first dial, carried to 5 PM local.
  let pace: DayStats["pace"] = null;
  if (calls.length) {
    const first = Math.min(...calls.map((c) => new Date(c.date_created).getTime()));
    const hoursIn = Math.max((now.getTime() - first) / 3600e3, 0.25);
    const p = localParts(now, tz);
    const hoursLeft = Math.max((zonedTime(p.year, p.month, p.day, 17, 0, tz).getTime() - now.getTime()) / 3600e3, 0);
    const perHour = calls.length / hoursIn;
    pace = { perHour: Math.round(perHour * 10) / 10, onPaceFor: Math.round(calls.length + perHour * hoursLeft) };
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
  emailsSent: number; lineCards: number; rfqs: number; rfqAsked: number; rfqReceived: number;
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
  rfqNotes: Array<Record<string, unknown>>;
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
  const value: PeriodStats = {
    period, since: since.toISOString(),
    dials: calls.length,
    companies: new Set(calls.map((c) => c.lead_id)).size,
    reached: calls.filter((c) => isReached(c, tapped)).length,
    voicemails: calls.filter((c) => isVoicemail(c, tapped)).length,
    emailsSent: sent.length,
    // Accounts, not emails: a resend to a fixed address doesn't count twice.
    lineCards: new Set(lineCardMails.map((e) => e.lead_id)).size,
    replied: new Set(replyMails.map((e) => e.lead_id)).size,
    rfqs: tagged(RFQ_TAG, true).size,
    rfqAsked: tagged(RFQ_ASKED_TAG, true).size,
    rfqReceived: new Set(rfqInMails.map((e) => e.lead_id)).size,
  };
  const data = { value, calls, tapped, lineCardMails, replyMails, rfqInMails, rfqNotes, notes };
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
    const names = await leadNames(d, mails.map((e) => String(e.lead_id)));
    return { metric, columns: ["When", "Account", "From", "Files"], rows: mails.map((e) => ({ leadId: String(e.lead_id), cells: [when(e.date_created), names.get(String(e.lead_id)) ?? "", person(e.sender), realAttachments(e.attachments).join(", ")] })) };
  }
  const notes = [...data.rfqNotes].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
  const names = await leadNames(d, notes.map((n) => String(n.lead_id)));
  return { metric, columns: ["When", "Account", "What was said"], rows: notes.map((n) => ({ leadId: String(n.lead_id), cells: [when(n.date_created), names.get(String(n.lead_id)) ?? "", one(n.note, 140)] })) };
}
