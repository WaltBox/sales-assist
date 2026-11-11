import type { Deps } from "./assistant.js";
import { background } from "./background.js";
import type { CloseCall, CloseLead } from "./close.js";
import { onCloseEvent, type CloseEvent, type HookContext } from "./closehooks.js";
import { accountFromFacts, assembleBoard, forgetAssembled, isBounce, loadRepContext, ours, type Account, type Board, type BuiltAccount, type Email } from "./accounts.js";
import { theirFiles } from "./stats.js";
import { store, type AccountStateRow } from "./store.js";

/**
 * One record per rep and account (11/10). Close keeps the facts; the app keeps the judgment. Each record holds the
 * lead's facts as Close has them, trimmed to what the board reads (its emails, the bodies of the ones from them,
 * its calls, notes and open tasks, the lead itself), and the Account the app made of them (heat, cadence, the next
 * step). Close's webhooks bring a record up to date within seconds of a call, an email, a note or a status change;
 * the nightly reconcile rebuilds every one from a rescan. The pages read the records: the Account is worked out
 * again from the facts on each read, so what depends on the clock (touched today, due dates, the heat's days
 * since) and on the rep's own settings (holds, taps, the sequence) is right without an event.
 *
 * Before this, every board was rebuilt from a 45-day rescan of Close every ten minutes and kept as a 1–2 MB blob,
 * and nothing was live.
 */
export type FactEmail = Email;
export type FactCall = Omit<CloseCall, "recording_transcript" | "voicemail_transcript"> & { transcript?: boolean };
export type FactNote = { id: string; lead_id?: string; note: string; date_created: string; user_id?: string };
export type FactTask = { id: string; lead_id: string; text: string; date: string; date_created?: string; assigned_to?: string; is_complete?: boolean };
export type LeadFacts = {
  leadId: string; lead: CloseLead | null;
  emails: FactEmail[];
  /** The text of the emails from them (a bounce notice, a reply, an RFQ typed into the email), by email id. */
  bodies: Record<string, string>;
  calls: FactCall[]; notes: FactNote[]; tasks: FactTask[];
  /** When the facts were read from Close. */
  at: string;
};
export type RecordData = {
  v: 1; facts: LeadFacts; account: Account | null;
  built: { at: string; source: RecordSource; cardSenderId: string | null; repEmailed: boolean };
};
export type RecordSource = "rescan" | "event" | "refresh" | "reconcile";
const DAY = 86_400_000;
/** Emails this far back are kept: the board's 45 days plus the two weeks before (a line card's thread starts before the window). */
const EMAIL_DAYS = 45 + 14;
const NOTE_DAYS = 45 + 3;
const CALL_DAYS = 45 + 3;
const BODY_CHARS = 2500;
const NOTE_CHARS = 1500;

// ---------- the facts: what's kept of what Close has ----------

const at = (e: { date_sent?: string | null; date_created?: string | null }) => e.date_sent ?? e.date_created ?? "";
const trimEmail = (e: Record<string, unknown>): FactEmail => ({
  id: String(e.id), lead_id: String(e.lead_id ?? ""), user_id: typeof e.user_id === "string" ? e.user_id : undefined,
  status: String(e.status ?? ""), direction: String(e.direction ?? ""), subject: (e.subject as string | null) ?? null,
  date_sent: (e.date_sent as string | null) ?? null, date_created: (e.date_created as string | null) ?? null,
  opens: Array.isArray(e.opens) ? (e.opens as Array<{ opened_at: string; opened_by: string | null; user_agent?: string | null }>).map((o) => ({ opened_at: o.opened_at, opened_by: o.opened_by ?? null, user_agent: o.user_agent ?? null })) : null,
  thread_id: (e.thread_id as string | null) ?? null, sender: (e.sender as string | null) ?? null, to: Array.isArray(e.to) ? (e.to as string[]) : null,
  contact_id: (e.contact_id as string | null) ?? null,
  attachments: Array.isArray(e.attachments) ? (e.attachments as Array<{ filename?: string; content_type?: string }>).map((a) => ({ filename: a.filename, content_type: a.content_type })) : undefined,
});
const trimCall = (c: CloseCall): FactCall => {
  const { recording_transcript, voicemail_transcript, ...rest } = c;
  const has = !!(recording_transcript?.utterances?.length || voicemail_transcript?.utterances?.length);
  return { ...rest, note: rest.note ? rest.note.slice(0, 600) : rest.note ?? null, ...(recording_transcript !== undefined || voicemail_transcript !== undefined ? { transcript: has } : {}) };
};
const trimLead = (l: CloseLead | null): CloseLead | null => {
  if (!l) return null;
  const { description: _d, ...rest } = l;
  return { ...rest, description: null };
};

