import type { Deps } from "./assistant.js";
import { background } from "./background.js";
import { dayStats, localDay, periodStats, rfqTimeline } from "./stats.js";
import { getList, guestLeadIds, listGuests, type Guest } from "./guests.js";
import { ownerFieldId } from "./myleads.js";
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
// Rebalanced 10/26 (Walt: "way too many points being issued"): RFQs are what wins. A strong day of calling without one
// is worth about half the finish line; the finish (400) is about 8 RFQs.
export const POINTS = { dial: 1, reached: 3, lineCard: 5, rfq: 50, firstRfq: 25 } as const;
export type RaceLane = {
  /** A rep's email, or `guest:<id>` for a guest link (they play too while their link is on, 10/25). */
  email: string; name: string; first: string; guest?: boolean;
  dials: number; reached: number; lineCards: number; rfqs: number; firstRfqs: number; points: number;
  week: { dials: number; reached: number; lineCards: number; rfqs: number; points: number } | null;
  error: string | null;
};
/** showAt: the moment every screen plays it, the same for everyone (10/26: "hit everyone's device at the exact same time"). */
export type RaceEvent = { id: string; email: string; name: string; company: string; first: boolean; day: string; leadId?: string; showAt?: string };
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
const FRESH_MS = 20_000;
let building: Promise<Race> | null = null;

/** The race as of the last minute: the shared copy if it's fresh, else worked out now (one build at a time). */
export async function teamRace(team: Deps[], ownerId: string, opts: { fresh?: boolean } = {}): Promise<Race> {
  const saved = await store.cacheGet<Race>(RACE_KEY).catch(() => null);
  // Every panel asks for a fresh read right after someone scores; one every 10 seconds is plenty for the whole team.
  if (saved && opts.fresh && Date.now() - Date.parse(saved.at) < 10_000) return saved;
  if (saved && !opts.fresh && Date.now() - Date.parse(saved.at) < FRESH_MS) return saved;
  if (saved && !opts.fresh && Date.now() - Date.parse(saved.at) < 10 * FRESH_MS) {
    // A little old: show it now, rebuild behind it.
    if (!building) building = buildRace(team, ownerId).finally(() => { building = null; });
    background(building, "race");
    return saved;
  }
  if (!building) building = buildRace(team, ownerId, !!opts.fresh).finally(() => { building = null; });
  return building;
}

