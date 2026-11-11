import { cachedBoard } from "./accounts.js";
import type { Deps } from "./assistant.js";
import { background } from "./background.js";
import { onCloseEvent } from "./closehooks.js";
import { dialQuery, dialViewName } from "./dialviews.js";
import { loadCallSignals } from "./heat.js";
import { rungIndex, rungOfStatus, type Buyer, type Stage } from "./ladder.js";
import { myLeads, ownerFieldId, type MyLead } from "./myleads.js";
import { localParts } from "./rules.js";
import { localDay } from "./stats.js";
import { store } from "./store.js";

/**
 * The dial queue (Walt 11/11: "switching between leads they are working and leads that are left blank", after a
 * morning of 18 voicemails in 20 calls). Four piles from the rep's own leads in Close, dealt in a rhythm so a block
 * is mostly calls that have shown they get picked up, with discovery a third of it at most:
 *
 *   buyer      a named buyer with a direct line or email, no conversation this week: ask for them by name
 *   follow-up  a callback due, an RFQ they promised, a reply to answer, a card to follow up on
 *   discovery  a fit (A or B) with no buyer yet: get the name
 *   quick win  no phone needed: a card to a buyer named yesterday, a name off a voicemail greeting to confirm
 *
 * A voicemail breaker: two mailboxes in a row and the next card is a company that has picked up before; three
 * discovery calls with no human and the next is a quick win. Each company's answered hours come from its own
 * calls, so a company is served when it has picked up before. The order is written to Close as queue_rank and
 * queue_why on the lead, so "My queue" in Close is the same list, and the side panel's Next up opens the next one.
 */
export type Pile = "buyer" | "followup" | "discovery" | "quick";
export type QueueCard = {
  leadId: string; company: string; pile: Pile; rank: number;
  /** A few words for the lead in Close and the panel: "Ron, buyer call", "callback 10:30", "discovery", "card went Tue, follow up". */
  why: string;
  buyer: Buyer | null; stage: Stage; tier: string | null; state: string | null;
  /** When it's due (a follow-up), or null. */
  due: string | null;
  /** The local hour this company has picked up at before, most often; null when it never has. */
  bestHour: number | null;
  /** No phone needed (a card to send, a name to confirm). */
  noPhone: boolean;
};
export type DialQueue = { at: string; repId: string; window: Window; cards: QueueCard[]; piles: Record<Pile, number>; skipped: { out: number; calledToday: number; needsName: number } };
type Window = "morning" | "midday" | "afternoon" | "late";

const DAY = 86_400_000;
const GULF = new Set(["TX", "LA", "OK", "NM", "MS", "AL", "AR"]);
/** The deal, by the time of day: buyer-heavy early, follow-ups after lunch, quick wins and discovery in the last hour. */
export const DEAL: Record<Window, Pile[]> = {
  morning: ["buyer", "followup", "buyer", "discovery", "discovery", "buyer", "quick", "followup", "discovery", "buyer"],
  midday: ["followup", "buyer", "discovery", "buyer", "followup", "discovery", "quick", "buyer", "discovery", "followup"],
  afternoon: ["followup", "buyer", "followup", "discovery", "quick", "buyer", "followup", "discovery", "discovery", "buyer"],
  late: ["quick", "discovery", "quick", "discovery", "buyer", "followup", "discovery", "discovery"],
};
export const windowAt = (hour: number): Window => (hour < 10 ? "morning" : hour < 13 ? "midday" : hour < 15 ? "afternoon" : "late");
const QUEUE_MAX = 60;

/** A greeting name the app took off a voicemail, kept per rep until the contact is confirmed. */
export type GreetingName = { name: string; at: string; callId: string; contactId: string | null };
const GREETINGS_KEY = "greetingNames";
export async function greetingNames(repId: string): Promise<Record<string, GreetingName>> {
  return (await store.getSetting<Record<string, GreetingName>>(repId, GREETINGS_KEY).catch(() => null)) ?? {};
}

