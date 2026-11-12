import type { Deps } from "./assistant.js";
import { RUNG_POINTS } from "./ladder.js";
import { localParts, zonedTime } from "./rules.js";
import { newCompaniesOnly, weekStart } from "./race.js";
import { dayFacts, localDay, rfqTimeline, type DayFacts } from "./stats.js";
import { store, type RungEvent } from "./store.js";

/**
 * The players' stats (Walt 11/11: "store RFQs, line cards sent, etc. so we can display players stats"): every scoring
 * event as a row, written from the same facts the West Game scores, so seasons, bests and totals come from one table
 * and never re-read Close. Dial rows carry the lead, not the company name (a hundred a day; the names are a join away).
 */
export type RfqOnDay = { leadId: string; company: string; first: boolean; at?: string | null };

export function eventsOf(repId: string, facts: DayFacts, rfqs: RfqOnDay[], names: (leadId: string) => string | null = () => null): RungEvent[] {
  const day = facts.day;
  const rows: RungEvent[] = [];
  for (const c of facts.calls) rows.push({ id: c.id, repId, leadId: c.leadId, company: null, kind: "dial", at: c.at, day, points: RUNG_POINTS.dial, first: false });
  for (const n of facts.named) rows.push({ id: `${repId}:${n.leadId}:named`, repId, leadId: n.leadId, company: names(n.leadId), kind: "named", at: n.at, day, points: RUNG_POINTS.named, first: false });
  for (const c of facts.cards) rows.push({ id: `${repId}:${c.leadId}:card`, repId, leadId: c.leadId, company: names(c.leadId), kind: "card", at: c.at, day, points: RUNG_POINTS.card, first: false });
  for (const r of facts.reached) rows.push({ id: `${repId}:${r.leadId}:reached`, repId, leadId: r.leadId, company: names(r.leadId), kind: "reached", at: r.at, day, points: RUNG_POINTS.reached, first: false });
  for (const q of rfqs) rows.push({ id: `${repId}:${q.leadId}:rfq:${day}`, repId, leadId: q.leadId, company: q.company, kind: "rfq", at: q.at ?? `${day}T12:00:00.000Z`, day, points: RUNG_POINTS.rfq + (q.first ? RUNG_POINTS.firstRfq : 0), first: q.first });
  return rows;
}

const dayEnd = (day: string, tz: string) => { const [y, m, dd] = day.split("-").map(Number); return zonedTime(y, m, dd, 23, 59, tz); };

/** Write one day's events for a rep: today by default, or a past day (the backfill). */
export async function writeDayEvents(d: Deps, day?: string): Promise<{ day: string; written: number }> {
  const tz = d.rep.timeZone;
  const dd: Deps = day ? { ...d, now: () => dayEnd(day, tz) } : d;
  const facts = await dayFacts(dd);
  // The RFQs the game counts (11/12: the first write took every RFQ on the rep's accounts, hand-offs and existing
  // customers included, and showed Walt 46 for the month against the game's 6 for the week): new companies only,
  // the same filter the lanes use.
  const line = newCompaniesOnly(await rfqTimeline(d, { savedOk: true, refreshAfterMs: 10 * 60_000 }).catch(() => null));
  const rfqs: RfqOnDay[] = (line?.days.find((x) => x.day === facts.day)?.accounts ?? []).map((a) => ({ leadId: a.leadId, company: a.company, first: a.first }));
  const named = new Map<string, string>(rfqs.map((r) => [r.leadId, r.company]));
  const want = new Set([...facts.named, ...facts.cards, ...facts.reached].map((x) => x.leadId).filter((id) => !named.has(id)));
  await Promise.all([...want].slice(0, 60).map(async (id) => { const n = await d.close.leadName(id).catch(() => null); if (n) named.set(id, n); }));
  const rows = eventsOf(d.rep.closeUserId, facts, rfqs, (id) => named.get(id) ?? null);
  // Exact: the day's rows are dropped first, so a row that no longer holds (an RFQ that stopped counting) goes away.
  await store.deleteRungEvents(d.rep.closeUserId, facts.day);
  if (rows.length) await store.putRungEvents(rows);
  return { day: facts.day, written: rows.length };
}