/**
 * A lead's facts from what's at hand: the rescan's bulk lists sliced to the lead, or the lead's own activity read
 * from Close. Emails, notes and calls outside the window are dropped; note text and email bodies are capped.
 */
export function leadFacts(x: {
  leadId: string; lead: CloseLead | null; emails: Array<Record<string, unknown>>; bodies?: Record<string, string>;
  notes: Array<{ id: string; lead_id?: string; note: string; date_created: string; user_id?: string }>; tasks: Array<Record<string, unknown>>; calls: CloseCall[]; at: Date;
}): LeadFacts {
  const now = x.at.getTime();
  const emails = x.emails.map(trimEmail).filter((e) => Date.parse(at(e)) >= now - EMAIL_DAYS * DAY || !at(e)).sort((a, b) => at(b).localeCompare(at(a)));
  const keep = new Set(emails.map((e) => e.id));
  const bodies: Record<string, string> = {};
  for (const [id, body] of Object.entries(x.bodies ?? {})) if (keep.has(id)) bodies[id] = (body ?? "").slice(0, BODY_CHARS);
  // Bodies from the emails themselves (a per-lead read carries them): the ones from them, not ours.
  for (const e of x.emails) if (e.direction === "incoming" && typeof e.body_text === "string" && keep.has(String(e.id)) && !(String(e.id) in bodies)) bodies[String(e.id)] = e.body_text.slice(0, BODY_CHARS);
  return {
    leadId: x.leadId, lead: trimLead(x.lead), emails, bodies,
    calls: x.calls.filter((c) => Date.parse(c.date_created) >= now - CALL_DAYS * DAY).map(trimCall).sort((a, b) => b.date_created.localeCompare(a.date_created)),
    notes: x.notes.filter((n) => Date.parse(n.date_created) >= now - NOTE_DAYS * DAY).map((n) => ({ id: n.id, note: n.note.slice(0, NOTE_CHARS), date_created: n.date_created, ...(n.user_id ? { user_id: n.user_id } : {}) })).sort((a, b) => b.date_created.localeCompare(a.date_created)),
    tasks: x.tasks.filter((t) => t.is_complete !== true).map((t) => ({ id: String(t.id), lead_id: String(t.lead_id ?? x.leadId), text: String(t.text ?? ""), date: String(t.date ?? ""), ...(t.date_created ? { date_created: String(t.date_created) } : {}), ...(t.assigned_to ? { assigned_to: String(t.assigned_to) } : {}) })),
    at: x.at.toISOString(),
  };
}

/**
 * One lead's facts from Close: the lead, its emails (with their text), calls, notes and open tasks. Five reads.
 * `light`: the lead and its calls only (a call on a lead that isn't on this rep's board, where the rest isn't needed);
 * the rest is kept from `keep` when there is one.
 */
export async function fetchLeadFacts(d: Deps, leadId: string, opts: { light?: boolean; keep?: LeadFacts | null } = {}): Promise<LeadFacts> {
  const now = d.now?.() ?? new Date();
  const since = new Date(now.getTime() - CALL_DAYS * DAY).toISOString();
  const [lead, emails, calls, notes, tasks] = await Promise.all([
    d.close.lead(leadId),
    opts.light ? Promise.resolve(null) : d.close.leadEmails(leadId),
    d.close.calls({ leadId, since, withTranscripts: false, max: 300 }),
    opts.light ? Promise.resolve(null) : d.close.notes(leadId, 100),
    opts.light ? Promise.resolve(null) : d.close.openTasks(leadId),
  ]);
  const k = opts.keep;
  return leadFacts({
    leadId, lead, at: now, calls,
    emails: emails ? (emails as unknown as Array<Record<string, unknown>>).map((e) => ({ ...e, lead_id: e.lead_id ?? leadId })) : (k?.emails ?? []) as unknown as Array<Record<string, unknown>>,
    bodies: emails ? undefined : k?.bodies,
    notes: notes ? notes.map((n) => ({ ...n, lead_id: leadId })) : k?.notes ?? [],
    tasks: tasks ? (tasks as unknown as Array<Record<string, unknown>>) : (k?.tasks ?? []) as unknown as Array<Record<string, unknown>>,
  });
}