const mode = (xs: number[]) => { const c = new Map<number, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Where a lead is on the ladder from what My leads knows: the status, the buyer, the card. */
export function stageOf(l: Pick<MyLead, "status" | "buyer" | "cardSentAt" | "tier">): Stage {
  const status = rungOfStatus(l.status);
  if (status === "out" || l.tier === "Avoid") return "out";
  let stage: Stage = status ?? (l.tier && l.tier !== "Unknown" ? "fit" : "potential");
  const facts: Stage = l.buyer && l.cardSentAt ? "card" : l.buyer ? "named" : "potential";
  if (rungIndex(facts) > rungIndex(stage)) stage = facts;
  return stage;
}

/**
 * The queue, built from the rep's leads: My leads (status, buyer, calls, the card), the board (replies, heat), the
 * call signals (promises), tasks due, and the greeting names. No Close reads of its own beyond those.
 */
export async function buildQueue(d: Deps, opts: { now?: Date } = {}): Promise<DialQueue> {
  const now = opts.now ?? d.now?.() ?? new Date();
  const tz = d.rep.timeZone;
  const hour = localParts(now, tz).hour;
  const today = localDay(tz, now).day;
  const [mine, board, signals, greetings] = await Promise.all([myLeads(d), cachedBoard(d).catch(() => null), loadCallSignals(d.rep.closeUserId), greetingNames(d.rep.closeUserId)]);
  const acct = new Map((board?.accounts ?? []).map((a) => [a.leadId, a]));
  const piles: Record<Pile, QueueCard[]> = { buyer: [], followup: [], discovery: [], quick: [] };
  const skipped = { out: 0, calledToday: 0, needsName: 0 };
  const card = (l: MyLead, pile: Pile, why: string, extra: Partial<QueueCard> = {}): QueueCard => ({
    leadId: l.leadId, company: l.company, pile, rank: 0, why, buyer: l.buyer, stage: stageOf(l), tier: l.tier, state: l.state, due: null,
    bestHour: mode(l.answeredHours), noPhone: false, ...extra,
  });
  for (const l of mine.leads) {
    const stage = stageOf(l);
    if (stage === "out" || rungIndex(stage) >= rungIndex("rfq")) { skipped.out++; continue; }
    const a = acct.get(l.leadId);
    const first = l.buyer?.name.split(/\s+/)[0] ?? null;
    const g = greetings[l.leadId];
    // Follow-ups first: what's owed today.
    if (l.task && l.task.due.slice(0, 10) <= today) { piles.followup.push(card(l, "followup", `callback ${l.task.overdue ? "overdue" : new Date(l.task.due).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`, { due: l.task.due })); continue; }
    const promised = (signals[l.leadId] ?? []).filter((s) => s.promised).map((s) => s.at).sort().at(-1) ?? null;
    if (promised && !l.calledToday) { piles.followup.push(card(l, "followup", `${first ?? "they"} promised an RFQ ${shortDay(promised)}: get it`, { due: promised })); continue; }
    if (a?.next.kind === "reply" && !l.calledToday) { piles.followup.push(card(l, "followup", `${first ?? "they"} wrote back: answer`, { due: a.lastReplyAt ?? null })); continue; }
    if (l.calledToday) { skipped.calledToday++; continue; }
    if (stage === "named" || stage === "card" || stage === "reached") {
      if (!l.buyer) { skipped.needsName++; continue; }
      // A conversation this week: let it breathe (the follow-up is the promise or the card, above).
      if (l.lastCall?.talked && now.getTime() - Date.parse(l.lastCall.at) < 7 * DAY) continue;
      if (stage === "named" && !l.cardSentAt) { piles.quick.push(card(l, "quick", `send ${first} the card`, { noPhone: true })); continue; }
      const cardAge = l.cardSentAt ? Math.floor((now.getTime() - Date.parse(l.cardSentAt)) / DAY) : null;
      const why = cardAge !== null && cardAge <= 3 ? `card went ${shortDay(l.cardSentAt!)}, ${first}: follow up` : `${first}, buyer call`;
      piles.buyer.push(card(l, "buyer", why));
      continue;
    }
    if (stage === "fit" || stage === "potential") {
      if (g && !l.buyer) { piles.quick.push(card(l, "quick", `${g.name.split(/\s+/)[0]} from the greeting: confirm the line`, { noPhone: true })); continue; }
      if (stage === "fit" && (!l.tier || l.tier === "A" || l.tier === "B")) piles.discovery.push(card(l, "discovery", "discovery: get the name"));
      continue;
    }
  }
  // Inside the piles.
  piles.followup.sort((x, y) => (x.due ?? "").localeCompare(y.due ?? ""));
  const heat = (c: QueueCard) => acct.get(c.leadId)?.heat?.score ?? 0;
  const picksUpNow = (c: QueueCard) => (c.bestHour !== null && Math.abs(c.bestHour - hour) <= 1 ? 1 : 0);
  piles.buyer.sort((x, y) => picksUpNow(y) - picksUpNow(x) || heat(y) - heat(x) || (y.tier === "A" ? 1 : 0) - (x.tier === "A" ? 1 : 0));
  const leadOf = new Map(mine.leads.map((l) => [l.leadId, l]));
  const reachable = (c: QueueCard) => { const l = leadOf.get(c.leadId)!; return l.answeredHours.length ? 2 : l.voicemails >= 2 ? 0 : 1; };
  piles.discovery.sort((x, y) => (x.tier === "A" ? 0 : 1) - (y.tier === "A" ? 0 : 1) || reachable(y) - reachable(x) || Number(GULF.has(y.state ?? "")) - Number(GULF.has(x.state ?? "")));
  piles.quick.sort((x, y) => (x.noPhone ? 0 : 1) - (y.noPhone ? 0 : 1));
  // The deal.
  const window = windowAt(hour);
  const pattern = DEAL[window];
  const cards: QueueCard[] = [];
  for (let i = 0; cards.length < QUEUE_MAX && Object.values(piles).some((p) => p.length); i++) {
    const want = pattern[i % pattern.length];
    const from = piles[want].length ? want : (["followup", "buyer", "discovery", "quick"] as Pile[]).find((p) => piles[p].length)!;
    cards.push(piles[from].shift()!);
  }
  cards.forEach((c, i) => { c.rank = i + 1; });
  const counts = { buyer: 0, followup: 0, discovery: 0, quick: 0 } as Record<Pile, number>;
  for (const c of cards) counts[c.pile]++;
  return { at: now.toISOString(), repId: d.rep.closeUserId, window, cards, piles: counts, skipped };
}

// ---------- what's next, with the voicemail breaker ----------

/** Today's calls as the feed reported them (race.ts keeps the tally): lead, when, a mailbox or a person. */
type TodayCall = { at: string; leadId?: string; reached?: boolean; vm?: boolean };
async function todaysCalls(d: Deps): Promise<TodayCall[]> {
  const told = await store.getSetting<{ day: string; calls: Record<string, TodayCall> }>(d.rep.closeUserId, "callsToday").catch(() => null);
  if (!told || told.day !== localDay(d.rep.timeZone, d.now?.() ?? new Date()).day) return [];
  return Object.values(told.calls).sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The next card: the first not called today, unless the last two calls were mailboxes (then a company that has
 * picked up before, or a follow-up) or the last three were discovery with no human (then a quick win).
 */
export async function nextUp(d: Deps, queue?: DialQueue): Promise<{ card: QueueCard | null; breaker: "mailboxes" | "no human" | null; left: number }> {
  const q = queue ?? await cachedQueue(d);
  const calls = await todaysCalls(d);
  const called = new Set(calls.map((c) => c.leadId).filter(Boolean));
  const left = q.cards.filter((c) => !called.has(c.leadId));
  const last = calls.slice(-3);
  const byLead = new Map(q.cards.map((c) => [c.leadId, c]));
  const mailboxes = last.length >= 2 && last.slice(-2).every((c) => c.vm && !c.reached);
  const noHuman = last.length >= 3 && last.every((c) => !c.reached && (byLead.get(c.leadId ?? "")?.pile === "discovery"));
  if (mailboxes) {
    const pick = left.find((c) => c.pile === "followup" || (c.pile === "buyer" && c.bestHour !== null)) ?? left.find((c) => c.pile !== "discovery") ?? left[0] ?? null;
    return { card: pick, breaker: "mailboxes", left: left.length };
  }
  if (noHuman) {
    const pick = left.find((c) => c.pile === "quick") ?? left.find((c) => c.pile !== "discovery") ?? left[0] ?? null;
    return { card: pick, breaker: "no human", left: left.length };
  }
  return { card: left[0] ?? null, breaker: null, left: left.length };
}

const QUEUE_MS = 5 * 60_000;
const queueMem = new Map<string, { at: number; value: DialQueue }>();
/** The rep's queue as last built, rebuilt every few minutes or when something changed. */
export async function cachedQueue(d: Deps, opts: { fresh?: boolean } = {}): Promise<DialQueue> {
  const key = d.rep.closeUserId;
  const hit = queueMem.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < QUEUE_MS) return hit.value;
  const value = await buildQueue(d);
  queueMem.set(key, { at: Date.now(), value });
  return value;
}
export function forgetQueue(repId: string) { queueMem.delete(repId); }
/** Where one lead sits in the queue, and what's after it: for the side panel. */
export async function queueSpot(d: Deps, leadId: string) {
  const q = await cachedQueue(d);
  const here = q.cards.find((c) => c.leadId === leadId) ?? null;
  const next = await nextUp(d, q);
  const after = next.card && next.card.leadId !== leadId ? next.card : q.cards.find((c) => c.rank > (here?.rank ?? 0) && c.leadId !== leadId) ?? null;
  return { here: here ? { rank: here.rank, why: here.why, pile: here.pile, of: q.cards.length } : null, next: after ? { leadId: after.leadId, company: after.company, why: after.why, pile: after.pile } : null, breaker: next.breaker, left: next.left, window: q.window };
}

// ---------- names off voicemail greetings ----------

/** "Your call has been forwarded to the voicemail for Ron Sturm", "This is Joseph Wolantoski at Marlo", "Transferring to Tyler Emery". */
const GREETING_PATTERNS = [
  /voice ?mail(?: box)? (?:for|of) ([A-Z][a-z]+(?: [A-Z][a-z'-]+)?)/,
  /(?:you(?:'ve| have) reached|this is|hi,? (?:it's|this is)|hello,? (?:it's|this is)) ([A-Z][a-z]+ [A-Z][a-z'-]+)(?= at | with |[.,]| and | i'm | i am )/i,
  /transferr?ing(?: you)? to ([A-Z][a-z]+ [A-Z][a-z'-]+)/,
  /([A-Z][a-z]+ [A-Z][a-z'-]+)(?:'s| is) (?:not available|unavailable|away from (?:his|her|the) desk)/,
];
const NOT_A_NAME = /^(Thank You|Please Leave|Good Morning|Good Afternoon|Main Office|Front Desk|Customer Service|Westgate Supply|Walt Boxwell|Chase Bent|Liam Sullivan|Jacob Lizarraga)$/i;
/** The person's name a greeting names, from the transcript's non-rep side; null when there isn't one we trust. */
export function greetingName(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  for (const p of GREETING_PATTERNS) {
    const m = p.exec(t);
    if (!m) continue;
    const name = m[1].trim().split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    if (NOT_A_NAME.test(name) || name.split(" ").length > 3) continue;
    return name;
  }
  return null;
}

/**
 * A call that ended in a mailbox: read the greeting from the transcript, and if it names a person the lead doesn't
 * have yet, write them to Close as a contact ("from the voicemail greeting, not yet confirmed") and remember them
 * for the queue, so tomorrow's call asks for them by name instead of "purchasing".
 */
export async function captureGreeting(d: Deps, call: { id: string; lead_id: string; disposition?: string | null; duration?: number | null }): Promise<string | null> {
  const vm = (call.disposition ?? "").startsWith("vm") || ((call.disposition === "answered") && (call.duration ?? 0) <= 240);
  if (!vm) return null;
  const full = await d.close.call(call.id).catch(() => null);
  if (!full) return null;
  const theirs = (full.recording_transcript?.utterances ?? []).filter((u) => u.speaker_side !== "close-user").map((u) => u.text).join(" ");
  const text = [theirs, (full.voicemail_transcript?.utterances ?? []).map((u) => u.text).join(" ")].join(" ");
  const name = greetingName(text);
  if (!name) return null;
  const have = await greetingNames(d.rep.closeUserId);
  if (have[call.lead_id]?.name === name) return null;
  const lead = await d.close.lead(call.lead_id).catch(() => null);
  if (!lead) return null;
  const known = (lead.contacts ?? []).some((c) => c.name && c.name.toLowerCase() === name.toLowerCase());
  let contactId: string | null = null;
  if (!known) contactId = (await d.close.createContact(call.lead_id, { name, title: "From the voicemail greeting (not yet confirmed)", email: null, phone: null }).catch(() => null))?.id ?? null;
  await store.putSetting(d.rep.closeUserId, GREETINGS_KEY, { ...have, [call.lead_id]: { name, at: new Date().toISOString(), callId: call.id, contactId } });
  forgetQueue(d.rep.closeUserId);
  return name;
}

onCloseEvent("greetings", async (ev, ctx) => {
  if (ev.objectType !== "activity.call" || ev.action !== "completed" || !ev.userId || !ev.leadId) return;
  const d = await ctx.depsForUser(ev.userId);
  if (!d) return;
  const c = ev.data as { id?: string; disposition?: string; duration?: number; direction?: string } | null;
  if (c?.direction && c.direction !== "outbound") return;
  const name = await captureGreeting(d, { id: c?.id ?? ev.objectId ?? "", lead_id: ev.leadId, disposition: c?.disposition, duration: c?.duration });
  return name ? `greeting named ${name}` : undefined;
});
// Anything on one of the rep's leads changes the order: the next read builds it again.
onCloseEvent("queue", async (ev, ctx) => {
  if (!ev.userId) return;
  const d = await ctx.depsForUser(ev.userId);
  if (d) forgetQueue(d.rep.closeUserId);
});

// ---------- the queue in Close: queue_rank and queue_why on the lead, and "My queue" ----------

export const QUEUE_FIELDS = { rank: "queue_rank", why: "queue_why" } as const;
type QueueFieldIds = { rank: string; why: string };
async function queueFieldIds(d: Deps): Promise<QueueFieldIds> {
  const saved = await store.getSetting<QueueFieldIds>("team", "queueFieldIds").catch(() => null);
  if (saved?.rank && saved.why) return saved;
  const fields = await d.close.leadCustomFields();
  const find = (name: string) => fields.find((f) => f.name.trim().toLowerCase() === name)?.id ?? null;
  const rank = find(QUEUE_FIELDS.rank) ?? (await d.close.createLeadCustomField({ name: QUEUE_FIELDS.rank, type: "number" })).id;
  const why = find(QUEUE_FIELDS.why) ?? (await d.close.createLeadCustomField({ name: QUEUE_FIELDS.why, type: "text" })).id;
  const ids = { rank, why };
  await store.putSetting("team", "queueFieldIds", ids).catch(() => undefined);
  return ids;
}
const SYNC_MAX = 40;
/**
 * Write the day's order onto the leads in Close (the top of the queue gets queue_rank 1, 2, 3… and a few words of
 * why) and keep "My queue" pointing at them, in rank order. Leads ranked last time and not now are cleared. One
 * write per lead that changed; the rest is left alone.
 */
export async function syncQueue(d: Deps, opts: { queue?: DialQueue } = {}): Promise<{ written: number; cleared: number; view: string | null }> {
  const q = opts.queue ?? await cachedQueue(d, { fresh: true });
  const ids = await queueFieldIds(d);
  const key = "queueWritten";
  const before = (await store.getSetting<Record<string, { rank: number; why: string }>>(d.rep.closeUserId, key).catch(() => null)) ?? {};
  const now: Record<string, { rank: number; why: string }> = {};
  let written = 0, cleared = 0;
  for (const c of q.cards.slice(0, SYNC_MAX)) {
    now[c.leadId] = { rank: c.rank, why: c.why };
    if (before[c.leadId]?.rank === c.rank && before[c.leadId]?.why === c.why) continue;
    await d.close.updateLead(c.leadId, { [`custom.${ids.rank}`]: c.rank, [`custom.${ids.why}`]: c.why });
    written++;
  }
  for (const leadId of Object.keys(before)) {
    if (now[leadId]) continue;
    await d.close.updateLead(leadId, { [`custom.${ids.rank}`]: null, [`custom.${ids.why}`]: null }).catch(() => undefined);
    cleared++;
  }
  await store.putSetting(d.rep.closeUserId, key, now).catch(() => undefined);
  // "My queue": these leads, in rank order. The one view a rep pins.
  let view: string | null = null;
  try {
    const owner = await ownerFieldId(d);
    const leadIds = q.cards.slice(0, SYNC_MAX).map((c) => c.leadId);
    const s_query = { ...dialQuery(leadIds.length ? leadIds : ["lead_none"], owner ?? ids.rank, d.rep.timeZone, d.now?.() ?? new Date()), sort: [{ field: { type: "custom_field", custom_field_id: ids.rank }, direction: "asc" }] };
    // dialQuery's third clause drops leads reached today; here the ranked list itself is the rule, so only the id list stays.
    s_query.query.queries = s_query.query.queries.slice(0, 2);
    const name = dialViewName("Dial: My queue", d.rep);
    const existing = await d.close.savedSearches();
    const old = existing.find((x) => x.name === name);
    const r = old ? await d.close.updateSavedSearch(old.id, { name, s_query }) : await d.close.createSavedSearch({ name, type: "lead", is_shared: true, s_query });
    view = r.id;
  } catch (e) { console.error(`[queue ${d.rep.email}] view:`, (e as Error).message); }
  return { written, cleared, view };
}

/** The morning sync for every rep, from the catch-up: once a day each. */
export async function syncQueues(reps: Deps[]) {
  for (const d of reps) {
    const day = localDay(d.rep.timeZone, new Date()).day;
    if (!(await store.once(`queue-sync:${d.rep.closeUserId}:${day}`, 20 * 3600_000).catch(() => false))) continue;
    background(syncQueue(d).then((r) => console.info(`[queue ${d.rep.email}] ${r.written} ranked, ${r.cleared} cleared`)), "queue sync");
  }
}
