import type { Deps } from "./assistant.js";
import { background } from "./background.js";
import { dayStats, localDay, periodStats, rfqTimeline } from "./stats.js";
import { getList, guestLeadIds, listGuests, type Guest } from "./guests.js";
import { store } from "./store.js";

/**
 * The BDR race (Walt 10/25: "gamify being a BDR, display calls like a race"). Every rep on the roster is a lane: the car
 * moves with each dial, and points decide who's winning. Dials show effort and RFQs show results, so a dial is worth 1
 * and an RFQ 50: speed-dialing voicemails can't beat landing work. The race resets each morning; the week is a running
 * total. When anyone lands an RFQ, every panel celebrates it.
 *
 * Worked out once a minute for the whole team and shared: every panel reads the same copy, so Close isn't asked once
 * per panel. A rep whose numbers can't be read (a Close login that's been turned off) still has a lane, flagged.
 */
export const POINTS = { dial: 1, reached: 5, lineCard: 10, rfq: 50, firstRfq: 25 } as const;
export type RaceLane = {
  /** A rep's email, or `guest:<id>` for a guest link (they play too while their link is on, 10/25). */
  email: string; name: string; first: string; guest?: boolean;
  dials: number; reached: number; lineCards: number; rfqs: number; firstRfqs: number; points: number;
  week: { dials: number; reached: number; lineCards: number; rfqs: number; points: number } | null;
  error: string | null;
};
export type RaceEvent = { id: string; email: string; name: string; company: string; first: boolean; day: string; leadId?: string };
export type Race = { day: string; at: string; lanes: RaceLane[]; events: RaceEvent[]; points: typeof POINTS; roster: { excluded: string[] } };

const ROSTER_KEY = "raceRoster";
/** Who's left out (Walt picks: "some people call but aren't BDRs"). Work Trial starts out. */
export async function raceRoster(ownerId: string): Promise<{ excluded: string[] }> {
  return (await store.getSetting<{ excluded: string[] }>(ownerId, ROSTER_KEY).catch(() => null)) ?? { excluded: ["sales@westgatesupply.com"] };
}
export async function setRaceRoster(ownerId: string, email: string, racing: boolean) {
  const r = await raceRoster(ownerId);
  const e = email.trim().toLowerCase();
  const excluded = racing ? r.excluded.filter((x) => x !== e) : [...new Set([...r.excluded, e])];
  await store.putSetting(ownerId, ROSTER_KEY, { excluded });
  await store.cacheSet(RACE_KEY, null, 1).catch(() => undefined);
  return { excluded };
}

const scoreOf = (x: { dials: number; reached: number; lineCards: number; rfqs: number; firstRfqs?: number }) =>
  x.dials * POINTS.dial + x.reached * POINTS.reached + x.lineCards * POINTS.lineCard + x.rfqs * POINTS.rfq + (x.firstRfqs ?? 0) * POINTS.firstRfq;

const RACE_KEY = "race:team";
const FRESH_MS = 60_000;
let building: Promise<Race> | null = null;

/** The race as of the last minute: the shared copy if it's fresh, else worked out now (one build at a time). */
export async function teamRace(team: Deps[], ownerId: string, opts: { fresh?: boolean } = {}): Promise<Race> {
  const saved = await store.cacheGet<Race>(RACE_KEY).catch(() => null);
  if (saved && !opts.fresh && Date.now() - Date.parse(saved.at) < FRESH_MS) return saved;
  if (saved && !opts.fresh && Date.now() - Date.parse(saved.at) < 10 * FRESH_MS) {
    // A little old: show it now, rebuild behind it.
    if (!building) building = buildRace(team, ownerId).finally(() => { building = null; });
    background(building, "race");
    return saved;
  }
  if (!building) building = buildRace(team, ownerId).finally(() => { building = null; });
  return building;
}

async function buildRace(team: Deps[], ownerId: string): Promise<Race> {
  const roster = await raceRoster(ownerId);
  const racers = team.filter((t) => !roster.excluded.includes(t.rep.email.toLowerCase()));
  const now = new Date();
  const results = await Promise.all(racers.map(async (t) => {
    const first = t.rep.name.split(/\s+/)[0] || t.rep.name;
    try {
      const today = localDay(t.rep.timeZone, now).day;
      const [day, line, week] = await Promise.all([
        dayStats(t),
        rfqTimeline(t, { savedOk: true, refreshAfterMs: 4 * 60_000 }).catch(() => null),
        periodStats(t, "week").catch(() => null),
      ]);
      const todays = line?.days.find((x) => x.day === today)?.accounts ?? [];
      const rfqs = todays.length, firstRfqs = todays.filter((a) => a.first).length;
      const base = { dials: day.dials, reached: day.reached, lineCards: day.lineCards, rfqs, firstRfqs };
      const weekRfqs = line ? line.days.filter((x) => x.day >= weekStart(today)).reduce((n, x) => n + x.accounts.length, 0) : 0;
      const lane: RaceLane = {
        email: t.rep.email.toLowerCase(), name: t.rep.name, first, ...base, points: scoreOf(base),
        week: week ? { dials: week.dials, reached: week.reached, lineCards: week.lineCards, rfqs: weekRfqs, points: scoreOf({ ...week, rfqs: weekRfqs }) } : null,
        error: null,
      };
      const events: RaceEvent[] = todays.map((a) => ({ id: `${t.rep.closeUserId}:${a.leadId}:${today}`, email: lane.email, name: t.rep.name, company: a.company, first: a.first, day: today, leadId: a.leadId }));
      return { lane, events, line, today, t };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        lane: { email: t.rep.email.toLowerCase(), name: t.rep.name, first, dials: 0, reached: 0, lineCards: 0, rfqs: 0, firstRfqs: 0, points: 0, week: null,
          error: /403|no access/i.test(msg) ? "Close login needs fixing" : "Couldn't read their numbers" },
        events: [] as RaceEvent[], line: null, today: "", t,
      };
    }
  }));
  const guestLanes = await guestRacers(team, roster, results, now);
  const race: Race = {
    day: localDay(team[0]?.rep.timeZone ?? "America/Chicago", now).day, at: now.toISOString(),
    lanes: [...results.map((r) => r.lane), ...guestLanes.map((g) => g.lane)].sort((a, b) => b.points - a.points || b.dials - a.dials),
    events: [...results.flatMap((r) => r.events), ...guestLanes.flatMap((g) => g.events)].map(({ leadId: _l, ...e }) => e), points: POINTS, roster,
  };
  await store.cacheSet(RACE_KEY, race, 24 * 3600_000).catch(() => undefined);
  return race;
}