// ---------- the records: reading and writing ----------

const rowOf = (d: Deps, facts: LeadFacts, built: BuiltAccount | null, source: RecordSource): AccountStateRow => ({
  repId: d.rep.closeUserId, leadId: facts.leadId, company: facts.lead?.display_name ?? built?.account.company ?? null,
  updatedAt: new Date().toISOString(), suspect: false,
  data: { v: 1, facts, account: built?.account ?? null, built: { at: new Date().toISOString(), source, cardSenderId: built?.cardSenderId ?? null, repEmailed: built?.repEmailed ?? false } } satisfies RecordData,
});
const dataOf = (row: AccountStateRow | null | undefined): RecordData | null => {
  const v = row?.data as RecordData | null | undefined;
  return v && v.v === 1 && v.facts ? v : null;
};

/**
 * A rep's records as this server last read them, brought up to date with one small read: only the rows written
 * since the last look. A full read every few minutes, or when nothing is held.
 */
type RecordsMem = { at: number; fullAt: number; since: string; rows: Map<string, AccountStateRow> };
const recordsMem = new Map<string, RecordsMem>();
const RECORDS_FRESH_MS = 3_000;
const RECORDS_FULL_MS = 10 * 60_000;
export async function recordsFor(d: Deps): Promise<Map<string, AccountStateRow>> {
  const repId = d.rep.closeUserId;
  const mem = recordsMem.get(repId);
  if (mem && Date.now() - mem.at < RECORDS_FRESH_MS) return mem.rows;
  if (!mem || Date.now() - mem.fullAt > RECORDS_FULL_MS) {
    const rows = await store.listAccountStates(repId);
    const map = new Map(rows.map((r) => [r.leadId, r]));
    const since = rows.map((r) => r.updatedAt).sort().pop() ?? new Date(0).toISOString();
    recordsMem.set(repId, { at: Date.now(), fullAt: Date.now(), since, rows: map });
    return map;
  }
  // Rows written since the last look, with a few seconds' slack for another server's clock.
  const changed = await store.listAccountStates(repId, { since: new Date(Date.parse(mem.since) - 5_000).toISOString() });
  for (const r of changed) mem.rows.set(r.leadId, r);
  mem.since = changed.map((r) => r.updatedAt).sort().pop() ?? mem.since;
  mem.at = Date.now();
  return mem.rows;
}
export function forgetRecords(repId: string) { recordsMem.delete(repId); }
function remember(row: AccountStateRow) {
  const mem = recordsMem.get(row.repId);
  if (mem) mem.rows.set(row.leadId, row);
}

/** One record, as last written: for the side panel's call state, the West Game. */
export async function recordFor(d: Deps, leadId: string): Promise<RecordData | null> {
  const mem = recordsMem.get(d.rep.closeUserId);
  const held = mem && Date.now() - mem.at < RECORDS_FRESH_MS ? mem.rows.get(leadId) : null;
  return dataOf(held ?? (await store.getAccountState(d.rep.closeUserId, leadId)));
}

/**
 * The board from the records: each lead's account worked out again from its facts, with the rep's settings as
 * they are now, then assembled. Null when the rep has no records yet (a rescan makes them).
 */
export async function boardFromRecords(d: Deps): Promise<Board | null> {
  // The records stand for the board only once a rescan has written them all: before that a lone record (a dial on a
  // lead, a tap) would read as a board with nothing on it.
  if (!(await reconciledAt(d.rep.closeUserId))) return null;
  const rows = await recordsFor(d);
  if (!rows.size) return null;
  const ctx = await loadRepContext(d);
  const built: BuiltAccount[] = [];
  const openTasks: Array<{ lead_id: string; date: string }> = [];
  for (const row of rows.values()) {
    const data = dataOf(row);
    if (!data) continue;
    const b = accountFromFacts(d, data.facts, ctx);
    if (!b) continue;
    built.push(b);
    for (const t of data.facts.tasks) if (!t.assigned_to || t.assigned_to === d.rep.closeUserId) openTasks.push({ lead_id: t.lead_id, date: t.date });
  }
  return assembleBoard(d, built, ctx, { openTasks });
}

