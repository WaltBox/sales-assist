import { randomUUID } from "node:crypto";
import {
  afterCall, afterCallExtras, applyProposals, DuplicateApplyError, leadChat, RFQ_ASKED_TAG, tagNote, taskText, taskTitle, type ApplyResult, type Coaching, type Deps,
} from "./assistant.js";
import { background } from "./background.js";
import { hasBenchmark } from "./benchmark.js";
import { transcriptText, type CloseCall, type CloseClient } from "./close.js";
import { config } from "./config.js";
import { loadLeadContext } from "./context.js";
import { businessDaysAt, formatLocal, isBackwardsMove, isOutStatus, isoWithOffset, localParts, nextWeekdayAt, samePerson, zonedTime } from "./rules.js";
import { store } from "./store.js";
import { extractPurchasing, type Purchasing } from "./purchasing.js";
import { recordPurchasing } from "./potential.js";
import { markReached } from "./dialviews.js";
import { detectLineCardRequest, draftLineCardEmail, recordLineCardSend, type EmailFormat, type LineCardState } from "./linecardflow.js";

const shortDate = (d: Date, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric" }).format(d);
import type { Proposals, QuickOutcome } from "./schemas.js";

// The call-ended flow: one tap saves the obvious things to Close right away
// (status + callback task), and a background job waits for Close's transcript
// and builds the rest (contacts, note, email draft, coaching) into the rep's
// approval queue. The rep never waits on either.

export type QueueItem = {
  id: string;
  repId: string;
  leadId: string;
  company: string;
  callId: string | null;
  outcome: QuickOutcome;
  note: string | null;
  rating: string | null;
  createdAt: string;
  state: "building" | "ready" | "saved" | "failed" | "done" | "discarded";
  applied: ApplyResult[] | null; // what was written to Close automatically
  saved: string[]; // what the one tap already wrote to Close
  savedTaskAt: string | null;
  savedStatus: string | null;
  outcomeLabel: string | null;
  summary: string | null;
  callWith: string | null;
  duration: number | null;
  transcript?: null; // not stored: Close has it (GET /api/queue/:id/transcript)
  tz?: string; // the prospect's time zone, for the callback times
  taskId: string | null; // the callback the tap saved (in Close); rewritten from the transcript when it arrives
  smartTask: { title: string; when: string; why: string | null; changed: boolean } | null;
  noTranscript?: boolean; // Close never produced one for this call
  proposals: Proposals | null;
  coaching: Coaching | null;
  warnings: string[];
  error?: string;
  /** What the rep must see: anything skipped or suppressed (warn), and any Close error (error). Never silent. */
  alerts?: Array<{ level: "warn" | "error"; text: string }>;
  /** Under 20 seconds: no transcript to read; the dial is logged and nothing else is built. */
  dialOnly?: boolean;
  /** What the buyer said about their purchasing cycle on this call (each with their words), for the rep to confirm. */
  purchasing?: Purchasing | null;
  /** They asked for the line card (10/7): what was heard, the format picked and why, so the panel can switch it. */
  lineCard?: LineCardState | null;
};

// Every step logs its start and end, so a call that "did nothing" can be traced (Walt 9/26).
const MIN_TALK_SECONDS = 20;
const plog = (it: { callId: string | null; id: string }, msg: string) => console.info(`${new Date().toISOString()} [pipeline ${it.callId ?? it.id}] ${msg}`);
async function step<T>(it: { callId: string | null; id: string }, name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  plog(it, `${name}: start`);
  try {
    const r = await fn();
    plog(it, `${name}: done (${Date.now() - t0}ms)`);
    return r;
  } catch (err) {
    plog(it, `${name}: FAILED (${Date.now() - t0}ms): ${(err as Error).message}`);
    throw err;
  }
}
const alert = (it: QueueItem, level: "warn" | "error", text: string) => {
  it.alerts = [...(it.alerts ?? []), { level, text }];
  plog(it, `${level === "error" ? "ERROR" : "ALERT"}: ${text}`);
};
// Warnings that mean something was skipped or not saved: shown as cards, not buried.
const SUPPRESSION = /^(No email draft saved|Dropped the sales email|LINE CARD NOT ATTACHED|Couldn't|Skipped|Moved the|Test:)/; // "Skipped the email draft: you sent the line card during the call" too

// Reviews live in the store (Supabase when hosted). Close holds everything once
// it's saved, so a saved review is only kept a day for the panel, then slimmed
// to the tap itself (for the week stats) and deleted after 8 days.
const DAY = 24 * 3600 * 1000;
const nowOf = (d: Deps) => d.now?.() ?? new Date();

async function save(it: QueueItem) {
  await store.putReview({ ...it, transcript: null });
}

export async function listQueue(d: Deps): Promise<QueueItem[]> {
  const since = new Date(nowOf(d).getTime() - DAY).toISOString();
  return (await store.listReviews<QueueItem>(d.rep.closeUserId, since))
    .filter((it) => ["building", "ready", "failed"].includes(it.state) || (["saved", "done"].includes(it.state) && it.createdAt >= since))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** What the app wrote about each call (its summary), for the stats tables. */
export async function callSummaries(repId: string): Promise<Map<string, string>> {
  const items = await store.listReviews<QueueItem>(repId, new Date(Date.now() - 8 * DAY).toISOString()).catch(() => []);
  return new Map(items.filter((it) => it.callId && it.summary).map((it) => [it.callId!, it.summary!]));
}

/** What the rep tapped for each call (the stats count these alongside the transcripts). */
export async function tappedOutcomes(repId: string): Promise<Map<string, QuickOutcome>> {
  const items = await store.listReviews<QueueItem>(repId, new Date(Date.now() - 8 * DAY).toISOString()).catch(() => []);
  return new Map(items.filter((it) => it.callId).map((it) => [it.callId!, it.outcome]));
}

export async function getItem(d: Deps, id: string): Promise<QueueItem> {
  const it = await store.getReview<QueueItem>(id);
  if (!it || it.repId !== d.rep.closeUserId) throw new QueueError("That follow-up isn't in your queue anymore.");
  return it;
}

export class QueueError extends Error {}

// ---------- one tap ----------

const OUTCOME_LABEL: Record<QuickOutcome, string> = {
  reached_buyer: "Reached buyer",
  got_name: "Got a name",
  voicemail: "Voicemail",
  no_answer: "No answer",
};

const recentTaps = new Map<string, number>();

export async function quickOutcome(d: Deps, leadId: string, req: {
  outcome: QuickOutcome; note?: string | null; call_id?: string | null; rating?: string | null;
  change?: { task_id?: string | null; queued_id?: string | null; prev_status?: string | null; set_status?: string | null } | null;
}) {
  const change = req.change ?? null;
  const tapKey = `${d.rep.closeUserId}:${leadId}:${req.call_id ?? "none"}`;
  const last = recentTaps.get(tapKey);
  if (!change && last && Date.now() - last < 10 * 60 * 1000) throw new QueueError("You already saved an outcome for this call.");
  // A real conversation: "Last reached" is today, so today's call lists in Close drop them (10/6).
  if (req.outcome === "reached_buyer" || req.outcome === "got_name") void markReached(d, leadId);
  recentTaps.set(tapKey, Date.now());

  const now = d.now?.() ?? new Date();
  const ctx = await loadLeadContext(d.close as CloseClient, leadId, now);
  const f = ctx.facts;
  const tz = f.prospectTz ?? d.rep.timeZone;
  const note = req.note?.trim() || null;
  const skip = req.rating === "D" || f.vendor;
  const call = req.call_id ? await d.close.call(req.call_id).catch(() => null) : null;
  const earlier = (await store.listReviews<QueueItem>(d.rep.closeUserId, new Date(now.getTime() - 8 * DAY).toISOString()).catch(() => [])).filter((x) => x.leadId === leadId);
  const callee = whoWasCalled(ctx, call, note, earlier);
  const askFor = callee.name ?? f.askForDefault ?? "whoever handles purchasing";
  const saved: string[] = [];
  const results: ApplyResult[] = [];

  // When to call back, per §6 of the Email & Product Knowledge Playbook. After a real
  // conversation the date comes from the transcript, so that task is built in the queue.
  const localHour = localParts(now, tz).hour;
  // Didn't reach the buyer: call back in the other half of the day (morning call → 2:00 PM, afternoon → 9:30 AM).
  // Walt 9/29: early touches close together, a different time of day each try.
  const flip = (n: number) => businessDaysAt(tz, now, n, localHour < 12 ? 14 : 9, localHour < 12 ? 0 : 30);
  const due =
    req.outcome === "no_answer" ? flip(1)
      : req.outcome === "voicemail" ? flip(2)
        : req.outcome === "reached_buyer" ? businessDaysAt(tz, now, 2, 10, 0) // placeholder until the transcript sets it
          : flip(2); // got a name: the buyer in 2 business days, other half of the day (never two days in a row, 9/30)
  // Every tap saves a callback right away; for calls with a conversation the
  // background build rewrites it from the transcript (who, when, why).
  const tapTask = true;
  // One task per lead per call: a callback already scheduled for later wins.
  const later = ctx.tasks.find((t) => !t.is_complete && t.id !== change?.task_id && new Date(t.date).getTime() > now.getTime() + 3600 * 1000);
  // The callback that was due (the one you're making now, or overdue): it moves to the new time instead of a second
  // task being added, so the lead leaves "Callbacks due today" (Walt 9/30).
  const dueNow = change?.task_id ? null : ctx.tasks.filter((t) => !t.is_complete && new Date(t.date).getTime() <= now.getTime() + 3600 * 1000).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  const who = callee.name ?? "purchasing";
  const title = {
    reached_buyer: `Follow up with ${who}`,
    got_name: callee.name ? `Call ${callee.name}` : "Call the contact you got",
    voicemail: `Call back ${who}`,
    no_answer: `Call back ${who}`,
  }[req.outcome];
  const context = {
    reached_buyer: `Talked on ${shortDate(now, tz)}.`,
    got_name: `On ${shortDate(now, tz)} got a name to ask for.`,
    voicemail: `Left a voicemail ${shortDate(now, tz)}.`,
    no_answer: `No answer ${shortDate(now, tz)}.`,
  }[req.outcome];

  let savedTaskAt: string | null = null;
  let taskId: string | null = null;
  if (!skip && tapTask && later) {
    saved.push(`open callback already on ${formatLocal(new Date(later.date), tz, true)}, kept it`);
  } else if (!skip && tapTask) {
    const task = {
      due_at: isoWithOffset(due, tz), title, ask_for: askFor, phone: callee.phone, email: null, why: null, deadline: null,
      pitch: "Ask for a list or open RFQ, any format.", details: [context, note].filter(Boolean).join(" "),
    };
    try {
      // A changed tap moves the callback the first tap made, instead of adding a second one.
      // A changed tap rewrites its own task; a due callback keeps its wording ("Confirm J. Waite got the line card")
      // and only moves to the new time.
      const r = change?.task_id
        ? (await d.close.updateTask(change.task_id, { date: task.due_at, text: taskText(task, ctx, req.rating ?? null) }), { id: change.task_id })
        : dueNow
          ? (await d.close.updateTask(dueNow.id, { date: task.due_at }), { id: dueNow.id })
          : await d.close.createTask(leadId, taskText(task, ctx, req.rating ?? null), task.due_at, d.rep.closeUserId);
      savedTaskAt = task.due_at;
      taskId = r.id;
      saved.push(`${title} ${formatLocal(due, tz, true)}`);
      results.push({ kind: "task", label: title, ok: true, id: r.id });
    } catch (err) {
      results.push({ kind: "task", label: title, ok: false, error: (err as Error).message });
    }
  }

  let savedStatus: string | null = null;
  const wantStatus = req.outcome === "reached_buyer" ? "Qualified" : req.outcome === "got_name" ? "Called" : null;
  const status = wantStatus ? ctx.statuses.find((s) => s.label.toLowerCase() === wantStatus.toLowerCase()) : undefined;
  if (status && status.label !== f.statusLabel && !isBackwardsMove(f.statusLabel, status.label) && !f.vendor) {
    try {
      await d.close.updateLeadStatus(leadId, status.id);
      savedStatus = status.label;
      saved.unshift(`status ${status.label}`);
      results.push({ kind: "status", label: `Status → ${status.label}`, ok: true });
    } catch (err) {
      results.push({ kind: "status", label: `Status → ${status.label}`, ok: false, error: (err as Error).message });
    }
  }

  // The first tap set a status this one wouldn't (Reached buyer → Qualified, then it was really no answer): put it back.
  if (change?.set_status && change.prev_status && savedStatus !== change.set_status && change.prev_status !== change.set_status) {
    const fresh = (await d.close.lead(leadId).catch(() => null))?.status_label;
    const back = ctx.statuses.find((s) => s.label === change.prev_status);
    if (fresh === change.set_status && back) {
      try {
        await d.close.updateLeadStatus(leadId, back.id);
        saved.unshift(`status back to ${back.label}`);
        results.push({ kind: "status", label: `Status back to ${back.label}`, ok: true });
      } catch (err) {
        results.push({ kind: "status", label: `Status back to ${back.label}`, ok: false, error: (err as Error).message });
      }
    }
  }

  // A changed tap relabels the review the first tap started, so the transcript is read with the right outcome.
  if (change?.queued_id) {
    const prev = await store.getReview<QueueItem>(change.queued_id).catch(() => null);
    if (prev && prev.repId === d.rep.closeUserId && prev.leadId === leadId) {
      Object.assign(prev, { outcome: req.outcome, outcomeLabel: OUTCOME_LABEL[req.outcome], note: note ?? prev.note, saved, savedStatus: savedStatus ?? prev.savedStatus, taskId: taskId ?? prev.taskId, savedTaskAt: savedTaskAt ?? prev.savedTaskAt });
      plog(prev, `outcome changed to ${req.outcome}`);
      await save(prev);
      return {
        saved, results, queued: prev.id, label: OUTCOME_LABEL[req.outcome], prevStatus: f.statusLabel, setStatus: savedStatus,
        task: taskId && savedTaskAt ? { id: taskId, due_at: savedTaskAt, when: formatLocal(due, tz, true), options: rescheduleOptions(tz, now) } : null,
      };
    }
  }

  // Everything else waits for the transcript, in the background.
  let queued: QueueItem | null = null;
  // Whatever was tapped, if Close says someone picked up there's a conversation to read:
  // the transcript decides the callback ("call back in about an hour").
  const talked = call?.disposition === "answered" || (call?.duration ?? 0) > MIN_TALK_SECONDS;
  if ((req.outcome !== "no_answer" || talked || note) && !f.vendor) {
    queued = {
      id: randomUUID(), repId: d.rep.closeUserId, leadId, company: f.company, callId: req.call_id ?? null,
      outcome: req.outcome, note, rating: req.rating ?? null, createdAt: now.toISOString(), state: "building",
      saved, savedTaskAt, savedStatus, outcomeLabel: OUTCOME_LABEL[req.outcome], summary: null, callWith: null, duration: null, tz,
      taskId, smartTask: null, applied: null,
      proposals: null, coaching: null, warnings: [],
    };
    plog(queued, `call-ended: tapped ${req.outcome}, ${call ? `${call.duration}s ${call.disposition ?? call.status}` : "no call found"}`);
    if (call && call.duration < MIN_TALK_SECONDS && !note) {
      // Too short for a transcript (Close doesn't transcribe these): log the dial, keep what the tap saved, stop.
      Object.assign(queued, dialLog(call.duration));
      plog(queued, `duration gate: ${call.duration}s < ${MIN_TALK_SECONDS}s, dial logged, no transcript wait`);
      await save(queued);
    } else {
      await save(queued);
      background(advance(d, queued.id), "build");
    }
  }
  return {
    saved, results, queued: queued?.id ?? null, label: OUTCOME_LABEL[req.outcome], prevStatus: f.statusLabel, setStatus: savedStatus,
    task: taskId && savedTaskAt ? { id: taskId, due_at: savedTaskAt, when: formatLocal(due, tz, true), options: rescheduleOptions(tz, now) } : null,
  };
}

/**
 * Shot down (Walt 10/5) without an outcome tap: the call is still read, so the note (why they said no) and any
 * new contacts are saved to Close. No callback, status or email comes of it: the build skips those for a lead
 * marked Not Interested. A "no" from a person counts as a reach.
 */
export async function queueShotDown(d: Deps, leadId: string, req: { call_id?: string | null; note?: string | null }) {
  if (!req.call_id) return null;
  // An outcome tap already queued this call: that review carries it.
  if ((await store.reviewsForCall<QueueItem>(req.call_id).catch(() => [])).some((x) => x.leadId === leadId)) return null;
  const now = d.now?.() ?? new Date();
  const [call, lead] = await Promise.all([d.close.call(req.call_id).catch(() => null), d.close.lead(leadId).catch(() => null)]);
  const note = req.note?.trim() || null;
  const it: QueueItem = {
    id: randomUUID(), repId: d.rep.closeUserId, leadId, company: lead?.display_name ?? "", callId: req.call_id,
    outcome: "reached_buyer", note, rating: null, createdAt: now.toISOString(), state: "building",
    saved: ["status Not Interested"], savedTaskAt: null, savedStatus: "Not Interested", outcomeLabel: "Shot down", summary: null, callWith: null, duration: null,
    taskId: null, smartTask: null, applied: null, proposals: null, coaching: null, warnings: [],
  };
  plog(it, `call-ended: shot down, ${call ? `${call.duration}s ${call.disposition ?? call.status}` : "no call found"}`);
  if (call && call.duration < MIN_TALK_SECONDS && !note) {
    Object.assign(it, dialLog(call.duration));
    await save(it);
    return it.id;
  }
  await save(it);
  background(advance(d, it.id), "build");
  return it.id;
}

// ---------- changing the one-tap task's time ----------

/** Quick picks in the prospect's business hours: later today (if there's time), tomorrow morning, tomorrow afternoon. */
export function rescheduleOptions(tz: string, now: Date): Array<{ label: string; due_at: string }> {
  const out: Array<{ label: string; due_at: string }> = [];
  const p = localParts(now, tz);
  const mins = p.hour * 60 + p.minute;
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  // Later today: ~90 minutes out, on the half hour, no later than 4:00 PM their time.
  const later = Math.ceil((Math.max(mins, 8 * 60) + 90) / 30) * 30;
  if (weekday && later <= 16 * 60) {
    const at = zonedTime(p.year, p.month, p.day, Math.floor(later / 60), later % 60, tz);
    out.push({ label: `Later today, ${formatLocal(at, tz)}`, due_at: isoWithOffset(at, tz) });
  }
  const am = nextWeekdayAt(tz, now, 10, 0);
  const pm = nextWeekdayAt(tz, now, 14, 0);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(am);
  const isTomorrow = localParts(am, tz).day === localParts(new Date(now.getTime() + 24 * 3600 * 1000), tz).day;
  out.push({ label: `${isTomorrow ? "Tomorrow" : day} 10:00 AM`, due_at: isoWithOffset(am, tz) });
  out.push({ label: `${isTomorrow ? "Tomorrow" : day} 2:00 PM`, due_at: isoWithOffset(pm, tz) });
  return out;
}

/** Replace the tap's placeholder task in Close with the one the transcript calls for. */
async function rewriteTask(d: Deps, it: QueueItem, next: Proposals["tasks"][number]) {
  const due = new Date(next.due_at);
  if (Number.isNaN(due.getTime())) throw new Error("no valid date");
  const ctx = await loadLeadContext(d.close as CloseClient, it.leadId, nowOf(d));
  const tz = it.tz ?? ctx.facts.prospectTz ?? d.rep.timeZone;
  const task = { ...next, due_at: isoWithOffset(due, tz) };
  await d.close.updateTask(it.taskId!, { date: task.due_at, text: taskText(task, ctx, (it.rating as never) ?? null) });
  return { due_at: task.due_at, when: formatLocal(due, tz, true) };
}

/** Move a callback the tap saved. Close has the task; only its date changes. */
export async function rescheduleTask(d: Deps, leadId: string, taskId: string, dueAt: string) {
  const t = await d.close.task(taskId).catch(() => null);
  if (!t || t.lead_id !== leadId || t.assigned_to !== d.rep.closeUserId || t.is_complete) {
    throw new QueueError("Can't find that task anymore. Change the date in Close.");
  }
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw new QueueError("That date doesn't look right.");
  const ctx = await loadLeadContext(d.close as CloseClient, leadId, nowOf(d));
  const tz = ctx.facts.prospectTz ?? d.rep.timeZone;
  const at = isoWithOffset(due, tz);
  await d.close.updateTask(taskId, { date: at });
  // Keep the queue from proposing a duplicate at the new time.
  for (const it of await listQueue(d)) {
    if (it.leadId === leadId && it.state === "building") await save({ ...it, savedTaskAt: at });
  }
  return { id: taskId, due_at: at, when: formatLocal(due, tz, true) };
}

// ---------- who did the rep just call? ----------

const digits = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);
const isPerson = (name: string) => !/main|office|front desk|reception|general|switchboard/i.test(name);

/**
 * The person on the other end of this call, so the callback task names them:
 * the contact Close attached to the call, then whoever owns the number dialed
 * (a Close contact, or someone waiting in the rep's queue from an earlier call
 * on this lead), then a short name the rep typed.
 */
export function whoWasCalled(
  ctx: Awaited<ReturnType<typeof loadLeadContext>>,
  call: { contact_id: string | null; remote_phone: string | null } | null, note: string | null,
  earlier: QueueItem[],
): { name: string | null; phone: string | null } {
  const dialed = digits(call?.remote_phone);
  const mainLine = digits(ctx.facts.phone);
  const direct = dialed && dialed !== mainLine ? prettyPhone(dialed) : null;

  const attached = ctx.contacts.find((c) => c.id === call?.contact_id);
  if (attached && isPerson(attached.name)) return { name: attached.name, phone: direct };

  if (dialed) {
    const byPhone = ctx.contacts.find((c) => isPerson(c.name) && c.phones.some((p) => digits(p.phone) === dialed));
    if (byPhone) return { name: byPhone.name, phone: direct };
    for (const it of earlier) {
      if (!it.proposals) continue;
      const c = it.proposals.contacts.find((x) => digits(x.phone) === dialed);
      if (c) return { name: c.name, phone: direct };
      const t = it.proposals.tasks.find((x) => digits(x.phone) === dialed);
      if (t) return { name: t.ask_for.replace(/\s*\(.*\)\s*$/, ""), phone: direct };
    }
  }
  // "Corbin" or "Matt Michon" typed in "Anything to add?"
  if (note && /^[A-Z][a-zA-Z'.-]+( [A-Z][a-zA-Z'.-]+){0,2}$/.test(note.trim())) return { name: note.trim(), phone: direct };
  return { name: null, phone: direct };
}

function prettyPhone(ten: string) {
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : ten;
}

// ---------- background build ----------

const hasTranscript = (c: CloseCall | null) => !!(c?.recording_transcript?.utterances?.length || c?.voicemail_transcript?.utterances?.length);
const LEASE_MS = 5 * 60 * 1000;

/**
 * Move a waiting review along: build it once Close's transcript is in (or once
 * we've waited long enough). Nothing sits and waits: this runs when the rep
 * taps, when Close says the call changed (webhook), when the panel refreshes
 * the queue, and from the catch-up job. The lease keeps two of those from
 * building the same call.
 */
export async function advance(d: Deps, id: string) {
  const it = await store.getReview<QueueItem>(id);
  if (!it || it.state !== "building") return;
  if (!(await store.claim(id, Date.now() + LEASE_MS))) return;
  let built = false;
  try {
    const call = it.callId ? await step(it, "fetch call", () => d.close.call(it.callId!)).catch(() => null) : null;
    if (call && call.duration < MIN_TALK_SECONDS && !it.note) {
      built = true;
      Object.assign(it, dialLog(call.duration));
      plog(it, `duration gate: ${call.duration}s < ${MIN_TALK_SECONDS}s, dial logged`);
      await save(it);
      await store.release(it.id);
      return;
    }
    const waited = Date.now() - new Date(it.createdAt).getTime();
    if (it.callId && !hasTranscript(call)) {
      if (waited < config.transcriptWaitMs) {
        plog(it, `wait for transcript: not yet (${Math.round(waited / 1000)}s of ${Math.round(config.transcriptWaitMs / 1000)}s)`);
        return;
      }
      if (!it.note) {
        // Hard stop: never hang. A visible card with Rebuild (which checks Close again).
        built = true;
        it.state = "failed";
        it.noTranscript = true;
        it.error = `No transcript for this call. Close didn't produce one within ${Math.round(config.transcriptWaitMs / 60000)} minutes. Rebuild to check again, or add a note to build from what you remember.`;
        plog(it, "wait for transcript: TIMEOUT, no transcript card");
        await save(it);
        await store.release(it.id);
        return;
      }
      plog(it, "wait for transcript: timeout, building from the rep's note");
    } else if (it.callId) {
      plog(it, `wait for transcript: ready after ${Math.round(waited / 1000)}s`);
    }
    built = true;
    await buildNow(d, it, call);
  } finally {
    if (!built) await store.release(id);
  }
}

/** Build right away from whatever Close has (Rebuild, or a note added after the tap). */
export async function build(d: Deps, it: QueueItem, opts: { callbackOnly?: boolean } = {}) {
  if (!(await store.claim(it.id, Date.now() + LEASE_MS))) return;
  const call = it.callId ? await step(it, "fetch call", () => d.close.call(it.callId!)).catch(() => null) : null;
  if (call && call.duration < MIN_TALK_SECONDS && !it.note) {
    Object.assign(it, dialLog(call.duration));
    plog(it, `duration gate: ${call.duration}s < ${MIN_TALK_SECONDS}s, dial logged`);
    await save(it);
    await store.release(it.id);
    return;
  }
  await buildNow(d, it, call, opts);
}

/** A call too short to transcribe: the dial is logged (visibly), nothing else is built. */
function dialLog(seconds: number): Partial<QueueItem> {
  return {
    state: "done", dialOnly: true, noTranscript: true, duration: seconds, error: undefined,
    summary: `${seconds}-second call: too short for a transcript. Logged the dial; nothing else to read.`,
  };
}

async function buildNow(d: Deps, it: QueueItem, call: CloseCall | null, opts: { callbackOnly?: boolean } = {}) {
  // callbackOnly: the rest was already saved to Close; just re-decide the callback.
  const prev = opts.callbackOnly ? { state: it.state, proposals: it.proposals, coaching: it.coaching, summary: it.summary } : null;
  it.state = "building";
  it.error = undefined;
  it.alerts = [];
  it.warnings = [];
  await save(it);
  try {
    it.duration = call?.duration ?? null;
    // What the tap saved, read back from Close.
    const t = it.taskId ? await d.close.task(it.taskId).catch(() => null) : null;
    const tz = it.tz ?? d.rep.timeZone;
    const placeholder = t && !t.is_complete ? { title: taskTitle(t.text).replace(new RegExp(`\\s+at\\s+${it.company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?$`), ""), due_at: t.date } : null;
    const req = {
      call_id: it.callId, rep_summary: it.note, rating: it.rating as never, force: true,
      already_saved: it.savedStatus ? [`status ${it.savedStatus}`] : [],
      placeholder_task: placeholder ? `${placeholder.title}, ${formatLocal(new Date(placeholder.due_at), tz, true)}` : null,
    };
    // Callback first, then the email, so the email says the same time as the task.
    const core = await step(it, "extract (note, contacts, tasks, status)", () => afterCall(d, it.leadId, req));
    const next = core.proposals.tasks[0];
    const callback = next && placeholder ? `${next.title}, ${formatLocal(new Date(next.due_at), tz, true)}` : null;
    // The purchasing cycle (Walt 10/5): what the buyer said about RFQ volume, vendors, how to get on the list.
    // Read alongside the email draft (independent of it); saved as heard, not confirmed, so the heat map moves now.
    const transcript = transcriptText(call?.recording_transcript);
    const purchasingP: Promise<Purchasing | null> = transcript && call && !["no-answer", "busy", "vm-left", "vm-answer", "blocked"].includes(call.disposition ?? "")
      ? step(it, "purchasing cycle", () => extractPurchasing(d, it.company, transcript, call.date_created)).catch((err) => { it.warnings.push(`Couldn't read the purchasing answers: ${(err as Error).message}`); return null; })
      : Promise.resolve(null);
    // "Send us a line card" (Walt 10/7): read alongside the email draft; when they asked, the line card email
    // (the card as searchable text, in the format that fits how they file vendors) replaces the generic draft.
    const lead = await d.close.lead(it.leadId).catch(() => null);
    const lineCardP = transcript && call && !["no-answer", "busy", "vm-left", "vm-answer", "blocked"].includes(call.disposition ?? "")
      ? step(it, "line card request", () => detectLineCardRequest(d, { company: it.company, transcript: transcript ?? "", description: lead?.description ?? null, state: lead?.addresses?.[0]?.state ?? null, contacts: (lead?.contacts ?? []).map((c) => ({ name: c.name, email: c.emails[0]?.email ?? null })) }))
        // They asked: the line card email is written while the generic draft is still being written, so the wait is the same.
        .then((req) => (req ? step(it, "line card email", () => draftLineCardEmail(d, { leadId: it.leadId, company: it.company, transcript: transcript ?? "", req })) : null))
        .catch((err) => { it.warnings.push(`Couldn't write the line card email: ${(err as Error).message}`); return null; })
      : Promise.resolve(null);
    const extras = await step(it, "write email", () => afterCallExtras(d, it.leadId, { ...req, callback, benchmark: core.benchmark, benchmark_agreed: core.benchmark_agreed, next_one: core.next_one_promised, referral: core.referral }));
    const p: Proposals = { ...core.proposals, email: extras.email };
    const lc = await lineCardP;
    it.lineCard = lc?.state ?? null;
    if (lc) {
      if (lc.email) p.email = lc.email;
      it.warnings.push(...lc.warnings);
    }
    // Sent the line card during the call ("Send line card now")? Then don't draft a second one.
    if (p.email && call) {
      const sentOnCall = (await d.close.leadEmails(it.leadId).catch(() => [])).find((e) => e.direction === "outgoing" && ["sent", "outbox"].includes(e.status)
        && (e.date_sent ?? e.date_created ?? "") >= call.date_created && (e.attachments ?? []).some((a) => /line.?card/i.test(a.filename ?? "")));
      if (sentOnCall) {
        p.email = null;
        it.warnings.push(`Skipped the email draft: you sent the line card during the call (to ${(sentOnCall.to ?? []).join(", ")}).`);
      }
    }
    if (p.email && core.benchmark && hasBenchmark(p.email.body)) tagNote(p, RFQ_ASKED_TAG, core.summary);
    // Don't propose what the one tap already saved.
    if (it.savedStatus) p.status = null;
    // Shot down while this was building (Walt 10/5): they said no, so no callback, status change or email.
    // The note and any contacts from the call are still saved.
    const statusNow = (await d.close.lead(it.leadId).catch(() => null))?.status_label ?? lead?.status_label ?? null;
    if (isOutStatus(statusNow) && (p.tasks.length || p.status || p.email)) {
      p.tasks = [];
      p.status = null;
      p.email = null;
      it.warnings.push(`Skipped the callback, status and email: the lead is marked ${statusNow} in Close.`);
    }
    it.noTranscript = !call?.recording_transcript?.utterances?.length;
    // The transcript (or, when Close didn't make one, what the rep typed) decides the callback.
    if (it.taskId && placeholder && p.tasks.length && (!it.noTranscript || it.note)) {
      const smart = p.tasks.shift()!;
      try {
        const moved = await step(it, "update callback task", () => rewriteTask(d, it, smart));
        it.smartTask = { title: smart.title, when: moved.when, why: smart.why, changed: `${placeholder.title}|${new Date(placeholder.due_at).getTime()}` !== `${smart.title}|${new Date(moved.due_at).getTime()}` };
        it.saved = it.saved.map((x) => (x.startsWith(placeholder.title) ? `${smart.title} ${moved.when}` : x));
        it.savedTaskAt = moved.due_at;
      } catch (err) {
        p.tasks.unshift(smart); // couldn't update Close: leave it for approval instead
        it.warnings.push(`Couldn't update the callback in Close (${(err as Error).message}); it's in the list below instead.`);
      }
    }
    if (it.savedTaskAt) {
      const t0 = new Date(it.savedTaskAt).getTime();
      p.tasks = p.tasks.filter((t) => Math.abs(new Date(t.due_at).getTime() - t0) > 3 * 3600 * 1000);
    }
    reconcileAddresses(p, it.warnings);
    // The transcript is the other proof of a conversation (someone on their side spoke).
    if (call && transcript && call.duration >= 20 && call.recording_transcript?.utterances?.some((u) => u.speaker_side === "contact")) void markReached(d, it.leadId);
    it.purchasing = await purchasingP;
    if (it.purchasing && Object.keys(it.purchasing).length) await recordPurchasing(d, it.leadId, it.purchasing).catch(() => undefined);
    it.proposals = p;
    it.coaching = extras.coaching;
    it.summary = core.summary;
    it.outcomeLabel = core.outcome_label || it.outcomeLabel;
    it.callWith = p.contacts[0]?.name ?? null;
    it.warnings = [...it.warnings, ...core.warnings, ...extras.warnings];
    it.state = countItems(p) > 0 || it.summary || it.smartTask?.changed ? "ready" : "done";
    if (prev) {
      Object.assign(it, prev);
      // A "no transcript" card that a note rebuilt: it's done now, not failed.
      if (prev.state === "failed") it.state = it.smartTask?.changed ? "saved" : "done";
    } else if (config.autoSave && countItems(p) > 0) await step(it, "save to Close", () => autoSave(d, it, p));
  } catch (err) {
    it.state = "failed";
    it.error = (err as Error).message;
    alert(it, "error", `The build stopped: ${(err as Error).message}`);
  }
  // Anything skipped or suppressed becomes a visible alert on the card, never a buried warning.
  for (const w of it.warnings) if (SUPPRESSION.test(w) && !(it.alerts ?? []).some((a) => a.text === w)) alert(it, "warn", w);
  plog(it, `finished: ${it.state}${it.alerts?.length ? `, ${it.alerts.length} alert(s)` : ""}`);
  await save(it);
  await store.release(it.id);
}

/**
 * The contact and the email are written by separate passes, so a spelled-out
 * address can come back two ways ("m.mendez@" vs "mmendez@"). Use the
 * contact's version on the email too, and tell the rep to check which is right.
 */
export function reconcileAddresses(p: Proposals, warnings: string[]) {
  if (!p.email) return;
  for (const r of p.email.to) {
    // Same call, so a first-name match is enough ("Matt" → "Matt Mendez").
    const first = (n: string) => n.trim().split(/\s+/)[0].toLowerCase();
    const c = p.contacts.find((x) => x.email && (samePerson(x.name, r.name) || first(x.name) === first(r.name)));
    if (c?.email && c.email.toLowerCase() !== r.email.toLowerCase()) {
      warnings.push(`The call was unclear on ${c.name}'s email: ${c.email} or ${r.email}. Using ${c.email}; check it before sending.`);
      r.email = c.email;
      c.verify_email = true;
    }
  }
}

/** Write everything straight to Close; anything that fails stays behind for the rep to retry. */
async function autoSave(d: Deps, it: QueueItem, p: Proposals) {
  // Close contacts have no "verify" flag, so the pinned note carries it.
  const unsure = p.contacts.filter((c) => c.verify_email && c.email);
  if (unsure.length) {
    const heard = p.email?.address_as_heard ? ` (heard as "${p.email.address_as_heard}")` : "";
    const line = `Verify email spelling: ${unsure.map((c) => `${c.name} ${c.email}`).join(", ")}${heard}.`;
    p.note = p.note ? { ...p.note, text: `${p.note.text}\n${line}` } : { text: line, pinned: true };
  }
  try {
    const r = await applyProposals(d, it.leadId, p, (it.rating as never) ?? null);
    it.applied = r.results;
    const savedEmail = r.results.find((x) => x.kind === "email" && x.ok);
    if (savedEmail && it.lineCard && p.email) await recordLineCardSend(d, { leadId: it.leadId, format: it.lineCard.format, filing: it.lineCard.request.filingMethod, at: new Date().toISOString(), emailId: savedEmail.id ?? null }).catch(() => undefined);
    it.warnings.push(...r.warnings);
    for (const x of r.results) if (!x.ok) alert(it, "error", `Close rejected "${x.label}": ${x.error ?? "unknown error"}`);
    const failed = new Set(r.results.filter((x) => !x.ok).map((x) => x.kind));
    if (!failed.size) {
      it.state = "saved";
    } else {
      // Keep only what didn't save, so Approve retries just that.
      it.proposals = {
        note: failed.has("note") ? p.note : null,
        contacts: failed.has("contact") ? p.contacts.filter((c) => r.results.some((x) => !x.ok && x.label === `Contact: ${c.name}`)) : [],
        contact_updates: failed.has("contact-update") ? p.contact_updates : [],
        tasks: failed.has("task") ? p.tasks : [],
        email: failed.has("email") ? p.email : null,
        status: failed.has("status") ? p.status : null,
      };
      it.state = "ready";
    }
  } catch (err) {
    if (err instanceof DuplicateApplyError) {
      it.state = "saved"; // identical changes were just saved for this lead; nothing left to do
      it.applied = [];
      alert(it, "warn", "Skipped saving: the same note, tasks and email were saved to this lead in the last 5 minutes.");
      return;
    }
    alert(it, "error", `Couldn't save to Close: ${(err as Error).message}. Approve to retry.`);
  }
}

export function countItems(p: Proposals | null): number {
  if (!p) return 0;
  return (p.note ? 1 : 0) + p.contacts.length + (p.contact_updates?.length ?? 0) + p.tasks.length + (p.email ? 1 : 0) + (p.status ? 1 : 0);
}

// ---------- rep actions on queue items ----------

export async function approveItem(d: Deps, id: string, proposals?: Proposals) {
  const it = await getItem(d, id);
  if (it.state !== "ready") throw new QueueError("This follow-up isn't ready to approve.");
  const r = await applyProposals(d, it.leadId, proposals ?? it.proposals!, (it.rating as never) ?? null);
  it.applied = [...(it.applied ?? []), ...r.results];
  if (r.results.every((x) => x.ok)) it.state = "saved";
  await save(it);
  return r;
}

export async function approveAll(d: Deps) {
  const out: Array<{ id: string; company: string; ok: boolean; failed: number }> = [];
  for (const it of (await listQueue(d)).filter((x) => x.state === "ready")) {
    try {
      const r = await approveItem(d, it.id);
      out.push({ id: it.id, company: it.company, ok: r.results.every((x) => x.ok), failed: r.results.filter((x) => !x.ok).length });
    } catch (err) {
      out.push({ id: it.id, company: it.company, ok: false, failed: -1 });
      console.error("approve all:", (err as Error).message);
    }
  }
  return { approved: out };
}

export async function discardItem(d: Deps, id: string) {
  const it = await getItem(d, id);
  it.state = "discarded";
  await save(it);
  return { ok: true };
}

/** The rep can add a line after tapping; it's used if the build hasn't started writing yet. */
export async function noteItem(d: Deps, id: string, note: string) {
  const it = await getItem(d, id);
  const changed = (note.trim() || null) !== it.note;
  it.note = note.trim() || null;
  await save(it);
  // Already built? Read it again with the rep's words ("call back in an hour").
  if (changed && it.note && it.state !== "building") background(build(d, it, { callbackOnly: it.state === "saved" || it.state === "done" || (it.state === "failed" && !!it.noTranscript) }), "rebuild");
  return { ok: true, rebuilding: changed && !!it.note && it.state === "building" };
}

export async function rebuildItem(d: Deps, id: string) {
  const it = await getItem(d, id);
  if (it.state === "failed" && it.noTranscript && !it.note) {
    // The retry for "No transcript": check Close again; build only if it's there now.
    const call = it.callId ? await d.close.call(it.callId).catch(() => null) : null;
    if (!hasTranscript(call)) {
      it.error = `Still no transcript for this call (checked ${new Date().toLocaleTimeString("en-US", { timeZone: d.rep.timeZone, hour: "numeric", minute: "2-digit" })}). Add a note to build from what you remember.`;
      plog(it, "rebuild: still no transcript");
      await save(it);
      return it;
    }
  }
  background(build(d, it), "rebuild");
  return it;
}

export async function chatItem(d: Deps, id: string, req: { message: string; history: Array<{ role: "user" | "assistant"; text: string }> }) {
  const it = await getItem(d, id);
  const r = await leadChat(d, it.leadId, { message: req.message, history: req.history, proposals: it.proposals, rating: (it.rating as never) ?? null });
  it.proposals = r.proposals;
  it.warnings = r.warnings;
  if (it.state === "done") it.state = "ready";
  await save(it);
  return { reply: r.reply, item: it };
}

/**
 * Another format for the line card email (10/7): recomposed from the opener already written, so the transcript
 * isn't read again. A draft already in Close is updated in place.
 */
export async function setLineCardFormat(d: Deps, id: string, format: EmailFormat) {
  const it = await getItem(d, id);
  if (!it.lineCard) throw new QueueError("This call didn't ask for a line card.");
  const call = it.callId ? await d.close.call(it.callId).catch(() => null) : null;
  const transcript = transcriptText(call?.recording_transcript) ?? "";
  const r = await draftLineCardEmail(d, { leadId: it.leadId, company: it.company, transcript, req: it.lineCard.request, format, opener: it.lineCard.opener });
  it.lineCard = r.state;
  it.warnings = it.warnings.filter((w) => !/^Line card email/.test(w)).concat(r.warnings);
  if (r.email) {
    it.proposals = { ...(it.proposals ?? { note: null, contacts: [], contact_updates: [], tasks: [], status: null, email: null }), email: r.email };
    const saved = (it.applied ?? []).find((x) => x.kind === "email" && x.ok && x.id);
    if (it.state === "saved" && saved?.id) {
      const { lineCardAttachments } = await import("./assistant.js");
      const attachments = await lineCardAttachments(d).catch(() => []);
      await d.close.updateDraft(saved.id, { body: r.email.body, subject: r.email.subject, attachments });
      saved.label = `Draft email to ${r.email.to.map((x) => x.name).join(", ")} with line card (${r.state.format.replace("_", " ")})`;
      await recordLineCardSend(d, { leadId: it.leadId, format, filing: it.lineCard.request.filingMethod, at: new Date().toISOString(), emailId: saved.id }).catch(() => undefined);
    } else if (it.state === "done") it.state = "ready";
  }
  await save(it);
  return it;
}

/** The transcript for the review screen, straight from Close. */
export async function itemTranscript(d: Deps, id: string) {
  const it = await getItem(d, id);
  const call = it.callId ? await d.close.call(it.callId).catch(() => null) : null;
  return { transcript: transcriptText(call?.recording_transcript ?? call?.voicemail_transcript) || null };
}

/** Reviews still waiting on a transcript, for the webhook, the panel's refresh and the catch-up job. */
export async function waitingFor(repId: string | null) {
  const all = await store.buildingReviews<QueueItem>();
  return repId ? all.filter((it) => it.repId === repId) : all;
}

export async function reviewsForCall(callId: string) {
  return store.reviewsForCall<QueueItem>(callId);
}

/** Housekeeping: drop taps older than 8 days (Close has everything they saved). */
export async function sweep() {
  await store.deleteReviewsBefore(new Date(Date.now() - 8 * DAY).toISOString());
}
