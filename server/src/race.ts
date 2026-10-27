import type { Deps } from "./assistant.js";
import { background } from "./background.js";
import { ADMIN_DOC, dayStats, localDay, OUR_QUOTE, periodStats, rfqTimeline, theirFiles } from "./stats.js";
import { earlierCalls, getList, guestLeadIds, listGuests, type Guest } from "./guests.js";
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
// Walt 10/27: hard to finish. Line cards run about one per four calls, so each call is worth about 1.5 points:
// no RFQs takes about 240 calls, one RFQ about 200, two about 160, three about 120; 130 calls is the floor unless the
// RFQs pour in. (It was 220 to finish with 15 an RFQ.) The screens read the finish and the points from here, so
// changing them doesn't need an extension update.
export const POINTS = { dial: 1, reached: 0, lineCard: 2, rfq: 60, firstRfq: 0 } as const;
export const GOAL = 360;
export type RaceLane = {
  /** A rep's email, or `guest:<id>` for a guest link (they play too while their link is on, 10/25). */
  email: string; name: string; first: string; guest?: boolean;
  dials: number; reached: number; lineCards: number; rfqs: number; firstRfqs: number; points: number;
  week: { dials: number; reached: number; lineCards: number; rfqs: number; points: number } | null;
  error: string | null;
  /** This week's RFQs that scored, newest first: who they came from (Walt 10/27: "show who the RFQ came from"). */
  rfqFrom?: Array<{ leadId: string; company: string; day: string }>;
  /** The rep's Close user and time zone, so the lane can be counted live between rebuilds. */
  rid?: string; tz?: string;
};
/** showAt: the moment every screen plays it, the same for everyone (10/26: "hit everyone's device at the exact same time"). */
export type RaceEvent = { id: string; email: string; name: string; company: string; first: boolean; day: string; leadId?: string; showAt?: string };
/** Who won each earlier day this week, for the weekly leaderboard (Walt 10/27). */
export type RaceDay = { day: string; winner: { email: string; name: string; points: number } | null };
export type Race = { day: string; at: string; lanes: RaceLane[]; events: RaceEvent[]; points: typeof POINTS; goal?: number; roster: { excluded: string[] }; weekDays?: RaceDay[] };

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
const LOCK_KEY = "race:building";
/** How old the shared copy gets before someone rebuilds it. One rebuild reads ~90 Close calls per rep (10/27: running one
 * every 20s per panel, and two more after every dial, queued every Close call behind it: saves and notes took 7s each). */
const REBUILD_MS = 2 * 60_000;
let building: Promise<Race> | null = null;

/** The race as last worked out: always the shared copy when there is one, rebuilt behind it by one server at a time.
 * RFQ taps don't wait for a rebuild: raceLive and the tap route read them straight from the store. */
export async function teamRace(team: Deps[], ownerId: string, opts: { fresh?: boolean; force?: boolean } = {}): Promise<Race> {
  const saved = await store.cacheGet<Race>(RACE_KEY).catch(() => null);
  // force: an RFQ was just tapped (a few a day), so that lane's points go up now rather than in two minutes.
  if (saved && !opts.force && Date.now() - Date.parse(saved.at) < REBUILD_MS) return saved;
  if (saved) {
    if (!building && !(await store.cacheGet<boolean>(LOCK_KEY).catch(() => null))) {
      await store.cacheSet(LOCK_KEY, true, 90_000).catch(() => undefined);
      building = buildRace(team, ownerId).finally(() => { building = null; void store.cacheSet(LOCK_KEY, null, 1).catch(() => undefined); });
      background(building, "race");
    }
    return saved;
  }
  if (!building) building = buildRace(team, ownerId).finally(() => { building = null; });
  return building;
}