/**
 * One lead's record from Close now: its facts read, its account built, the row written. `light` reads only the
 * lead and its calls when the lead isn't on this rep's board (a dial on a fresh prospect), and keeps the rest.
 */
const rebuilding = new Map<string, Promise<BuiltAccount | null>>();
export async function rebuildRecord(d: Deps, leadId: string, source: RecordSource, opts: { light?: boolean } = {}): Promise<BuiltAccount | null> {
  const key = `${d.rep.closeUserId}:${leadId}`;
  const running = rebuilding.get(key);
  if (running) return running;
  const p = (async () => {
    const have = dataOf(await store.getAccountState(d.rep.closeUserId, leadId).catch(() => null));
    const light = !!opts.light && !have?.account;
    const facts = await fetchLeadFacts(d, leadId, { light, keep: have?.facts ?? null });
    const ctx = await loadRepContext(d);
    const built = accountFromFacts(d, facts, ctx);
    const row = rowOf(d, facts, built, source);
    await store.putAccountState(row);
    remember(row);
    forgetAssembled(d.rep.closeUserId);
    return built;
  })().finally(() => { if (rebuilding.get(key) === p) rebuilding.delete(key); });
  rebuilding.set(key, p);
  return p;
}

/** A record an event couldn't bring up to date: marked, so the reconcile does it first. */
async function markSuspect(repId: string, leadId: string) {
  const row = await store.getAccountState(repId, leadId).catch(() => null);
  if (row && !row.suspect) await store.putAccountState({ ...row, suspect: true, updatedAt: new Date().toISOString() }).catch(() => undefined);
}

/**
 * After a rescan: every lead's record written, and this rep's records for leads the rescan didn't find dropped
 * (handed away, or fallen out of the window) along with records that never made an account and are days old.
 */
export async function saveRescan(d: Deps, records: Array<{ facts: LeadFacts; built: BuiltAccount | null }>, source: RecordSource) {
  const repId = d.rep.closeUserId;
  const have = new Map((await store.listAccountStates(repId, { select: "meta" }).catch(() => [])).map((r) => [r.leadId, r]));
  const found = new Set<string>();
  let written = 0;
  for (const r of records) {
    found.add(r.facts.leadId);
    const row = rowOf(d, r.facts, r.built, source);
    await store.putAccountState(row);
    remember(row);
    written++;
  }
  let dropped = 0;
  for (const [leadId, row] of have) {
    if (found.has(leadId)) continue;
    // A record with no account (a dial on a lead that never got a line card) is kept two days for the call state.
    const data = dataOf(row);
    const old = Date.now() - Date.parse(row.updatedAt) > 2 * DAY;
    if (data?.account || old || !data) { await store.deleteAccountState(repId, leadId).catch(() => undefined); dropped++; }
  }
  forgetRecords(repId);
  await store.putSetting(repId, "recordsReconciledAt", new Date().toISOString()).catch(() => undefined);
  console.info(`${new Date().toISOString()} [records ${d.rep.email}] ${source}: ${written} written, ${dropped} dropped`);
  return { written, dropped };
}

/** When this rep's records were last rebuilt from a rescan. */
export async function reconciledAt(repId: string): Promise<string | null> {
  return store.getSetting<string>(repId, "recordsReconciledAt").catch(() => null);
}

// ---------- events: a change on a lead brings its records up to date ----------

/** Bursts on one lead (a call's created, answered, completed, and the note) are one rebuild, a moment after the last. */
const COALESCE_MS = 1_500;
type Pending = { timer: NodeJS.Timeout; done: Promise<void>; resolve: () => void; light: boolean; run: () => void };
const pending = new Map<string, Pending>();
export function scheduleRebuild(d: Deps, leadId: string, opts: { light?: boolean } = {}): Promise<void> {
  const key = `${d.rep.closeUserId}:${leadId}`;
  const was = pending.get(key);
  if (was) {
    clearTimeout(was.timer);
    was.light = was.light && !!opts.light;
    was.timer = setTimeout(was.run, COALESCE_MS);
    return was.done;
  }
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const entry: Pending = {
    timer: null as unknown as NodeJS.Timeout, done, resolve, light: !!opts.light,
    run: () => {
      pending.delete(key);
      rebuildRecord(d, leadId, "event", { light: entry.light })
        .catch(async (e) => { console.error(`[record ${leadId}]`, (e as Error).message); await markSuspect(d.rep.closeUserId, leadId); })
        .finally(() => entry.resolve());
    },
  };
  entry.timer = setTimeout(entry.run, COALESCE_MS);
  pending.set(key, entry);
  return done;
}
/** Tests: run everything waiting now. */
export async function flushRebuilds() {
  const all = [...pending.values()];
  for (const p of all) { clearTimeout(p.timer); p.run(); }
  await Promise.all(all.map((p) => p.done));
}