type Backfill = { nextDay: string; stopAt: string };
const BACKFILL_DAYS = 60;
/** Past days, a few per run (the cron's budget), newest first, back to sixty days; done once, then only today is written. */
export async function backfillEvents(d: Deps, opts: { perRun?: number; reset?: boolean } = {}): Promise<{ days: string[]; done: boolean }> {
  const key = d.rep.closeUserId;
  const now = d.now?.() ?? new Date();
  const today = localDay(d.rep.timeZone, now).day;
  // reset: start over from yesterday (11/12: every day rewritten after the RFQ count changed).
  const saved = opts.reset ? null : await store.getSetting<Backfill>(key, "rungEventsBackfill").catch(() => null);
  const state: Backfill = saved ?? { nextDay: shiftDay(today, -1), stopAt: shiftDay(today, -BACKFILL_DAYS) };
  const days: string[] = [];
  for (let i = 0; i < (opts.perRun ?? 3) && state.nextDay >= state.stopAt; i++) {
    const day = state.nextDay;
    const p = localParts(dayEnd(day, d.rep.timeZone), d.rep.timeZone);
    if (p.weekday !== 0 && p.weekday !== 6) { await writeDayEvents(d, day); days.push(day); } // weekends have nothing
    state.nextDay = shiftDay(day, -1);
  }
  await store.putSetting(key, "rungEventsBackfill", state).catch(() => undefined);
  return { days, done: state.nextDay < state.stopAt };
}
const shiftDay = (day: string, by: number) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + by); return t.toISOString().slice(0, 10); };

export type Career = {
  since: string | null; days: number;
  /** The four ranges the board toggles between (Walt 11/12), in the rep's local days. */
  today: Totals; week: Totals; month: Totals; all: Totals;
  best: { day: string; points: number } | null;
  rfqs: Array<{ day: string; company: string | null; first: boolean }>;
};
export type Totals = { dials: number; named: number; cards: number; reached: number; rfqs: number; firstRfqs: number; points: number };
const zero = (): Totals => ({ dials: 0, named: 0, cards: 0, reached: 0, rfqs: 0, firstRfqs: 0, points: 0 });
const add = (t: Totals, e: RungEvent) => {
  if (e.kind === "dial") t.dials++; else if (e.kind === "named") t.named++; else if (e.kind === "card") t.cards++; else if (e.kind === "reached") t.reached++; else { t.rfqs++; if (e.first) t.firstRfqs++; }
  t.points += e.points;
};
/** A rep's season from the table: today, this week (from Monday), this month, all time, the best day, and every RFQ. */
export async function careerFor(repId: string, tz: string, now = new Date()): Promise<Career> {
  const rows = await store.listRungEvents(repId);
  const today = localDay(tz, now).day;
  const monday = weekStart(today);
  const month = today.slice(0, 7);
  const t = { today: zero(), week: zero(), month: zero(), all: zero() };
  const byDay = new Map<string, number>();
  const days = new Set<string>();
  for (const e of rows) {
    add(t.all, e);
    if (e.day.startsWith(month)) add(t.month, e);
    if (e.day >= monday) add(t.week, e);
    if (e.day === today) add(t.today, e);
    byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.points);
    if (e.kind === "dial") days.add(e.day);
  }
  const best = [...byDay].sort((a, b) => b[1] - a[1])[0];
  return {
    since: rows[0]?.day ?? null, days: days.size, ...t,
    best: best ? { day: best[0], points: best[1] } : null,
    rfqs: rows.filter((e) => e.kind === "rfq").map((e) => ({ day: e.day, company: e.company, first: e.first })).reverse(),
  };
}
