import type { CloseCall, CloseClient, LeadEmail } from "./close.js";
import { structured } from "./claude.js";
import { background } from "./background.js";
import { store } from "./store.js";
import { config } from "./config.js";
import { loadLeadContext, renderContext, type LeadContext, type RepInfo, type RepStats } from "./context.js";
import { formatPhone, emailMatchesDomain, fillsInName, formatLocal, isBackwardsMove, isoWithOffset, localParts, samePerson, BUSINESS_START_MIN, LAST_CALL_MIN, zonedTime } from "./rules.js";
import {
  AfterCallExtrasSchema, AfterCallSchema, BriefSchema, ChatSchema, type AfterCall, type AfterCallExtras, type Brief, type Proposals,
} from "./schemas.js";
import { fetchSiteText } from "./website.js";
import { applyBenchmarkTask, benchmarkDecision, enforceBenchmark, enforceGotIt, OFFERS, stripDashes } from "./benchmark.js";
import { transcriptText } from "./close.js";
import { EmailReviewSchema, INTRO_OFFER, INTRO_SUBJECT, isSelfTest, logRejection, retryNote, reviewTask, ruleChecks, type Failure, type Referral } from "./validate.js";

export const RFQ_TAG = "[RFQ promised]";
export const RFQ_ASKED_TAG = "[RFQ asked]";

/** Tags go at the end of the call note, so the daily stats can count them from Close. */
export function tagNote(p: Pick<Proposals, "note">, tag: string, fallback: string) {
  const text = p.note?.text ?? fallback;
  if (!text.includes(tag)) p.note = { pinned: false, ...p.note, text: text.includes("\n\n[") ? `${text} ${tag}` : `${text}\n\n${tag}` };
}

export type Close = Pick<CloseClient,
  "smartViewLeads" | "me" | "lead" | "leadName" | "callOutcomes" | "leadStatuses" | "leadCustomFields" | "calls" | "call" | "notes" | "openTasks" | "task" | "openTasksFor" | "email" | "sendDraft" | "unschedule" |
  "createNote" | "createContact" | "updateContact" | "createTask" | "updateTask" | "createDraftEmail" | "updateLeadStatus" | "emailTemplateAttachments" | "listSince" | "phoneNumbers" | "leadEmails">;
export type Llm = typeof structured;
export type Deps = { close: Close; llm: Llm; rep: RepInfo; now?: () => Date; website?: typeof fetchSiteText };

const now = (d: Deps) => d.now?.() ?? new Date();

// ---------- Lead Brief ----------

export type BriefResponse = {
  header: {
    company: string; website: string | null; status: string; location: string | null; phone: string; phoneE164: string | null;
    timeZone: string | null; timeZoneId: string | null; localTime: string | null; afterHours: boolean; afterHoursReason: string | null;
    bestWindow: string | null;
    /** The rep's own outbound calls to this lead, all time (not counting one in progress). */
    myCalls: { count: number; last: string | null } | null;
    /** Opens on emails we sent this lead (not our own), and who opened most. */
    opens: EmailOpens | null;
    /** The most recent finished call on this lead, by anyone. */
    lastCall: LastCall | null;
    /** Whether to call now, per the lead's own plan in Close (its open tasks) and any reply since. */
    callPlan: CallPlan;
  };
  brief: Brief;
  flags: string[];
  cached: boolean;
};

// Briefs are cached (Supabase when hosted) so reopening a lead is instant. A
// lead's brief is dropped when the rep saves follow-ups on it, so the next open
// reflects the latest call.
const BRIEF_TTL = 7 * 24 * 3600 * 1000;
const briefKey = (d: Deps, leadId: string) => `brief:${config.briefVersion}:${d.rep.closeUserId}:${leadId}`;
const briefCache = {
  get: (key: string) => store.cacheGet<Brief>(`brief:${config.briefVersion}:${key}`),
  set: (key: string, b: Brief) => store.cacheSet(`brief:${config.briefVersion}:${key}`, b, BRIEF_TTL),
};