/** The week's numbers, saved for 15 minutes in the shared store (they're ~47 Close calls a rep; today's lane is fresher). */
async function weekFor(t: Deps) {
  const key = `raceweek:${t.rep.email.toLowerCase()}:${weekStart(localDay(t.rep.timeZone, new Date()).day)}`;
  const saved = await store.cacheGet<Awaited<ReturnType<typeof periodStats>>>(key).catch(() => null);
  if (saved) return saved;
  const week = await periodStats(t, "week").catch(() => null);
  if (week) await store.cacheSet(key, week, 15 * 60_000).catch(() => undefined);
  return week;
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
        rfqTimeline(t, { savedOk: true, refreshAfterMs: 10 * 60_000 }).catch(() => null),
        weekFor(t),
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
        email: t.rep.email.toLowerCase(), name: t.rep.name, first, ...base, points: scoreOf(base), rid: t.rep.closeUserId, tz: t.rep.timeZone,
        rfqFrom: weekDays.flatMap((x) => x.accounts.map((a) => ({ leadId: a.leadId, company: a.company, day: x.day }))).sort((a, b) => b.day.localeCompare(a.day)),
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
      .map(({ leadId: _l, ...e }) => ({ ...e, showAt: shown.get(e.id) ?? showTime(now.toISOString()) })), points: POINTS, goal: GOAL, roster,
  };
  race.weekDays = await weekDays(race);
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
    const line = host?.line ?? newCompaniesOnly(await rfqTimeline(t, { savedOk: true, refreshAfterMs: 10 * 60_000 }).catch(() => null));
    for (const g of guests) {
      const [list, ids, earlier] = await Promise.all([getList(t.rep.closeUserId, g.id).catch(() => null), guestLeadIds(t.rep.closeUserId, g), earlierCalls(t.rep.closeUserId, g.id)]);
      // Calls on lists they've since replaced still count (10/27).
      const marks = [...(list?.leads ?? []), ...earlier].filter((l) => l.outcome && l.outcomeAt);
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
          week: weekOf(wk, base, weekRfqs, weekFirst), error: null,
          rfqFrom: (line?.days ?? []).filter((x) => x.day >= monday).flatMap((x) => x.accounts.filter((a) => ids.has(a.leadId)).map((a) => ({ leadId: a.leadId, company: a.company, day: x.day }))).sort((a, b) => b.day.localeCompare(a.day)) },
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
        const theirs = new Set(weekMine.map((a) => a.leadId));
        l.rfqFrom = l.rfqFrom?.filter((c) => !theirs.has(c.leadId));
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
    l.rfqFrom = l.rfqFrom?.filter((c) => !keys.has(`${c.leadId}|${c.day}`));
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
export const SHOW_DELAY_MS = 4_000;
const showTime = (at: string) => new Date(Date.parse(at) + SHOW_DELAY_MS).toISOString();
const TAPS_KEY = "raceTaps";
/** how: seen in an email (a file, or an RFQ in the words) rather than tapped. Only a tap counts as "marked it came in". */
export type RaceTap = { id: string; email: string; name: string; leadId: string; company: string; at: string; day: string; first: boolean; how?: "file" | "email" };

async function todaysTaps(ownerId: string, tz: string, now: Date): Promise<RaceTap[]> {
  const today = localDay(tz, now).day;
  return ((await store.getSetting<RaceTap[]>(ownerId, TAPS_KEY).catch(() => null)) ?? []).filter((x) => x.day === today);
}

/**
 * Someone tapped "RFQ came in": it counts now, not when Close is next read. It's a new company (the only kind that
 * scores, 10/26) when the lead was added to Close in the last 120 days and nobody on the team has had an RFQ from it before.
 */
export async function recordRfqTap(team: Deps[], ownerId: string, d: Deps, leadId: string, seen?: { how: "file" | "email"; at: string }): Promise<RaceTap | null> {
  const now = seen ? new Date(seen.at) : new Date();
  const today = localDay(d.rep.timeZone, now).day;
  const lead = (await d.close.lead(leadId).catch(() => null)) as { display_name?: string; date_created?: string; status_label?: string } | null;
  // Same as the RFQ count: not a supplier quoting us, not a test lead.
  if (seen && (/vendor/i.test(lead?.status_label ?? "") || /^test lead\b/i.test(lead?.display_name ?? ""))) return null;
  const added = Date.parse(String(lead?.date_created ?? ""));
  const newToUs = Number.isFinite(added) && now.getTime() - added < 120 * 86_400_000;
  // Saved lines only, all at once: this runs while the rep waits for the celebration.
  const lines = await Promise.all(team.map((t) => rfqTimeline(t, { savedOk: true }).catch(() => null)));
  const before = lines.some((line) => line?.days.some((x) => x.day < today && x.accounts.some((a) => a.leadId === leadId)));
  const tap: RaceTap = { id: `${leadId}:${today}`, email: d.rep.email.toLowerCase(), name: d.rep.name, leadId, company: lead?.display_name ?? "An account", at: now.toISOString(), day: today, first: newToUs && !before, ...(seen ? { how: seen.how } : {}) };
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
    if (have) { have.marked = have.marked || !tap.how; have.first = have.first || tap.first; }
    else day!.accounts.push({ leadId: tap.leadId, company: tap.company, how: tap.how ?? "marked", first: tap.first, marked: !tap.how });
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
  const [live, chat] = await Promise.all([saved ? withLiveLanes(saved, { taps }) : null, raceChat(ownerId, tz)]);
  return { now: now.toISOString(), day: localDay(tz, now).day, events: [...events.values()], lanes: live?.lanes, goal: live?.goal ?? GOAL, points: POINTS, chat };
}

// ---------- every call moves the dot right away (Walt 10/27: "each time a call is made or updated") ----------