/** Monday of the week containing `day` (YYYY-MM-DD). */
function weekStart(day: string) {
  const t = Date.parse(`${day}T12:00:00Z`);
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

const REACHED_OUTCOMES = new Set(["Reached buyer", "Wants line card", "Sending an RFQ", "Got a name"]);
type RepResult = { lane: RaceLane; events: RaceEvent[]; line: Awaited<ReturnType<typeof rfqTimeline>> | null; today: string; t: Deps };

/**
 * Guests play too (Walt 10/25), but only while their link is on. A guest's dials are the calls they mark on their list,
 * conversations the marks where they got someone, line cards the ones they sent. Their line cards go out from the
 * rep's Close account, so an RFQ from a company the guest worked lands on the rep: it moves from the rep's lane to theirs.
 */
async function guestRacers(team: Deps[], roster: { excluded: string[] }, reps: RepResult[], now: Date) {
  const out: Array<{ lane: RaceLane; events: RaceEvent[] }> = [];
  for (const t of team) {
    const guests = (await listGuests(t.rep.closeUserId).catch(() => [] as Guest[])).filter((g) => g.active && !roster.excluded.includes(`guest:${g.id}`));
    if (!guests.length) continue;
    const tz = t.rep.timeZone;
    const today = localDay(tz, now).day, monday = weekStart(today);
    const dayOf = (iso: string | null | undefined) => (iso ? localDay(tz, new Date(iso)).day : "");
    const host = reps.find((r) => r.t.rep.closeUserId === t.rep.closeUserId);
    const line = host?.line ?? (await rfqTimeline(t, { savedOk: true, refreshAfterMs: 4 * 60_000 }).catch(() => null));
    for (const g of guests) {
      const [list, ids] = await Promise.all([getList(t.rep.closeUserId, g.id).catch(() => null), guestLeadIds(t.rep.closeUserId, g)]);
      const marks = (list?.leads ?? []).filter((l) => l.outcome && l.outcomeAt);
      const count = (from: string) => {
        const m = marks.filter((l) => dayOf(l.outcomeAt) >= from && dayOf(l.outcomeAt) <= today);
        return { dials: m.length, reached: m.filter((l) => REACHED_OUTCOMES.has(l.outcome!)).length, lineCards: g.sends.filter((x) => dayOf(x.at) >= from && dayOf(x.at) <= today).length };
      };
      const todays = (line?.days.find((x) => x.day === today)?.accounts ?? []).filter((a) => ids.has(a.leadId));
      const weekRfqs = (line?.days ?? []).filter((x) => x.day >= monday).reduce((n, x) => n + x.accounts.filter((a) => ids.has(a.leadId)).length, 0);
      const base = { ...count(today), rfqs: todays.length, firstRfqs: todays.filter((a) => a.first).length };
      const wk = count(monday);
      const email = `guest:${g.id}`;
      out.push({
        lane: { email, name: g.name, first: g.name.split(/\s+/)[0] || g.name, guest: true, ...base, points: scoreOf(base),
          week: { ...wk, rfqs: weekRfqs, points: scoreOf({ ...wk, rfqs: weekRfqs }) }, error: null },
        events: todays.map((a) => ({ id: `${t.rep.closeUserId}:${a.leadId}:${today}`, email, name: g.name, company: a.company, first: a.first, day: today })),
      });
      // The same RFQs come off the rep's lane, so nobody gets them twice.
      if (host && (todays.length || weekRfqs)) {
        const l = host.lane;
        const gone = new Set(todays.map((a) => a.leadId));
        l.rfqs -= todays.length; l.firstRfqs -= base.firstRfqs; l.points = scoreOf(l);
        if (l.week) { l.week.rfqs = Math.max(0, l.week.rfqs - weekRfqs); l.week.points = scoreOf(l.week); }
        host.events = host.events.filter((e) => !(e.leadId && gone.has(e.leadId)));
      }
    }
  }
  return out;
}