/** The Close user a lead's "Lead owner" field names, when an event carries it. */
const ownerIn = (data: Record<string, unknown> | null, fieldId: string | null) => (fieldId && typeof data?.[`custom.${fieldId}`] === "string" ? (data![`custom.${fieldId}`] as string) : null);

/**
 * What an event does to the records: every rep who has the lead gets theirs rebuilt, and so does the rep whose Close
 * user acted (a dial on a lead not on anyone's board makes a light record for the call state). A draft, a typed
 * "Say" note and a note autosave do nothing.
 */
export async function accountEvent(ev: CloseEvent, ctx: HookContext): Promise<string | void> {
  if (!ev.leadId) return;
  if (ev.objectType === "activity.email" && (ev.data?.status === "draft" || ev.data?.status === "outbox")) return "draft";
  if (ev.objectType === "activity.note" && typeof ev.data?.note === "string" && /^(Opener:|\[Said on the call\])/.test(ev.data.note)) return "a Say line";
  if (ev.objectType === "activity.call" && ev.action === "updated" && ev.changedFields.length && ev.changedFields.every((f) => f === "note" || f === "date_updated")) return "note autosave";
  const rows = await store.accountStatesForLead(ev.leadId).catch(() => [] as AccountStateRow[]);
  const onBoard = new Set(rows.filter((r) => dataOf(r)?.account).map((r) => r.repId));
  const reps = new Set(rows.map((r) => r.repId));
  if (ev.userId) reps.add(ev.userId);
  // A hand-off (Lead owner changed in Close): the new owner's record too, so it shows on their board at once.
  if (ev.objectType === "lead") {
    const fieldId = await store.getSetting<string>("team", "leadOwnerFieldId").catch(() => null);
    const owner = ownerIn(ev.data, fieldId);
    if (owner) reps.add(owner);
  }
  const todo: Array<Promise<void>> = [];
  const names: string[] = [];
  for (const repId of reps) {
    const d = await ctx.depsForUser(repId);
    if (!d) continue;
    // Someone not on this lead's boards: a light record (the lead and its calls) unless it's an email, a note or a
    // status change, which may put the lead on their board.
    const light = !onBoard.has(repId) && (ev.objectType === "activity.call" || ev.objectType.startsWith("task."));
    todo.push(scheduleRebuild(d, ev.leadId, { light }));
    names.push(`${d.rep.name.split(/\s+/)[0]}${light ? " (light)" : ""}`);
  }
  await Promise.all(todo);
  return names.length ? `rebuilt for ${names.join(", ")}` : "nobody in the app";
}
onCloseEvent("records", accountEvent);

// ---------- the nightly reconcile ----------

/**
 * Every record of a rep rebuilt from a rescan (the board's full read of Close), once a day, so a missed event or a
 * Close change the feed doesn't carry is caught up by morning. Also what a `fresh` read does.
 */
export async function reconcileAccounts(d: Deps, opts: { force?: boolean } = {}): Promise<{ ran: boolean; written?: number }> {
  const last = await reconciledAt(d.rep.closeUserId);
  if (!opts.force && last && Date.now() - Date.parse(last) < 20 * 3600_000) return { ran: false };
  if (!(await store.once(`reconcile:${d.rep.closeUserId}`, 30 * 60_000).catch(() => true))) return { ran: false };
  const { accountsBoard } = await import("./accounts.js");
  const board = await accountsBoard(d, { fresh: true });
  return { ran: true, written: board.accounts.length };
}

/** Whether an incoming email looks like it came from the buyer (not us, not a bounce), for the sinks that read emails. */
export const fromThem = (d: Deps, e: { sender?: string | null; subject?: string | null }) => !ours(d)(e.sender) && !isBounce(e);
export { theirFiles };