type LiveCount = { dials: number; reached: number; lineCards: number };
const liveCache = new Map<string, { at: number; value: LiveCount }>();
const REACHED_TAPS = new Set(["reached_buyer", "got_name"]);

/** Today's calls and line cards as this app saved them (each outcome tap, each send): our own store, no Close reads. */
async function liveCount(rid: string, tz: string, now: Date): Promise<LiveCount> {
  const hit = liveCache.get(rid);
  if (hit && now.getTime() - hit.at < 2_500) return hit.value;
  const { since } = localDay(tz, now);
  const [items, sends] = await Promise.all([
    store.listReviews<{ callId?: string | null; outcome?: string; createdAt: string }>(rid, since.toISOString()).catch(() => []),
    store.getSetting<Record<string, { at: string }>>(rid, "lineCardSends").catch(() => null),
  ]);
  const calls = items.filter((it) => it.callId);
  const value = {
    dials: new Set(calls.map((it) => it.callId)).size,
    reached: calls.filter((it) => REACHED_TAPS.has(String(it.outcome))).length,
    lineCards: Object.values(sends ?? {}).filter((x) => Date.parse(x.at) >= since.getTime()).length,
  };
  liveCache.set(rid, { at: now.getTime(), value });
  return value;
}

/** The saved race with each rep's lane brought up to what's been tapped since: Close and the app each miss some, so
 * each number is the higher of the two. An RFQ tapped (or found in an email) since the last rebuild counts on the
 * live check too (Walt 10/27: "fix so it's always right"), unless someone's lane already has that company today. */
export async function withLiveLanes(race: Race, opts: { taps?: RaceTap[]; ownerId?: string } = {}): Promise<Race> {
  const now = new Date();
  const tz = race.lanes.find((l) => l.tz)?.tz ?? "America/Chicago";
  const taps = (opts.taps ?? (opts.ownerId ? await todaysTaps(opts.ownerId, tz, now).catch(() => []) : []))
    .filter((x) => x.day === race.day && x.first);
  const claimed = new Set(race.lanes.flatMap((l) => (l.rfqFrom ?? []).filter((c) => c.day === race.day).map((c) => c.leadId)));
  const lanes = await Promise.all(race.lanes.map(async (l) => {
    if (l.error) return l;
    const mine = taps.filter((x) => x.email === l.email && !claimed.has(x.leadId));
    const today = !!l.rid && !!l.tz && localDay(l.tz, now).day === race.day;
    const c = today ? await liveCount(l.rid!, l.tz!, now).catch(() => null) : null;
    if (!c && !mine.length) return l;
    const n = {
      dials: Math.max(l.dials, c?.dials ?? 0), reached: Math.max(l.reached, c?.reached ?? 0), lineCards: Math.max(l.lineCards, c?.lineCards ?? 0),
      rfqs: l.rfqs + mine.length, firstRfqs: l.firstRfqs + mine.length,
    };
    const points = scoreOf(n);
    const add = points - l.points;
    const rfqFrom = mine.length ? [...mine.map((x) => ({ leadId: x.leadId, company: x.company, day: x.day })), ...(l.rfqFrom ?? [])] : l.rfqFrom;
    const week = l.week && add > 0 ? {
      ...l.week, dials: l.week.dials + n.dials - l.dials, reached: l.week.reached + n.reached - l.reached,
      lineCards: l.week.lineCards + n.lineCards - l.lineCards, rfqs: l.week.rfqs + mine.length, points: l.week.points + add,
    } : l.week;
    return { ...l, ...n, points, rfqFrom, week };
  }));
  return { ...race, goal: race.goal ?? GOAL, lanes: lanes.sort((a, b) => b.points - a.points || b.dials - a.dials) };
}

// ---------- the West Game chat (Walt 10/27: "kind of funny to add like a chat") ----------

export type ChatMsg = { id: string; email: string; name: string; text: string; at: string; day: string };
const CHAT_KEY = "raceChat";

/** Today's messages, oldest first. Read with every live check, so a message shows on every screen within seconds. */
export async function raceChat(ownerId: string, tz: string): Promise<ChatMsg[]> {
  const today = localDay(tz, new Date()).day;
  return ((await store.getSetting<ChatMsg[]>(ownerId, CHAT_KEY).catch(() => null)) ?? []).filter((m) => m.day === today);
}