/** fresh: someone just did something that scores (sent a line card, logged an RFQ), so read today's numbers now. */
async function buildRace(team: Deps[], ownerId: string, fresh = false): Promise<Race> {
  const roster = await raceRoster(ownerId);
  const racers = team.filter((t) => !roster.excluded.includes(t.rep.email.toLowerCase()));
  const now = new Date();
  const taps = await todaysTaps(ownerId, team[0]?.rep.timeZone ?? "America/Chicago", now);
  const previous = await store.cacheGet<Race>(RACE_KEY).catch(() => null);
  const results = await Promise.all(racers.map(async (t) => {
    const first = t.rep.name.split(/\s+/)[0] || t.rep.name;
    try {
      const today = localDay(t.rep.timeZone, now).day;
      const [day, rawLine, week] = await Promise.all([
        dayStats(t, { fresh }),
        rfqTimeline(t, { savedOk: true, refreshAfterMs: fresh ? 30_000 : 4 * 60_000 }).catch(() => null),
        periodStats(t, "week").catch(() => null),
      ]);
      const line = newCompaniesOnly(withTaps(rawLine, taps.filter((x) => x.email === t.rep.email.toLowerCase()), today));
      const todays = line?.days.find((x) => x.day === today)?.accounts ?? [];
      const rfqs = todays.length, firstRfqs = todays.filter((a) => a.first).length;
      // Line cards a person sent, not the automatic follow-ups that carry one too.
      const base = { dials: day.dials, reached: day.reached, lineCards: day.newLineCards ?? day.lineCards, rfqs, firstRfqs };
      const weekDays = line ? line.days.filter((x) => x.day >= weekStart(today)) : [];
      const weekRfqs = weekDays.reduce((n, x) => n + x.accounts.length, 0);
      const weekFirst = weekDays.reduce((n, x) => n + x.accounts.filter((a) => a.first).length, 0);
      const lane: RaceLane = {
        email: t.rep.email.toLowerCase(), name: t.rep.name, first, ...base, points: scoreOf(base),
        week: weekOf(week ? { ...week, lineCards: week.newLineCards ?? week.lineCards } : null, base, weekRfqs, weekFirst),
        error: null,
      };
      const events: RaceEvent[] = todays.map((a) => ({ id: `${a.leadId}:${today}`, email: lane.email, name: t.rep.name, company: a.company, first: a.first, day: today, leadId: a.leadId }));
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
  await oneOwnerPerRfq(results);
  const guestLanes = await guestRacers(team, roster, results, now);
  // One showtime per RFQ, kept from the first time it was seen (a tap's, or the last copy's), so every screen agrees.
  const shown = new Map<string, string>([
    ...(previous?.events ?? []).filter((e) => e.showAt).map((e) => [e.id, e.showAt!] as const),
    ...taps.map((x) => [x.id, showTime(x.at)] as const),
  ]);
  const race: Race = {
    day: localDay(team[0]?.rep.timeZone ?? "America/Chicago", now).day, at: now.toISOString(),
    lanes: [...results.map((r) => r.lane), ...guestLanes.map((g) => g.lane)].sort((a, b) => b.points - a.points || b.dials - a.dials),
    events: [...results.flatMap((r) => r.events), ...guestLanes.flatMap((g) => g.events)]
      .map(({ leadId: _l, ...e }) => ({ ...e, showAt: shown.get(e.id) ?? showTime(now.toISOString()) })), points: POINTS, roster,
  };
  await store.cacheSet(RACE_KEY, race, 24 * 3600_000).catch(() => undefined);
  return race;
}

/**
 * The week so far. The week's numbers are saved for a while and today's are fresher, so a count can show today ahead
 * of the week it's part of (Walt 10/26: 6 line cards today, 5 this week). The week is never less than today.
 */
function weekOf(week: { dials: number; reached: number; lineCards: number } | null, today: { dials: number; reached: number; lineCards: number; rfqs: number; firstRfqs?: number }, weekRfqs: number, weekFirst = 0) {
  if (!week) return null;
  const w = { dials: Math.max(week.dials, today.dials), reached: Math.max(week.reached, today.reached), lineCards: Math.max(week.lineCards, today.lineCards),
    rfqs: Math.max(weekRfqs, today.rfqs), firstRfqs: Math.max(weekFirst, today.firstRfqs ?? 0) };
  return { ...w, points: scoreOf(w) };
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
    const line = host?.line ?? newCompaniesOnly(await rfqTimeline(t, { savedOk: true, refreshAfterMs: 4 * 60_000 }).catch(() => null));
    for (const g of guests) {
      const [list, ids] = await Promise.all([getList(t.rep.closeUserId, g.id).catch(() => null), guestLeadIds(t.rep.closeUserId, g)]);
      const marks = (list?.leads ?? []).filter((l) => l.outcome && l.outcomeAt);
      const count = (from: string) => {
        const m = marks.filter((l) => dayOf(l.outcomeAt) >= from && dayOf(l.outcomeAt) <= today);
        return { dials: m.length, reached: m.filter((l) => REACHED_OUTCOMES.has(l.outcome!)).length, lineCards: g.sends.filter((x) => dayOf(x.at) >= from && dayOf(x.at) <= today).length };
      };
      const todays = (line?.days.find((x) => x.day === today)?.accounts ?? []).filter((a) => ids.has(a.leadId));
      const weekMine = (line?.days ?? []).filter((x) => x.day >= monday).flatMap((x) => x.accounts.filter((a) => ids.has(a.leadId)));
      const weekRfqs = weekMine.length, weekFirst = weekMine.filter((a) => a.first).length;
      const base = { ...count(today), rfqs: todays.length, firstRfqs: todays.filter((a) => a.first).length };
      const wk = count(monday);
      const email = `guest:${g.id}`;
      out.push({
        lane: { email, name: g.name, first: g.name.split(/\s+/)[0] || g.name, guest: true, ...base, points: scoreOf(base),
          week: weekOf(wk, base, weekRfqs, weekFirst), error: null },
        events: todays.map((a) => ({ id: `${a.leadId}:${today}`, email, name: g.name, company: a.company, first: a.first, day: today })),
      });
      // Their line cards went out from the rep's account: they count for the guest, not the rep.
      if (host && base.lineCards) { host.lane.lineCards = Math.max(0, host.lane.lineCards - base.lineCards); host.lane.points = scoreOf(host.lane); }
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

/**
 * Each RFQ goes to one person (Walt 10/26: Haley Contracting counted for Chase, who tapped "RFQ came in", and for Walt,
 * whose account got the reply). Per company per day: whoever marked it came in; if nobody did, the company's Lead owner
 * in Close; if that's nobody racing, whoever's account it showed up in first. Everyone else's copy comes off their lane.
 */
async function oneOwnerPerRfq(results: RepResult[]) {
  type Entry = { r: RepResult; leadId: string; day: string; how: string; first: boolean; marked: boolean; company: string };
  const live = results.filter((r) => r.line && r.today);
  const byKey = new Map<string, Entry[]>();
  for (const r of live) {
    const monday = weekStart(r.today);
    for (const d of r.line!.days) if (d.day >= monday) for (const a of d.accounts) {
      const k = `${a.leadId}|${d.day}`;
      byKey.set(k, [...(byKey.get(k) ?? []), { r, leadId: a.leadId, day: d.day, how: a.how, first: a.first, marked: !!a.marked || a.how === "marked", company: a.company }]);
    }
  }
  const shared = [...byKey.values()].filter((es) => new Set(es.map((e) => e.r)).size > 1);
  if (!shared.length) return;
  // Lead owners, read once with any login that can see the leads.
  const reader = live[0].t;
  const field = await ownerFieldId(reader).catch(() => null);
  const ownerOf = new Map<string, string | null>();
  if (field) await Promise.all([...new Set(shared.map((es) => es[0].leadId))].map(async (id) => {
    const lead = await reader.close.lead(id).catch(() => null) as Record<string, unknown> | null;
    const v = lead ? lead[`custom.${field}`] : null;
    ownerOf.set(id, typeof v === "string" ? v : null);
  }));
  const lose = new Map<RepResult, Set<string>>(); // rep → lead|day keys they don't get
  for (const es of shared) {
    const owner = ownerOf.get(es[0].leadId);
    const keep = es.find((e) => e.marked) ?? es.find((e) => !!owner && e.r.t.rep.closeUserId === owner) ?? es[0];
    for (const e of es) if (e.r !== keep.r) lose.set(e.r, new Set([...(lose.get(e.r) ?? []), `${e.leadId}|${e.day}`]));
  }
  for (const [r, keys] of lose) {
    const l = r.lane;
    const today = [...keys].filter((k) => k.endsWith(`|${r.today}`));
    const gone = r.line!.days.flatMap((d) => d.accounts.filter((a) => keys.has(`${a.leadId}|${d.day}`)).map((a) => ({ ...a, day: d.day })));
    const goneToday = gone.filter((a) => a.day === r.today);
    l.rfqs = Math.max(0, l.rfqs - goneToday.length);
    l.firstRfqs = Math.max(0, l.firstRfqs - goneToday.filter((a) => a.first).length);
    l.points = scoreOf(l);
    if (l.week) {
      const w = l.week as typeof l.week & { firstRfqs?: number };
      w.rfqs = Math.max(0, w.rfqs - gone.length);
      w.firstRfqs = Math.max(0, (w.firstRfqs ?? 0) - gone.filter((a) => a.first).length);
      w.points = scoreOf(w);
    }
    const drop = new Set(today.map((k) => k.split("|")[0]));
    r.events = r.events.filter((e) => !(e.leadId && drop.has(e.leadId)));
  }
}

// ---------- RFQs the moment they're tapped, shown on every screen at once (Walt 10/26) ----------

/** How long after an RFQ is first seen every screen plays it: long enough for every panel to have checked in. */
export const SHOW_DELAY_MS = 7_000;
const showTime = (at: string) => new Date(Date.parse(at) + SHOW_DELAY_MS).toISOString();
const TAPS_KEY = "raceTaps";
export type RaceTap = { id: string; email: string; name: string; leadId: string; company: string; at: string; day: string; first: boolean };

async function todaysTaps(ownerId: string, tz: string, now: Date): Promise<RaceTap[]> {
  const today = localDay(tz, now).day;
  return ((await store.getSetting<RaceTap[]>(ownerId, TAPS_KEY).catch(() => null)) ?? []).filter((x) => x.day === today);
}

/**
 * Someone tapped "RFQ came in": it counts now, not when Close is next read. It's a new company (the only kind that
 * scores, 10/26) when the lead was added to Close in the last 120 days and nobody on the team has had an RFQ from it before.
 */
export async function recordRfqTap(team: Deps[], ownerId: string, d: Deps, leadId: string): Promise<RaceTap> {
  const now = new Date();
  const today = localDay(d.rep.timeZone, now).day;
  const lead = (await d.close.lead(leadId).catch(() => null)) as { display_name?: string; date_created?: string } | null;
  const added = Date.parse(String(lead?.date_created ?? ""));
  const newToUs = Number.isFinite(added) && now.getTime() - added < 120 * 86_400_000;
  let before = false;
  for (const t of team) {
    const line = await rfqTimeline(t, { savedOk: true }).catch(() => null);
    if (line?.days.some((x) => x.day < today && x.accounts.some((a) => a.leadId === leadId))) { before = true; break; }
  }
  const tap: RaceTap = { id: `${leadId}:${today}`, email: d.rep.email.toLowerCase(), name: d.rep.name, leadId, company: lead?.display_name ?? "An account", at: now.toISOString(), day: today, first: newToUs && !before };
  const taps = (await todaysTaps(ownerId, d.rep.timeZone, now)).filter((x) => x.id !== tap.id);
  await store.putSetting(ownerId, TAPS_KEY, [...taps, tap]);
  return tap;
}

/** Taps go into the rep's RFQs for today, ahead of Close showing them. */
function withTaps(line: RfqLine, taps: RaceTap[], today: string): RfqLine {
  if (!line && !taps.length) return line;
  const base: NonNullable<RfqLine> = line ?? { since: today, total: 0, thisWeek: 0, lastWeek: 0, firstToday: 0, firstThisWeek: 0, companies: 0, newThisWeek: 0, newLastWeek: 0, newThisMonth: 0, newLastMonth: 0, days: [] };
  const days = base.days.map((x) => ({ ...x, accounts: [...x.accounts] }));
  let day = days.find((x) => x.day === today);
  if (!day && taps.length) { day = { day: today, count: 0, total: 0, newCompanies: 0, companiesTotal: 0, accounts: [] }; days.push(day); }
  for (const tap of taps) {
    const have = day!.accounts.find((a) => a.leadId === tap.leadId);
    if (have) { have.marked = true; have.first = have.first || tap.first; }
    else day!.accounts.push({ leadId: tap.leadId, company: tap.company, how: "marked", first: tap.first, marked: true });
  }
  return { ...base, days };
}

/** Only new companies score (Walt 10/26: "not companies that have been compounding over time"). */
function newCompaniesOnly(line: RfqLine): RfqLine {
  return line ? { ...line, days: line.days.map((x) => ({ ...x, accounts: x.accounts.filter((a) => a.first) })) } : line;
}
type RfqLine = Awaited<ReturnType<typeof rfqTimeline>>;

/** The day's RFQs and their showtimes, for the screens to play in sync: cheap, read every few seconds. */
export async function raceLive(ownerId: string, tz: string) {
  const now = new Date();
  const [saved, taps] = await Promise.all([store.cacheGet<Race>(RACE_KEY).catch(() => null), todaysTaps(ownerId, tz, now)]);
  const events = new Map<string, RaceEvent>();
  for (const e of saved?.events ?? []) events.set(e.id, e);
  for (const x of taps) if (x.first && !events.has(x.id)) events.set(x.id, { id: x.id, email: x.email, name: x.name, company: x.company, first: true, day: x.day, showAt: showTime(x.at) });
  return { now: now.toISOString(), day: localDay(tz, now).day, events: [...events.values()] };
}