export async function leadBrief(d: Deps, leadId: string, opts: { refresh?: boolean } = {}): Promise<BriefResponse> {
  const key = `${d.rep.closeUserId}:${leadId}`;
  const [ctx, myCalls, emails] = await Promise.all([
    loadLeadContext(d.close as CloseClient, leadId, now(d)),
    myCallsTo(d, leadId).catch(() => null),
    d.close.leadEmails(leadId).catch(() => null),
  ]);
  const opens = emails ? await emailOpens(d, leadId, emails).catch(() => null) : null;
  const lastCall = lastCallOf(ctx, d.rep.closeUserId);
  const header = { ...briefHeader(ctx), myCalls, opens, lastCall, callPlan: callPlanOf(ctx, emails ?? [], lastCall, now(d), d.rep.timeZone) };
  // The header (local time, status, call count) is always fresh; the brief itself is cached.
  const hit = opts.refresh ? null : await briefCache.get(key).catch(() => null);
  if (hit) return { header, brief: enforceBriefRules(hit, ctx), flags: briefFlags(ctx), cached: true };

  // If the background warmer is already writing this brief, wait for it instead of paying twice.
  let job = opts.refresh ? undefined : inflight.get(key);
  if (!job) {
    job = (async () => {
      const website = await (d.website ?? fetchSiteText)(ctx.facts.website ?? ctx.facts.domain);
      const context = renderContext(ctx, d.rep, { now: now(d), website, summariesOnly: true });
      const task = "Write the Lead Brief (call card) for this lead, following the Lead Brief section of the playbook.";
      let { data } = await d.llm({ schema: BriefSchema, effort: config.effortFast, model: config.briefModel, context, task });
      // Buyers respond to hyper-specifics: an opener that names none of the products gets one rewrite.
      if (openerProducts(data.opener, data.buys) < 2) {
        ({ data } = await d.llm({
          schema: BriefSchema, effort: config.effortFast, model: config.briefModel, context,
          task: `${task}\n\nYour last opener named none of the specific products: "${data.opener}". Rewrite the card so the opener names 3–4 of the products in buys (${data.buys.join(", ")}) in one run, tied to their work.`,
        }));
      }
      await briefCache.set(key, data).catch((err) => console.error("brief cache write:", (err as Error).message));
      return data;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const data = await job;
  return { header, brief: enforceBriefRules(data, ctx), flags: briefFlags(ctx), cached: false };
}

const inflight = new Map<string, Promise<Brief>>();
const hasBrief = async (d: Deps, leadId: string) => inflight.has(`${d.rep.closeUserId}:${leadId}`) || !!(await store.cacheGet(briefKey(d, leadId)).catch(() => null));

/** How many times the rep has called this lead, all time, and when last. */
export async function myCallsTo(d: Deps, leadId: string): Promise<{ count: number; last: string | null }> {
  const calls = (await d.close.calls({ leadId, since: "2015-01-01T00:00:00Z", withTranscripts: false, max: 1000 }))
    .filter((c) => c.user_id === d.rep.closeUserId && c.direction === "outbound" && c.status !== "in-progress");
  return { count: calls.length, last: calls[0]?.date_created ?? null };
}

export type EmailOpens = {
  /** Opens by a person, from a real email app. Spam-filter scans don't count (Walt 9/26). */
  total: number;
  last: string | null;
  top: { who: string; count: number } | null;
  emails: number;
  /** Opens we can't place (a bare browser string, 5+ minutes after sending): maybe a person. */
  maybe: number;
  /** Opens that were only their spam filter scanning the email. */
  scanned: number;
  /** When we last sent them an email. */
  lastSent: string | null;
};

// A real mail app announces itself.
const REAL_CLIENT_UA = /outlook|microsoft office|ms-office|iphone|ipad|macintosh|googleimageproxy|ggpht|gmail|yahoo|thunderbird|android/i;
// Link scanners (Mimecast, Proofpoint, Barracuda…) pose as years-old browsers, and some rescan hours later:
// Windows Chrome 109 or 42, Internet Explorer 8 / Trident 4. Seen on 19 of Walt's line cards (9/26).
const FILTER_UA = /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(109|42)\.[\d.]+ Safari\/537\.36$|MSIE [5-8]\.|Trident\/4\.0/;
const SCAN_WINDOW_MS = 5 * 60 * 1000;

export type OpenKind = "person" | "maybe" | "filter";

/** Who opened it: a person in a real email app, their spam filter, or can't tell. */
export function classifyOpen(o: { opened_at: string; user_agent?: string | null }, sentAt: string | null): OpenKind {
  const ua = o.user_agent ?? "";
  if (REAL_CLIENT_UA.test(ua)) return "person";
  if (FILTER_UA.test(ua)) return "filter";
  const gap = sentAt ? new Date(o.opened_at).getTime() - new Date(sentAt).getTime() : Infinity;
  if (gap < SCAN_WINDOW_MS) return "filter"; // opened on delivery, not by a known app
  return ua ? "maybe" : "person"; // no browser string recorded: trust the open
}

export const isScannerOpen = (o: { opened_at: string; user_agent?: string | null }, sentAt: string | null) => classifyOpen(o, sentAt) === "filter";

/** Opens on the emails we sent this lead. Our own opens (westgatesupply.com, the rep) and spam-filter scans don't count. */
export async function emailOpens(d: Deps, leadId: string, emails?: LeadEmail[]): Promise<EmailOpens> {
  const ours = (who: string | null) => !who || /@westgatesupply\.com$/i.test(who) || who.toLowerCase() === d.rep.email.toLowerCase();
  const sent = (emails ?? (await d.close.leadEmails(leadId))).filter((e) => e.status === "sent" && e.direction === "outgoing");
  const all = sent.flatMap((e) => (e.opens ?? []).filter((o) => !ours(o.opened_by)).map((o) => ({ ...o, kind: classifyOpen(o, e.date_sent ?? e.date_created ?? null) })));
  const opens = all.filter((o) => o.kind === "person");
  const byWho = new Map<string, number>();
  for (const o of opens) byWho.set(o.opened_by!, (byWho.get(o.opened_by!) ?? 0) + 1);
  const [who, count] = [...byWho.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return {
    total: opens.length,
    last: opens.map((o) => o.opened_at).sort().pop() ?? null,
    top: who ? { who, count: count! } : null,
    emails: sent.length,
    maybe: all.filter((o) => o.kind === "maybe").length,
    scanned: all.filter((o) => o.kind === "filter").length,
    lastSent: sent.map((e) => e.date_sent ?? e.date_created).filter(Boolean).sort().pop() ?? null,
  };
}

export type LastCall = {
  at: string;
  duration: number;
  connected: boolean; // they talked (not a 7-second ring Close still marks "answered")
  voicemail: boolean;
  mine: boolean;
  contact: string | null;
  note: string | null; // the note saved after this call, if any
  transcript: string | null;
};

/** The latest finished call on the lead: when, how long, whether it connected, who, and what was noted. */
export function lastCallOf(ctx: LeadContext, repUserId: string): LastCall | null {
  const c = ctx.calls.find((x) => x.status !== "in-progress" && x.direction === "outbound");
  if (!c) return null;
  const transcript = transcriptText(c.recording_transcript);
  const voicemail = c.disposition === "vm-left" || c.disposition === "vm-answer" || /leave (a|your) message|after the (tone|beep)|mailbox/i.test(transcript ?? "");
  const noteAfter = ctx.notes
    .filter((n) => n.date_created >= c.date_created)
    .sort((a, b) => a.date_created.localeCompare(b.date_created))[0];
  return {
    at: c.date_created,
    duration: c.duration,
    connected: !voicemail && c.duration >= 20 && Boolean(c.recording_transcript?.utterances?.some((u) => u.speaker_side === "contact")),
    voicemail,
    mine: c.user_id === repUserId,
    contact: ctx.contacts.find((x) => x.id === c.contact_id)?.name ?? null,
    note: noteAfter?.note ?? c.note ?? null,
    transcript: transcript ? transcript.slice(0, 6000) : null,
  };
}

export type CallPlan =
  | { action: "call"; reason: string | null; due: string | null }
  | { action: "hold"; until: string; next: string; reason: string };

/** "[B] Check in with Michael (Purchasing) at DelHur — (360)…" → "Check in with Michael (Purchasing) at DelHur". */
export const taskTitle = (text: string) => text.replace(/^\[[A-D]\]\s*/, "").split(/\s+[—–]\s+/)[0].trim();

/**
 * The next-touch plan already lives in Close as the lead's open tasks (the
 * after-call step sets them from what the buyer said). A task due later means
 * "don't call yet"; one due today or overdue means call. A reply from them
 * since the last call beats the plan.
 */
export function callPlanOf(ctx: LeadContext, emails: LeadEmail[], lastCall: LastCall | null, now: Date, tz: string): CallPlan {
  const p = localParts(now, tz);
  const endOfToday = zonedTime(p.year, p.month, p.day, 23, 59, tz).getTime();
  const open = ctx.tasks.filter((t) => !t.is_complete && t.date).sort((a, b) => a.date.localeCompare(b.date));
  const since = lastCall?.at ?? "";
  const reply = emails.find((e) => e.direction === "incoming" && (e.date_sent ?? e.date_created ?? "") > since && ["sent", "inbox"].includes(e.status));
  if (reply) return { action: "call", reason: "They replied to your email since your last call.", due: null };
  const due = open.find((t) => new Date(t.date).getTime() <= endOfToday);
  if (due) return { action: "call", reason: `Callback due: ${taskTitle(due.text)}`, due: due.date };
  const next = open[0];
  if (next) {
    const talked = lastCall?.connected
      ? `You reached ${lastCall.contact && !/main office|office|front desk/i.test(lastCall.contact) ? lastCall.contact : "them"} on the last call; the next touch is already set.`
      : "The next touch is already scheduled.";
    return { action: "hold", until: next.date, next: taskTitle(next.text), reason: talked };
  }
  return { action: "call", reason: null, due: null };
}

function briefHeader(ctx: LeadContext): Omit<BriefResponse["header"], "myCalls" | "opens" | "lastCall" | "callPlan"> {
  const f = ctx.facts;
  return {
    company: f.company, website: f.website, status: f.statusLabel, location: f.location, phone: f.phoneDisplay, phoneE164: f.phone,
    timeZone: f.prospectTzLabel, timeZoneId: f.prospectTz, localTime: f.local?.localTime ?? null,
    afterHours: f.local?.afterHours ?? false, afterHoursReason: f.local?.reason ?? null,
    bestWindow: f.callbackAt && f.prospectTz ? formatLocal(new Date(f.callbackAt), f.prospectTz, true) : null,
  };
}

/** Hard rules on top of the model's brief: a clean A–D rating, and vendors are never pitched. */
/** How many of the brief's `buys` items the opener actually names. */
export function openerProducts(opener: string, buys: string[]): number {
  const text = opener.toLowerCase();
  const GENERIC = new Set(["and", "the", "for", "with", "hardware", "supplies", "materials", "parts", "products", "stock"]);
  return buys.filter((item) =>
    item.toLowerCase().split(/[^a-z0-9-]+/).some((w) => w.length >= 3 && !GENERIC.has(w) && new RegExp(`\\b${w.replace(/-/g, "\\-")}`).test(text)),
  ).length;
}

export function enforceBriefRules(brief: Brief, ctx: LeadContext): Brief {
  const rating = brief.rating.toUpperCase().match(/[ABCD]/)?.[0] ?? "C";
  if (!ctx.facts.vendor) return { ...brief, rating };
  return {
    ...brief, rating: "D", fit_summary: "Vendor in Close: Westgate buys from them. Not a sales call.",
    opener: "Don't pitch. This is one of our suppliers (Close marks them as a vendor).", ask: "No sales ask.",
    objection: "", objection_response: "", buys: [], capture: [],
  };
}

/** Warnings worth a glance before dialing, from code, not the model. */
function briefFlags(ctx: LeadContext): string[] {
  return ctx.facts.flags.filter((f) => /^VENDOR|watchlist|International|No phone/.test(f));
}

// ---------- warm briefs along the rep's list: the lead they're on, then the next few ----------

const AHEAD = 5;
const WARM_CONCURRENCY = 3;
const LIST_TTL_MS = 10 * 60 * 1000;
const lists = new Map<string, { at: number; ids: string[]; names: Map<string, string> }>(); // rep:smartView -> leads in order
const lastList = new Map<string, string>(); // rep -> smart view they're working
const queues = new Map<string, { todo: string[]; running: number }>(); // rep -> warm queue

export type ListStatus = { smartViewId: string; position: number | null; size: number; readyAhead: number; ahead: number; next: { id: string; name: string } | null };

async function listIds(d: Deps, smartViewId: string): Promise<string[]> {
  const key = `${d.rep.closeUserId}:${smartViewId}`;
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.ids;
  return fetchList(d, smartViewId, key);
}

async function fetchList(d: Deps, smartViewId: string, key: string): Promise<string[]> {
  const leads = await d.close.smartViewLeads(smartViewId, 200);
  const ids = leads.map((l) => l.id);
  lists.set(key, { at: Date.now(), ids, names: new Map(leads.map((l) => [l.id, l.display_name])) });
  return ids;
}

/** Queue briefs for the next few leads after `leadId` (or the top of the list). Newest request goes first. */
export async function warmAhead(d: Deps, smartViewId: string, leadId: string | null): Promise<ListStatus> {
  lastList.set(d.rep.closeUserId, smartViewId);
  const ids = await listIds(d, smartViewId);
  const at = leadId ? ids.indexOf(leadId) : -1;
  const next = ids.slice(at + 1, at + 1 + AHEAD);
  const q = queues.get(d.rep.closeUserId) ?? { todo: [], running: 0 };
  queues.set(d.rep.closeUserId, q);
  // Leads the rep has moved past are dropped; the next ones jump the line.
  const have = await Promise.all(next.map((id) => hasBrief(d, id)));
  q.todo = [...next.filter((_, i) => !have[i]), ...q.todo.filter((id) => !next.includes(id) && ids.indexOf(id) > at)];
  while (q.running < WARM_CONCURRENCY && q.todo.length) {
    q.running++;
    background((async () => {
      for (let id = q.todo.shift(); id; id = q.todo.shift()) {
        if (await hasBrief(d, id)) continue;
        await leadBrief(d, id).catch((err) => console.error(`warm ${id}:`, (err as Error).message));
      }
    })().finally(() => { q.running--; }), "warm");
  }
  return summarizeList(d, smartViewId, ids, at, next);
}

async function summarizeList(d: Deps, smartViewId: string, ids: string[], at: number, next: string[]): Promise<ListStatus> {
  const names = lists.get(`${d.rep.closeUserId}:${smartViewId}`)?.names;
  return {
    smartViewId, position: at >= 0 ? at + 1 : null, size: ids.length, ahead: next.length,
    readyAhead: (await Promise.all(next.map((id) => store.cacheGet(briefKey(d, id)).catch(() => null)))).filter(Boolean).length,
    next: next[0] ? { id: next[0], name: names?.get(next[0]) ?? "next lead" } : null,
  };
}

/** Called whenever a lead is opened: keep the next few on the rep's current list ready. */
export async function warmAfterLead(d: Deps, leadId: string): Promise<ListStatus | null> {
  const sv = lastList.get(d.rep.closeUserId);
  if (!sv) return null;
  return warmAhead(d, sv, leadId).catch(() => null);
}

export async function listStatus(d: Deps, smartViewId: string, leadId: string | null): Promise<ListStatus> {
  const ids = await listIds(d, smartViewId);
  const at = leadId ? ids.indexOf(leadId) : -1;
  const next = ids.slice(at + 1, at + 1 + AHEAD);
  return summarizeList(d, smartViewId, ids, at, next);
}

// ---------- call state (polled by the panel; no page scraping needed) ----------

export type CallState =
  | { state: "idle" }
  | { state: "on_call"; callId: string; startedAt: string }
  | { state: "ended"; callId: string; disposition: string | null; duration: number; connected: boolean; hasTranscript: boolean };

const CONNECTED = new Set(["answered"]);

export async function callState(d: Deps, leadId: string, since: string): Promise<CallState> {
  const calls = await d.close.calls({ leadId, since, max: 100 });
  const mine = calls.find((c) => c.user_id === d.rep.closeUserId && c.direction === "outbound");
  if (!mine) return { state: "idle" };
  if (mine.status === "created" || mine.status === "in-progress") return { state: "on_call", callId: mine.id, startedAt: mine.date_created };
  const t = mine.recording_transcript ?? mine.voicemail_transcript;
  return {
    state: "ended", callId: mine.id, disposition: mine.disposition, duration: mine.duration,
    connected: CONNECTED.has(mine.disposition ?? ""), hasTranscript: !!t?.utterances?.length,
  };
}

// ---------- After-Call ----------

export type Coaching = AfterCallExtras["coaching"];
export type AfterCallResponse = AfterCall & { benchmark: boolean; referral: Referral | null; proposals: Proposals; coaching: Coaching | null; warnings: string[]; callId: string | null; extras: boolean };

const NO_CONNECT: Record<string, "no_answer" | "voicemail"> = {
  "no-answer": "no_answer", busy: "no_answer", blocked: "no_answer", error: "no_answer", abandoned: "no_answer",
  "vm-left": "voicemail", "vm-answer": "voicemail",
};

type CallFocus = { ctx: LeadContext; callId: string | null; focus: CloseCall | undefined; hasTranscript: boolean };

async function loadCall(d: Deps, leadId: string, callId: string | null | undefined): Promise<CallFocus> {
  const ctx = await loadLeadContext(d.close as CloseClient, leadId, now(d));
  let id = callId ?? null;
  if (id && !ctx.calls.some((c) => c.id === id)) {
    // The call may be newer than the list we pulled; fetch it directly.
    const c = await d.close.call(id);
    if (c.lead_id !== leadId) throw new Error("That call belongs to a different lead.");
    ctx.calls.unshift(c);
  }
  id ??= ctx.calls.find((c) => c.user_id === d.rep.closeUserId)?.id ?? null;
  const focus = ctx.calls.find((c) => c.id === id);
  const hasTranscript = !!(focus?.recording_transcript?.utterances?.length || focus?.voicemail_transcript?.utterances?.length);
  return { ctx, callId: id, focus, hasTranscript };
}

function callTask(parts: string[], f: CallFocus, req: { rating?: string | null; rep_summary?: string | null }) {
  parts.push(`The lead's rating from the brief: ${req.rating ?? "not rated yet (rate it yourself using the rubric)"}.`);
  if (f.focus) parts.push(`The call is marked [THE CALL THAT JUST ENDED] above (disposition ${f.focus.disposition ?? "unknown"}).`);
  if (!f.hasTranscript) parts.push("There is no transcript for this call yet.");
  if (req.rep_summary) parts.push(`The rep's own one-line summary of what happened: "${req.rep_summary}"`);
  return parts.join("\n");
}

/** The quick half: note, contacts, callback task, status. No-answers and voicemails need no AI at all. */
export async function afterCall(d: Deps, leadId: string, req: { call_id?: string | null; rep_summary?: string | null; rating?: Brief["rating"] | null; force?: boolean; already_saved?: string[]; placeholder_task?: string | null }): Promise<AfterCallResponse> {
  const f = await loadCall(d, leadId, req.call_id);
  const { ctx } = f;
  const warnings: string[] = [];
  const rating = req.rating ?? null;
  const skipFollowUp = rating === "D" || ctx.facts.vendor;
  const missed = f.focus?.disposition ? NO_CONNECT[f.focus.disposition] : undefined;

  if (missed && !req.rep_summary && !req.force) {
    // Instant: Close already logs the dial, so the only follow-up is the callback.
    const askFor = ctx.facts.askForDefault ?? "whoever handles purchasing";
    const tasks = skipFollowUp || !ctx.facts.callbackAt ? [] : [{
      due_at: ctx.facts.callbackAt,
      title: missed === "voicemail" ? `Call back ${askFor} (left voicemail)` : `Try ${askFor} again`,
      ask_for: askFor,
      phone: null,
      email: null,
      why: null,
      deadline: null,
      pitch: "Ask for a list or open RFQ, any format.",
      details: missed === "voicemail" ? "Left a voicemail on the last try." : "No answer on the last try.",
    }];
    return {
      outcome: missed, rfq_promised: false, no_current_rfq: false, benchmark_agreed: false, asked_specific_callback: false, soft_yes: false, next_one_promised: false, referral_gatekeeper: "", referral_recipient: "", referral_said: "", referral_back_when: "", referral: null, benchmark: false, outcome_label: missed === "voicemail" ? "Voicemail" : "No answer", summary: missed === "voicemail" ? "Left a voicemail." : "No answer.",
      proposals: { note: null, contacts: [], contact_updates: [], tasks, email: null, status: null }, coaching: null, warnings, callId: f.callId, extras: false,
    };
  }
  const saved = req.already_saved?.length ? [`Already saved to Close by the rep's one-tap outcome (don't propose these again): ${req.already_saved.join("; ")}.`] : [];
  if (req.placeholder_task) {
    saved.push(`When the rep tapped, the app saved a placeholder callback: "${req.placeholder_task}". Put the right FIRST follow-up task from this call in tasks[0] anyway: who to call (the person the call named, with their direct line/extension and email if given), when (per §6 of the Email & Product Knowledge Playbook, using the precomputed dates or exactly the time they asked for), context, and what to ask. Fill "why" with the words from the call that set the date. The app will move the placeholder to match it. Only add more tasks after it if the call needs a second, separate follow-up (e.g. someone back from leave on a later date).`);
  }

  const { data } = await d.llm({
    schema: AfterCallSchema,
    effort: config.effortAfterCall,
    model: config.afterCallModel,
    context: renderContext(ctx, d.rep, { now: now(d), focusCallId: f.callId }),
    task: callTask(["If Walt didn't reach the buyer but a receptionist or colleague named who to contact (often with their email), fill the referral_* fields; that sends a cold intro via the gatekeeper.", "The rep just finished a call on this lead. Write ONLY the outcome, a what-happened summary, and the note, new contacts, follow-up tasks, and status change, following the After a call and Tasks sections of the playbook. The email draft and coaching are written separately; don't include them.", ...saved], f, req),
  });
  const proposals = sanitizeProposals({ ...data.proposals, email: null }, ctx, warnings, now(d));
  // Tag the note so the daily stats can count promised RFQs straight from Close.
  if (data.benchmark_agreed) tagNote(proposals, RFQ_ASKED_TAG, data.summary);
  if (data.rfq_promised || data.benchmark_agreed) tagNote(proposals, RFQ_TAG, data.summary);
  // They'll send a past RFQ/PO: confirm it in 2 business days instead of the 3-week check-in.
  if (data.benchmark_agreed && !skipFollowUp) applyBenchmarkTask(proposals, ctx, data.proposals.tasks[0]?.ask_for ?? null, now(d));
  const referral: Referral | null = data.referral_gatekeeper.trim() && data.referral_recipient.trim()
    ? { gatekeeper: data.referral_gatekeeper.trim(), recipient: data.referral_recipient.trim(), said_about_recipient: data.referral_said.trim() || null, back_when: data.referral_back_when.trim() || null }
    : null;
  // A cold intro via a gatekeeper never carries the past-RFQ ask.
  const benchmark = !referral && benchmarkDecision(data, ctx, transcriptText(f.focus?.recording_transcript));
  if (skipFollowUp) {
    if (proposals.tasks.length) warnings.push("No callback task: Skip-rated leads and vendors don't get follow-ups.");
    proposals.tasks = [];
  } else if (["no_answer", "voicemail"].includes(data.outcome) && proposals.tasks.length === 0 && ctx.facts.callbackAt) {
    const askFor = ctx.facts.askForDefault ?? "whoever handles purchasing";
    proposals.tasks.push({
      due_at: ctx.facts.callbackAt,
      title: `Try ${askFor} again`,
      ask_for: askFor,
      phone: null,
      email: null,
      why: null,
      deadline: null,
      pitch: "Ask for a list or open RFQ, any format.",
      details: null,
    });
  }
  return { ...data, proposals, benchmark, referral, coaching: null, warnings, callId: f.callId, extras: data.outcome === "conversation" || data.outcome === "gatekeeper" };
}

/** The slow half, run in parallel: the follow-up email draft and coaching. */
export async function afterCallExtras(d: Deps, leadId: string, req: { call_id?: string | null; rep_summary?: string | null; rating?: Brief["rating"] | null; force?: boolean; callback?: string | null; benchmark?: boolean; benchmark_agreed?: boolean; next_one?: boolean; referral?: Referral | null }): Promise<AfterCallExtras & { warnings: string[] }> {
  const f = await loadCall(d, leadId, req.call_id);
  const missed = f.focus?.disposition ? NO_CONNECT[f.focus.disposition] : undefined;
  if ((missed && !req.rep_summary && !req.force) || f.ctx.facts.vendor) return { email: null, coaching: { nice: null, next: null }, warnings: [] };
  const parts = [
      "Ask for their RFQ plainly. Never hedge or sweeten the ask: no 'no strings', 'no pressure', 'no obligation', 'no rush', 'totally optional', 'see how we stack up' or 'how our numbers compare', no promises like 'I'll get quotes back to you fast', and no 'if something comes up'. It sounds like a pitch; all we want is their RFQ.",
      "Never tell them when you'll follow up, check back, or call (no dates, days, or timeframes like 'around Oct 15', 'by Monday', 'in a few weeks'): the goal is an RFQ now, and a date invites them to wait. (Exception: a cold intro via a gatekeeper names when Walt will call, per its standard.)" + (req.next_one || req.referral ? "" : " Close by asking them to send a list or RFQ now, using what they said on the call (e.g. 'You mentioned you've always got open projects, so send over whatever's on your desk now')."),
      "Use the prospect's local time of day (their local time is in the facts) for words like 'this morning' or 'this afternoon', never the rep's.",
      req.benchmark && req.next_one
        ? `THEY'LL SEND THE NEXT ONE: they have nothing now but said they'll send the next one. Acknowledge that in their words (e.g. "Sounds good, send the next one over as soon as you have it"), then right after it ask for a recent one to price in ONE plain sentence, e.g. "${OFFERS[0]}" No explaining why. Never ask for "something small", "anything at all", or anything now, and don't end by pushing for an RFQ now.`
        : req.benchmark
        ? `PAST-RFQ ASK: they have nothing open right now, so ask plainly for a recent one to price. Put ONE direct sentence on its own line right after the "what we'd supply for you" paragraph and before the closer. Pick one of these and adapt the names: ${OFFERS.map((o) => `"${o}"`).join(" / ")}. No hedging or sweeteners (never "no strings", "no pressure", "totally optional", "see how we stack up", "so you have a comparison"). Never "shoot it over", never "no obligation", never explain why (no side-by-side, no what-you-paid-versus-us), never more than that one sentence, and never mention an approval process or supplier list they didn't bring up.`
        : req.benchmark_agreed
          ? "The buyer agreed on the call to send a past RFQ or PO for us to price: that's the point of the email. Reference it in their words, ask them to just reply with it, and say we'll price it."
          : "Don't offer to price a past RFQ or PO in this email.",
      "No em dashes or en dashes anywhere in the email body; use commas or periods.",
      ...(req.referral ? [introTask(req.referral)] : []),
      "The rep just finished a call on this lead. Write ONLY the follow-up email draft (following the Email & Product Knowledge Playbook §4). If a receptionist or colleague referred Walt to the recipient, follow the COLD INTRO VIA GATEKEEPER standard exactly (when it's given below) instead of what follows. If nothing was promised or asked for BUT we didn't reach the buyer (someone else answered, we were told to call back, or we left a voicemail) and the buyer's email is known (in Close or said on the call), write a short intro to the buyer instead: 80–120 words, subject 'Westgate Supply – line card', one short line that you called (naming who you spoke with is fine, e.g. 'I spoke with Paul, who suggested I reach out') or left a voicemail, with no other details of the call (not who left, who was out, or how you got the address), one line on what we supply for their kind of work, the ask (reply with any list or RFQ), and optionally that you'll give them a call (no time or date); set attach_line_card to true. Otherwise null. If the recipient wasn't on the call, don't thank them for the call: one short line naming who you spoke with is fine ('I spoke with Paul this afternoon and he suggested I reach out'), but nothing more about the call's logistics: not who left the company, who was out, how you got their address, or which inbox you were told to use. If the prospect offered to send something (an RFQ, a list, a drawing, 'I can send something your way'), that offer is the point of the email: reference it in the first or second paragraph in their own words ('You mentioned you have something you can send my way'), ask them to just reply to this email with it, promise fast pricing, and end by asking for it now. Never water it down to 'whenever something pops up' and never add a timeline they didn't give (don't say 'today' unless they did). Include the warehouse/location line ONLY if the prospect asked where we're located or the transcript mentions lead times, freight, shipping, a local supplier, or a plant near one of our warehouses; otherwise leave it out, even though the worked example has it. Never claim to be local to their city and never name a warehouse city; say we're a national supplier opening a local warehouse in their area and the coaching: one thing done well and one thing to do next time, from the transcript."];
  const transcript = transcriptText(f.focus?.recording_transcript);
  const context = renderContext(f.ctx, d.rep, { now: now(d), focusCallId: f.callId });
  // Pre-save validation (Walt 9/24): a draft that fails any check is regenerated; a failing draft is never saved.
  let failures: Failure[] = [];
  let coaching: AfterCallExtras["coaching"] = { nice: null, next: null };
  for (let attempt = 1; attempt <= EMAIL_ATTEMPTS; attempt++) {
    const { data } = await d.llm({
      schema: AfterCallExtrasSchema,
      effort: config.effortEmail,
      model: config.emailModel,
      context,
      task: callTask(failures.length ? [...parts, retryNote(failures)] : parts, f, req),
    });
    coaching = data.coaching;
    const warnings: string[] = [];
    if (data.email && /[—–]/.test(data.email.body)) logDashes(f, data.email, attempt);
    if (data.email && req.referral) data.email = { ...data.email, subject: INTRO_SUBJECT, attach_line_card: true };
    let email = enforceBenchmark(data.email, !!req.benchmark, warnings, { agreed: req.benchmark_agreed, nextOne: req.next_one, transcript });
    if (email && !req.referral) email = enforceGotIt(email);
    const p = sanitizeProposals({ note: null, contacts: [], contact_updates: [], tasks: [], status: null, email }, f.ctx, warnings, now(d));
    if (!p.email) return { email: null, coaching, warnings };
    failures = await checkEmail(d, f.ctx, p.email, transcript, context, req.referral);
    if (!failures.length) {
      if (isSelfTest(p.email, d.rep.name)) warnings.push(`Test: this draft is addressed to you (${p.email.to.map((r) => r.email).join(", ")}).`);
      return { email: p.email, coaching, warnings };
    }
    logRejection({ at: new Date().toISOString(), leadId, company: f.ctx.facts.company, callId: f.callId, attempt, failures, subject: p.email.subject, body: p.email.body, final: attempt === EMAIL_ATTEMPTS });
  }
  return {
    email: null, coaching,
    warnings: [`No email draft saved: it failed the pre-save checks ${EMAIL_ATTEMPTS} times (${[...new Set(failures.map((x) => x.rule))].join(", ")}). Write this one yourself.`],
  };
}

const EMAIL_ATTEMPTS = 3;

/** The "Cold intro via gatekeeper" standard (Walt 9/24), filled in from the call. */
function introTask(r: Referral): string {
  return [
    `COLD INTRO VIA GATEKEEPER: Walt did not speak to ${r.recipient}; ${r.gatekeeper} gave their name and email and said to reach out. Write to ${r.recipient} using this exact standard, in order, under 130 words:`,
    `1. Who Walt spoke to and the one useful thing they said about the recipient, close to their words from the transcript${r.said_about_recipient ? ` ("${r.said_about_recipient}")` : ""}. No embellishing.`,
    `2. One sentence introducing Walt and Westgate, tuned to the company's industry (treatment plants, structural steel, machine shop, etc.), then "I've attached our line card so you can see the full range."`,
    `3. The soft offer, no assumed relationship: "${INTRO_OFFER}"`,
    `4. Next touch: ${r.back_when ? `${r.gatekeeper} said they're back ${r.back_when}, so name that and say Walt will call then` : `"I'll give you a call in the next few days to introduce myself."`}`,
    `5. A friendly closer, then "Walt Boxwell" on its own line.`,
    `Subject: "${INTRO_SUBJECT}". attach_line_card: true. Never: "you mentioned", "as we discussed", "whenever you've got an RFQ, reply here", the past-RFQ/benchmark offer, or anything implying ${r.recipient.split(" ")[0]} already spoke with Walt. No em or en dashes.`,
    `Reference example (Probst Group, gatekeeper Hannah, recipient Tracy Reading, out until next week):\nHi Tracy,\n\nI called in this afternoon and spoke with Hannah. She mentioned you're helping the project teams with vendors and pricing right now, so she pointed me your way.\n\nI'm Walt with Westgate Supply. We're a national industrial supplier of pipe, fittings, flanges, gaskets and bolting, and we do a lot of work with teams building and operating treatment plants. I've attached our line card so you can see the full range.\n\n${INTRO_OFFER}\n\nHannah said you're back next week, so I'll give you a call then to introduce myself.\n\nHave a great rest of your day!\n\nWalt Boxwell`,
  ].join("\n");
}

/** Rule checks first (instant); only a draft that passes those goes to the reviewing model. */
async function checkEmail(d: Deps, ctx: LeadContext, email: NonNullable<Proposals["email"]>, transcript: string | null, context: string, intro: Referral | null = null): Promise<Failure[]> {
  const failures = ruleChecks(email, ctx, transcript, d.rep.name, { intro });
  if (failures.length) return failures;
  const { data } = await d.llm({ schema: EmailReviewSchema, effort: "low", model: config.emailModel, context, task: reviewTask(email, d.rep.name) });
  // The reviewer sometimes lists a rule that passed ("none found"); only real findings count.
  return data.failures.filter((x) => !/^\s*(none|no (issues?|violations?|problems?)|n\/a|passes|ok|fine)\b/i.test(x.problem));
}

/** Dashes are stripped before saving, but log them so the pattern shows up in the review. */
function logDashes(f: CallFocus, email: NonNullable<Proposals["email"]>, attempt: number) {
  const sentence = email.body.split(/(?<=[.!?])\s+|\n+/).find((x) => /[—–]/.test(x)) ?? null;
  logRejection({ at: new Date().toISOString(), leadId: f.ctx.facts.leadId, company: f.ctx.facts.company, callId: f.callId, attempt, failures: [{ rule: "dashes", sentence, problem: "Em or en dash in the body (fixed automatically)." }], subject: email.subject, body: email.body, final: false, fixed: true });
}

// ---------- Lead Chat ----------

export type ChatResponse = { reply: string; proposals: Proposals; warnings: string[] };

export async function leadChat(d: Deps, leadId: string, req: {
  message: string; history: Array<{ role: "user" | "assistant"; text: string }>; proposals?: Proposals | null; rating?: Brief["rating"] | null;
}): Promise<ChatResponse> {
  const ctx = await loadLeadContext(d.close as CloseClient, leadId, now(d));
  const stats = await repStats(d).catch(() => null);
  const current: Proposals = req.proposals ?? { note: null, contacts: [], contact_updates: [], tasks: [], email: null, status: null };
  const context = renderContext(ctx, d.rep, { now: now(d), stats });
  let failures: Failure[] = [];
  for (let attempt = 1; ; attempt++) {
    const { data } = await d.llm({
      schema: ChatSchema,
      effort: config.effortFast,
      model: config.chatModel,
      context,
      messages: req.history.map((t) => ({ role: t.role, content: t.text })),
      task: [
        `Lead rating: ${req.rating ?? "unknown"}.`,
        `Current proposed actions (not yet saved to Close):\n${JSON.stringify(current, null, 2)}`,
        `The rep says: ${req.message}`,
        ...(failures.length ? [retryNote(failures)] : []),
      ].join("\n\n"),
    });
    const warnings: string[] = [];
    const proposals = sanitizeProposals(data.proposals, ctx, warnings, now(d));
    // A draft the chat wrote or changed goes through the same pre-save checks.
    const changed = proposals.email && JSON.stringify(proposals.email) !== JSON.stringify(current.email);
    failures = changed ? await checkEmail(d, ctx, proposals.email!, null, context) : [];
    if (!failures.length) return { reply: data.reply, proposals, warnings };
    logRejection({ at: new Date().toISOString(), leadId, company: ctx.facts.company, callId: null, attempt, failures, subject: proposals.email!.subject, body: proposals.email!.body, final: attempt === 2 });
    if (attempt === 2) {
      warnings.push(`Kept the previous email draft: the new one failed the pre-save checks (${failures.map((f) => f.problem).join(" ")}).`);
      return { reply: data.reply, proposals: { ...proposals, email: current.email }, warnings };
    }
  }
}

// ---------- the rep's own Close line ----------

const linesCache = new Map<string, { at: number; value: string[] }>();

/** The rep's Close phone number(s), formatted for display. Cached for an hour. */
export async function repLines(d: Deps): Promise<string[]> {
  const hit = linesCache.get(d.rep.closeUserId);
  if (hit && Date.now() - hit.at < 3600_000) return hit.value;
  const value = (await d.close.phoneNumbers())
    .filter((p) => p.user_id === d.rep.closeUserId)
    .map((p) => formatPhone(p.number));
  linesCache.set(d.rep.closeUserId, { at: Date.now(), value });
  return value;
}

// ---------- stats ----------

const statsCache = new Map<string, { at: number; value: RepStats }>();

export async function repStats(d: Deps): Promise<RepStats> {
  const hit = statsCache.get(d.rep.closeUserId);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const p = localParts(now(d), d.rep.timeZone);
  const midnight = zonedTime(p.year, p.month, p.day, 0, 0, d.rep.timeZone).toISOString();
  const calls = (await d.close.calls({ since: midnight, withTranscripts: false, max: 1000 })).filter((c) => c.user_id === d.rep.closeUserId && c.direction === "outbound");
  const value = { dials: calls.length, connects: calls.filter((c) => CONNECTED.has(c.disposition ?? "")).length, since: midnight };
  statsCache.set(d.rep.closeUserId, { at: Date.now(), value });
  return value;
}

// ---------- rules applied to every proposal set (model output and rep edits alike) ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function sanitizeProposals(p: Proposals, ctx: LeadContext, warnings: string[], at: Date): Proposals {
  const out: Proposals = structuredClone(p);

  // Status: must exist in Close and never move a lead backwards.
  if (out.status) {
    const match = ctx.statuses.find((s) => s.label.toLowerCase() === out.status!.label.toLowerCase());
    if (!match) {
      warnings.push(`Dropped status "${out.status.label}": not a status in Close.`);
      out.status = null;
    } else if (match.label === ctx.facts.statusLabel) {
      out.status = null;
    } else if (isBackwardsMove(ctx.facts.statusLabel, match.label)) {
      warnings.push(`Kept status at ${ctx.facts.statusLabel} instead of moving it back to ${match.label}.`);
      out.status = null;
    } else {
      out.status.label = match.label;
    }
  }

  // Contacts: skip people already on the lead; flag emails that don't match the company domain.
  out.contact_updates = [...(out.contact_updates ?? [])];
  for (const c of [...out.contacts]) {
    const partial = ctx.contacts.find((e) => fillsInName(e.name, c.name));
    if (partial && !ctx.contacts.some((e) => samePerson(e.name, c.name))) {
      out.contacts.splice(out.contacts.indexOf(c), 1);
      out.contact_updates.push({ contact: partial.name, name: c.name, title: c.title, email: c.email, phone: c.phone, verify_email: c.verify_email });
    }
  }
  // Updates must point at a real contact and actually change something.
  out.contact_updates = out.contact_updates.filter((u) => {
    const target = ctx.contacts.find((e) => e.name.trim().toLowerCase() === u.contact.trim().toLowerCase()) ?? ctx.contacts.find((e) => samePerson(e.name, u.contact) || fillsInName(e.name, u.contact));
    if (!target) return false;
    u.contact = target.name;
    if (u.name && u.name.trim().toLowerCase() === target.name.trim().toLowerCase()) u.name = null;
    if (u.title && u.title === target.title) u.title = null;
    if (u.email && target.emails.some((x) => x.email.toLowerCase() === u.email!.toLowerCase())) u.email = null;
    if (u.phone && target.phones.some((x) => x.phone.replace(/\D/g, "").slice(-10) === u.phone!.replace(/\D/g, "").slice(-10) && !/x|ext/i.test(u.phone!))) u.phone = null;
    if (u.email && (!EMAIL_RE.test(u.email) || !emailMatchesDomain(u.email, ctx.facts.domain))) u.verify_email = true;
    return !!(u.name || u.title || u.email || u.phone);
  });
  const existingEmails = new Set(ctx.contacts.flatMap((c) => c.emails.map((e) => e.email.toLowerCase())));
  out.contacts = out.contacts.filter((c) => {
    if (ctx.contacts.some((e) => samePerson(e.name, c.name)) || (c.email && existingEmails.has(c.email.toLowerCase()))) {
      warnings.push(`${c.name} is already a contact on this lead.`);
      return false;
    }
    return true;
  });
  for (const c of out.contacts) {
    if (c.email && (!EMAIL_RE.test(c.email) || !emailMatchesDomain(c.email, ctx.facts.domain))) c.verify_email = true;
  }

  // Tasks: due time must parse and land in the prospect's business hours.
  for (const t of out.tasks) {
    const due = new Date(t.due_at);
    const tz = ctx.facts.prospectTz;
    if (Number.isNaN(due.getTime())) {
      warnings.push(`Task for ${t.ask_for} had no valid time; set to the suggested callback slot.`);
      t.due_at = ctx.facts.callbackAt ?? new Date(at.getTime() + 24 * 3600 * 1000).toISOString();
      continue;
    }
    if (tz) {
      // "Check in in 3 weeks" can land on a weekend (Oct 17, 9/26): move it to Monday, same time.
      const wd = localParts(due, tz).weekday;
      if (wd === 0 || wd === 6) {
        const monday = new Date(due.getTime() + (wd === 6 ? 2 : 1) * 24 * 3600 * 1000);
        warnings.push(`Moved the task for ${t.ask_for} from ${formatLocal(due, tz, true)} to ${formatLocal(monday, tz, true)}: it fell on a weekend.`);
        t.due_at = isoWithOffset(monday, tz);
        continue;
      }
      const lp = localParts(due, tz);
      const mins = lp.hour * 60 + lp.minute;
      if (mins < BUSINESS_START_MIN || mins > LAST_CALL_MIN) {
        warnings.push(`Heads-up: the task for ${t.ask_for} is due ${formatLocal(due, tz, true)} their time, outside business hours.`);
      }
    }
    // "He leaves at 2:30": never schedule the callback after the time they gave.
    const deadline = t.deadline ? new Date(t.deadline) : null;
    if (deadline && !Number.isNaN(deadline.getTime()) && due.getTime() > deadline.getTime() - 5 * 60 * 1000) {
      const pulled = new Date(Math.max(at.getTime() + 5 * 60 * 1000, deadline.getTime() - 10 * 60 * 1000));
      t.due_at = tz ? isoWithOffset(pulled, tz) : pulled.toISOString();
      warnings.push(`Moved the callback for ${t.ask_for} to ${tz ? formatLocal(pulled, tz) : pulled.toISOString()} their time, before the ${tz ? formatLocal(deadline, tz) : ""} cutoff from the call.`);
    }
    if (due.getTime() < at.getTime() - 5 * 60 * 1000) warnings.push(`Heads-up: the task for ${t.ask_for} is due in the past.`);
  }

  // Email: recipients must be real addresses; always a draft (enforced in apply).
  if (out.email) {
    const bad = out.email.to.filter((r) => !EMAIL_RE.test(r.email));
    if (bad.length) warnings.push(`Check these email addresses before approving: ${bad.map((b) => b.email || b.name).join(", ")}.`);
    out.email.body = stripDashes(out.email.body);
    // Playbook §4: at most one exclamation mark (keep the first), never over 220 words.
    let bangs = 0;
    out.email.body = out.email.body.replace(/!/g, () => (++bangs === 1 ? "!" : "."));
    // No follow-up dates/timelines in the email (Walt, 9/24): they invite the prospect to wait.
    if (/\b(check (back|in) (with you )?(around|on|by|in|next)|circle back|follow up (with you )?(around|on|by|in|next)|reach (back )?out (around|on|by|in|next)|touch base (around|on|by|in|next)|by (mon|tues|wednes|thurs|fri)day|around (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d|in (a few|a couple|two|three|\d+) (days|weeks|months))\b/i.test(out.email.body)) {
      warnings.push("The email mentions when you'll follow up. Take that out so they don't wait until then.");
    }
    const words = out.email.body.split(/\s+/).filter(Boolean).length;
    if (words > 220) warnings.push(`The email draft is ${words} words; the playbook caps it at 220. Trim before sending.`);
    const known = new Set(ctx.contacts.flatMap((c) => c.emails.map((x) => x.email.toLowerCase())));
    if (!out.email.address_as_heard && out.email.to.some((r) => !known.has(r.email.toLowerCase()))) {
      out.email.address_as_heard = "not on file in Close";
    }
    if (ctx.facts.vendor) {
      warnings.push("Dropped the sales email: this lead is a vendor.");
      out.email = null;
    }
  }
  return out;
}

// ---------- Approve: the only code path that writes to Close ----------

export type ApplyResult = { kind: string; label: string; ok: boolean; id?: string; error?: string };

const recentApplies = new Map<string, number>();

export async function applyProposals(d: Deps, leadId: string, proposals: Proposals, rating: Brief["rating"] | null): Promise<{ results: ApplyResult[]; warnings: string[] }> {
  const fingerprint = `${d.rep.closeUserId}:${leadId}:${JSON.stringify(proposals)}`;
  const last = recentApplies.get(fingerprint);
  if (last && Date.now() - last < 5 * 60 * 1000) throw new DuplicateApplyError();
  recentApplies.set(fingerprint, Date.now());

  const ctx = await loadLeadContext(d.close as CloseClient, leadId, now(d));
  const warnings: string[] = [];
  const p = sanitizeProposals(proposals, ctx, warnings, now(d));
  const results: ApplyResult[] = [];
  const run = async (kind: string, label: string, fn: () => Promise<{ id: string }>) => {
    const t0 = Date.now();
    console.info(`${new Date().toISOString()} [close ${leadId}] ${kind} "${label}": start`);
    try {
      const r = await fn();
      results.push({ kind, label, ok: true, id: r.id });
      console.info(`${new Date().toISOString()} [close ${leadId}] ${kind}: done ${r.id} (${Date.now() - t0}ms)`);
      return r.id;
    } catch (err) {
      results.push({ kind, label, ok: false, error: err instanceof Error ? err.message : String(err) });
      console.info(`${new Date().toISOString()} [close ${leadId}] ${kind}: FAILED (${Date.now() - t0}ms): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const contactIdsByEmail = new Map(ctx.contacts.flatMap((c) => c.emails.map((e) => [e.email.toLowerCase(), c.id] as const)));

  if (p.note) await run("note", p.note.pinned ? "Pinned call note" : "Call note", () => d.close.createNote(leadId, p.note!.text, p.note!.pinned));

  for (const c of p.contacts) {
    const id = await run("contact", `Contact: ${c.name}`, () => d.close.createContact(leadId, c));
    if (id && c.email) contactIdsByEmail.set(c.email.toLowerCase(), id);
  }

  for (const u of p.contact_updates ?? []) {
    const target = ctx.contacts.find((e) => e.name === u.contact);
    if (!target) continue;
    const patch: Parameters<Close["updateContact"]>[1] = {};
    if (u.name) patch.name = u.name;
    if (u.title) patch.title = u.title;
    if (u.email) patch.emails = [...target.emails, { email: u.email, type: "office" }];
    if (u.phone) patch.phones = [...target.phones, { phone: u.phone, type: "office" }];
    const what = [u.name ? `name → ${u.name}` : null, u.title ? `title ${u.title}` : null, u.email, u.phone].filter(Boolean).join(", ");
    await run("contact-update", `Update ${target.name}: ${what}`, async () => { await d.close.updateContact(target.id, patch); return { id: target.id }; });
  }

  for (const t of p.tasks) {
    await run("task", `Task: ${t.ask_for}`, () => d.close.createTask(leadId, taskText(t, ctx, rating), t.due_at, d.rep.closeUserId));
  }

  // Last gate before Close: a draft that fails the rule checks (however it got here: model, chat, or an edit) isn't saved.
  const emailFailures = p.email ? ruleChecks(p.email, ctx, null, d.rep.name) : [];
  if (p.email && emailFailures.length) {
    logRejection({ at: new Date().toISOString(), leadId, company: ctx.facts.company, callId: null, attempt: 0, failures: emailFailures, subject: p.email.subject, body: p.email.body, final: true });
    results.push({ kind: "email", label: "Email draft", ok: false, error: `Not saved, it failed the pre-save checks: ${emailFailures.map((f) => f.problem).join(" ")}` });
  } else if (p.email) {
    const e = p.email;
    const contactId = e.to.map((r) => contactIdsByEmail.get(r.email.toLowerCase())).find(Boolean) ?? null;
    // The line card PDF comes from the Close template so the body stays ours.
    let attachments: Awaited<ReturnType<Close["emailTemplateAttachments"]>> = [];
    let attachFailed = false;
    if (e.attach_line_card) {
      try {
        attachments = await lineCardAttachments(d);
        attachFailed = attachments.length === 0;
      } catch {
        attachFailed = true;
      }
    }
    const label = `Draft email to ${e.to.map((r) => r.name).join(", ")}${e.attach_line_card ? (attachFailed ? " — LINE CARD NOT ATTACHED" : " with line card") : ""}`;
    await run("email", label, () => d.close.createDraftEmail(leadId, {
      contactId, to: e.to.map((r) => r.email), subject: e.subject, body: e.body, attachments,
      sender: d.rep.sender ?? `"${d.rep.name.replaceAll('"', "")}" <${d.rep.email}>`, emailAccountId: d.rep.emailAccountId ?? null,
    }));
    if (!d.rep.emailAccountId) warnings.push("No connected email account found in Close; the draft's From may need setting before sending.");
    if (attachFailed) warnings.push("LINE CARD NOT ATTACHED. Add it to the draft in Close before sending.");
  }

  if (p.status) {
    const status = ctx.statuses.find((s) => s.label === p.status!.label)!;
    await run("status", `Status → ${status.label}`, () => d.close.updateLeadStatus(leadId, status.id));
  }

  if (results.some((r) => !r.ok)) recentApplies.delete(fingerprint); // let the rep retry after a failure
  await store.cacheDelete(briefKey(d, leadId)).catch(() => {});
  return { results, warnings };
}

let lineCard: { at: number; attachments: Awaited<ReturnType<Close["emailTemplateAttachments"]>> } | null = null;
/** Tests only: forget the cached line card attachment list. */
export function resetLineCardCache() {
  lineCard = null;
}

export async function lineCardAttachments(d: Deps) {
  if (lineCard && Date.now() - lineCard.at < 12 * 3600 * 1000) return lineCard.attachments;
  const attachments = await d.close.emailTemplateAttachments(config.lineCardTemplateId);
  lineCard = { at: Date.now(), attachments };
  return attachments;
}

export class DuplicateApplyError extends Error {
  constructor() {
    super("These exact changes were already saved to Close a moment ago.");
  }
}

/**
 * Task text per §6 of the Email & Product Knowledge Playbook:
 * `[Rating] Verb + who + at + company — phone, email. Context from the call. What to ask.`
 */
export function taskText(t: Proposals["tasks"][number], ctx: LeadContext, rating: Brief["rating"] | null): string {
  const f = ctx.facts;
  const reach = [t.phone || f.phoneDisplay, t.email].filter(Boolean).join(", ");
  const sentence = (x: string | null | undefined) => (x ? (/[.!?]$/.test(x.trim()) ? x.trim() : `${x.trim()}.`) : null);
  return [`[${rating ?? "?"}] ${t.title} at ${f.company}${reach ? ` — ${reach}.` : "."}`, sentence(t.details), sentence(t.pitch)]
    .filter(Boolean).join(" ");
}