export async function postChat(ownerId: string, tz: string, who: { email: string; name: string }, text: string): Promise<ChatMsg[]> {
  const now = new Date();
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 280);
  if (!clean) return raceChat(ownerId, tz);
  const msg: ChatMsg = { id: `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, email: who.email, name: who.name, text: clean, at: now.toISOString(), day: localDay(tz, now).day };
  const kept = (await raceChat(ownerId, tz)).slice(-79);
  await store.putSetting(ownerId, CHAT_KEY, [...kept, msg]);
  return [...kept, msg];
}

// ---------- RFQs by email within seconds (Walt 10/27: "it takes like 15 minutes ... for the animation to come in") ----------

const SCAN_KEY = "race:emailScan";
const SCAN_MS = 30_000;

/** Time for another look at new emails? Read by every live check, so it's one store read. */
export async function rfqScanDue(): Promise<boolean> {
  const last = await store.cacheGet<string>(SCAN_KEY).catch(() => null);
  return !last || Date.now() - Date.parse(last) >= SCAN_MS;
}

/**
 * Emails that came in since the last look (one Close read every 30 seconds for the whole team): a buyer's real file,
 * or an RFQ in the words, from a company we've emailed and not a file we sent them, is an RFQ now, the same as a tap,
 * so every screen celebrates it within seconds. The full read later finds the same email and agrees.
 */
export async function scanForRfqs(team: Deps[], ownerId: string): Promise<RaceTap[]> {
  const now = new Date();
  const last = await store.cacheGet<string>(SCAN_KEY).catch(() => null);
  if (last && now.getTime() - Date.parse(last) < SCAN_MS) return [];
  await store.cacheSet(SCAN_KEY, now.toISOString(), 3600_000).catch(() => undefined);
  const reader = team.find((t) => t.rep.closeUserId === ownerId) ?? team[0];
  if (!reader) return [];
  const since = new Date(Math.max(Date.parse(last ?? "") || 0, now.getTime() - 10 * 60_000) - 60_000).toISOString();
  const { isBounce, rfqInBody } = await import("./accounts.js");
  const mails = await reader.close.listSince<Record<string, unknown>>("email", { since, fields: "id,lead_id,user_id,direction,sender,subject,date_created,attachments,body_text", max: 300 }).catch(() => []);
  const roster = await raceRoster(ownerId);
  const have = new Set((await todaysTaps(ownerId, reader.rep.timeZone, now)).map((x) => x.id));
  const found: RaceTap[] = [];
  for (const e of mails) {
    if (e.direction !== "incoming" || /@westgatesupply\.com/i.test(String(e.sender ?? "")) || isBounce(e as never)) continue;
    const t = team.find((x) => x.rep.closeUserId === e.user_id);
    if (!t || roster.excluded.includes(t.rep.email.toLowerCase())) continue;
    const leadId = String(e.lead_id ?? "");
    if (!leadId || have.has(`${leadId}:${localDay(t.rep.timeZone, new Date(String(e.date_created))).day}`)) continue;
    const files = theirFiles(e.attachments).filter((f) => !ADMIN_DOC.test(f) && !OUR_QUOTE.test(f));
    const words = !files.length && rfqInBody(e.subject as string, e.body_text as string);
    if (!files.length && !words) continue;
    const history = await t.close.leadEmails(leadId).catch(() => []);
    const sent = history.filter((h) => h.direction !== "incoming" && ["sent", "outbox"].includes(String(h.status)));
    if (!sent.length) continue; // only companies we've reached out to, like the RFQ count
    const ours = new Set(sent.flatMap((h) => ((h.attachments as Array<{ filename?: string }> | undefined) ?? []).map((a) => (a.filename ?? "").toLowerCase())));
    if (files.length && files.every((f) => ours.has(f.toLowerCase()))) continue; // our own quote coming back
    const tap = await recordRfqTap(team, ownerId, t, leadId, { how: files.length ? "file" : "email", at: String(e.date_created) }).catch(() => null);
    if (tap) { found.push(tap); have.add(tap.id); }
  }
  return found;
}

// ---------- the weekly leaderboard: each day's final standings, kept so the week knows who won each day ----------

type DayStanding = Array<{ email: string; name: string; points: number }>;
const dayKey = (day: string) => `raceday:${day}`;

/** Saves today's standings (the last copy of the day is the final one) and reads back who won each earlier day. */
async function weekDays(race: Race): Promise<RaceDay[]> {
  const standing: DayStanding = race.lanes.filter((l) => !l.error).map((l) => ({ email: l.email, name: l.name, points: l.points }));
  if (standing.some((x) => x.points > 0)) await store.cacheSet(dayKey(race.day), standing, 15 * 86_400_000).catch(() => undefined);
  const out: RaceDay[] = [];
  for (let t = Date.parse(`${weekStart(race.day)}T12:00:00Z`); ; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day >= race.day) break;
    const saved = await store.cacheGet<DayStanding>(dayKey(day)).catch(() => null);
    const top = (saved ?? []).filter((x) => x.points > 0).sort((a, b) => b.points - a.points)[0] ?? null;
    out.push({ day, winner: top });
  }
  return out;
}
