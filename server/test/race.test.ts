import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { GOAL, POINTS, postChat, raceLive, raceRoster, setRaceRoster, teamRace, withLiveLanes } from "../src/race.js";
import { store } from "../src/store.js";

// The BDR race (10/25): a lane per rep, the car moves with dials, points decide the winner, RFQs are celebrated.
const rep = (name: string, email: string, id: string) => ({ name, email, closeUserId: id, timeZone: "America/Chicago" });

test("points: 180 calls and 20 line cards finish, an RFQ is worth 15; the roster leaves people out; a broken Close login is a flagged lane", async () => {
  assert.equal(GOAL, 370);
  assert.equal(POINTS.rfq, 30);
  // Walt's finishing days: 200 calls and 85 line cards; 160 calls, 70 line cards and 3 RFQs; 8 RFQs, 100 calls, 15 cards.
  assert.equal(200 * POINTS.dial + 85 * POINTS.lineCard, GOAL);
  assert.ok(160 * POINTS.dial + 70 * POINTS.lineCard + 3 * POINTS.rfq >= GOAL);
  assert.equal(100 * POINTS.dial + 15 * POINTS.lineCard + 8 * POINTS.rfq, GOAL);
  assert.equal(Math.round(100 * (119 + 47 * POINTS.lineCard + 4 * POINTS.rfq) / GOAL), 90, "Chase 10/27: 90%");
  assert.ok(349 * POINTS.dial < GOAL, "never on calls alone");
  const ownerId = "user_race_owner";
  assert.deepEqual((await raceRoster(ownerId)).excluded, ["sales@westgatesupply.com"], "Work Trial starts out");
  const ok = new FakeClose();
  const broken = new FakeClose();
  broken.listSince = (async () => { throw new Error("Close GET /activity/note/ failed (403): User has no access to this organization."); }) as never;
  const team: Deps[] = [
    { close: ok, llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", ownerId) },
    { close: broken, llm: demoLlm, rep: rep("Ulysses Vazquez-Perez", "ulysses@westgatesupply.com", "user_race_u") },
    { close: new FakeClose(), llm: demoLlm, rep: rep("Work Trial", "sales@westgatesupply.com", "user_race_wt") },
  ] as never;
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, ownerId, { fresh: true });
  assert.deepEqual(race.lanes.map((l) => l.first).sort(), ["Ulysses", "Walt"], "Work Trial isn't racing");
  const u = race.lanes.find((l) => l.first === "Ulysses")!;
  assert.equal(u.error, "Close login needs fixing");
  assert.equal(u.points, 0);
  const w = race.lanes.find((l) => l.first === "Walt")!;
  assert.equal(w.points, w.dials * POINTS.dial + w.reached * POINTS.reached + w.lineCards * POINTS.lineCard + w.rfqs * POINTS.rfq + w.firstRfqs * POINTS.firstRfq);
  await setRaceRoster(ownerId, "ulysses@westgatesupply.com", false);
  const again = await teamRace(team, ownerId, { fresh: true });
  assert.deepEqual(again.lanes.map((l) => l.first), ["Walt"], "Walt took Ulysses out of the race");
  await setRaceRoster(ownerId, "ulysses@westgatesupply.com", true);
  assert.deepEqual((await raceRoster(ownerId)).excluded, ["sales@westgatesupply.com"]);
});

test("West Game: a guest plays while their link is on; their calls are the marks on their list, line cards their sends", async () => {
  const { createGuest, setGuestActive, putList, listGuests } = await import("../src/guests.js");
  const ownerId = "user_wg_owner";
  const team: Deps[] = [{ close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", ownerId) }] as never;
  const { guest } = await createGuest(ownerId, "Dana Trial");
  await putList(ownerId, guest, { rows: [{ company: "A Co", phone: "5551110000" }, { company: "B Co", phone: "5551110001" }, { company: "C Co", phone: "5551110002" }] });
  const list = (await store.getSetting<{ leads: Array<Record<string, unknown>> }>(ownerId, `guestList:${guest.id}`))!;
  const now = new Date().toISOString();
  Object.assign(list.leads[0], { outcome: "Reached buyer", outcomeAt: now });
  Object.assign(list.leads[1], { outcome: "Voicemail", outcomeAt: now });
  await store.putSetting(ownerId, `guestList:${guest.id}`, list);
  const guests = await listGuests(ownerId);
  guests.find((g) => g.id === guest.id)!.sends.push({ at: now, company: "A Co", to: "buyer@aco.com", name: null, leadId: "lead_aco", newLead: false });
  await store.putSetting(ownerId, "guests", guests);

  const race = await teamRace(team, ownerId, { fresh: true });
  const lane = race.lanes.find((l) => l.email === `guest:${guest.id}`)!;
  assert.ok(lane.guest);
  assert.deepEqual([lane.dials, lane.reached, lane.lineCards], [2, 1, 1]);
  assert.equal(lane.points, 2 * POINTS.dial + POINTS.reached + POINTS.lineCard);

  // A new list mid-day doesn't wipe the calls already made (10/27: Micah went to 0). Since 11/10 a sheet stacks onto
  // the list, so the calls simply stay on it; replacing the list keeps them aside.
  await putList(ownerId, guest, { name: "Noon", rows: [{ company: "E Co", phone: "5551110004" }] });
  const stacked = (await teamRace(team, ownerId, { fresh: true })).lanes.find((l) => l.email === `guest:${guest.id}`)!;
  assert.deepEqual([stacked.dials, stacked.reached], [2, 1], "stacked: the morning's calls are still on the list");
  await putList(ownerId, guest, { name: "Afternoon", rows: [{ company: "D Co", phone: "5551110003" }] }, { mode: "replace" });
  const after = (await teamRace(team, ownerId, { fresh: true })).lanes.find((l) => l.email === `guest:${guest.id}`)!;
  assert.deepEqual([after.dials, after.reached], [2, 1], "the morning's calls still count");
  const { earlierCalls } = await import("../src/guests.js");
  assert.deepEqual((await earlierCalls(ownerId, guest.id)).map((x) => x.company), ["A Co", "B Co"]);

  await setGuestActive(ownerId, guest.id, false);
  const off = await teamRace(team, ownerId, { fresh: true });
  assert.ok(!off.lanes.some((l) => l.guest), "a switched-off link doesn't play");
});

test("West Game: an RFQ two people both have goes to the one who marked it came in, once (10/26: Haley Contracting)", async () => {
  const { localDay } = await import("../src/stats.js");
  const walt = "user_wg_walt2", chase = "user_wg_chase2";
  const team: Deps[] = [
    { close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", walt) },
    { close: new FakeClose(), llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", chase) },
  ] as never;
  const today = localDay("America/Chicago", new Date()).day;
  const line = (how: string, marked = false) => ({ since: today, total: 1, thisWeek: 1, lastWeek: 0, firstToday: 1, firstThisWeek: 1, companies: 1, newThisWeek: 1, newLastWeek: 0, newThisMonth: 1, newLastMonth: 0, at: new Date().toISOString(),
    days: [{ day: today, count: 1, total: 1, newCompanies: 1, companiesTotal: 1, accounts: [{ leadId: "lead_haley", company: "Haley Contracting", how, first: true, marked }] }] });
  await store.cacheSet(`rfqline:${walt}`, line("file"), 3600_000);
  // The file landed in Chase's account too before he tapped "RFQ came in": found by file, but marked.
  await store.cacheSet(`rfqline:${chase}`, line("file", true), 3600_000);
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, walt, { fresh: true });
  const w = race.lanes.find((l) => l.first === "Walt")!, c = race.lanes.find((l) => l.first === "Chase")!;
  assert.deepEqual([c.rfqs, c.firstRfqs, w.rfqs, w.firstRfqs], [1, 1, 0, 0]);
  assert.deepEqual(c.rfqFrom?.map((x) => x.company), ["Haley Contracting"], "clicking Chase shows who it came from");
  assert.deepEqual(w.rfqFrom ?? [], [], "and it's off Walt's list");
  assert.equal(race.events.filter((e) => e.company === "Haley Contracting").length, 1, "celebrated once");
  assert.equal(race.events.find((e) => e.company === "Haley Contracting")!.email, "chase@westgatesupply.com");
});

test("West Game: an RFQ tap scores right away with one showtime for every screen; established customers don't score (10/26)", async () => {
  const { recordRfqTap, raceLive, SHOW_DELAY_MS } = await import("../src/race.js");
  const { localDay } = await import("../src/stats.js");
  const owner = "user_wg_tap_owner";
  const close = new FakeClose();
  const fresh = new Date(Date.now() - 5 * 86_400_000).toISOString(), old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  close.lead = (async (id: string) => ({ id, display_name: id === "lead_new" ? "Brand New Co" : id === "lead_new2" ? "Second New Co" : "Old Customer Inc", date_created: id.startsWith("lead_new") ? fresh : old })) as never;
  const team: Deps[] = [{ close, llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", owner) }] as never;
  const today = localDay("America/Chicago", new Date()).day;
  await store.cacheSet(`rfqline:${owner}`, { since: today, total: 0, thisWeek: 0, lastWeek: 0, firstToday: 0, firstThisWeek: 0, companies: 0, newThisWeek: 0, newLastWeek: 0, newThisMonth: 0, newLastMonth: 0, at: new Date().toISOString(), days: [] }, 3600_000);
  await store.cacheSet("race:team", null, 1);

  const tap = (await recordRfqTap(team, owner, team[0], "lead_new"))!;
  assert.equal(tap.first, true, "added to Close 5 days ago, no RFQ before: new");
  const oldTap = (await recordRfqTap(team, owner, team[0], "lead_old"))!;
  assert.equal(oldTap.first, false, "in Close for over a year: established");

  const live = await raceLive(owner, "America/Chicago");
  assert.deepEqual(live.events.map((e) => e.company), ["Brand New Co"], "only the new company celebrates");
  assert.equal(Date.parse(live.events[0].showAt!) - Date.parse(tap.at), SHOW_DELAY_MS, "one showtime, from the tap");

  const race = await teamRace(team, owner, { fresh: true });
  const c = race.lanes.find((l) => l.first === "Chase")!;
  assert.deepEqual([c.rfqs, c.firstRfqs], [1, 1], "the tap counts before Close is read again; the old customer doesn't");
  assert.equal(race.events.find((e) => e.company === "Brand New Co")!.showAt, live.events[0].showAt, "the full copy keeps the same showtime");

  // A tap after the last rebuild counts on the very next live check (10/27: "fix so it's always right"), once.
  await store.cacheSet("race:team", race, 3600_000);
  const later = (await recordRfqTap(team, owner, team[0], "lead_new2"))!;
  const lane = (await raceLive(owner, "America/Chicago")).lanes!.find((l) => l.first === "Chase")!;
  assert.equal(later.first, true);
  assert.equal(lane.rfqs, 2, "counted before the rebuild");
  assert.equal(lane.points - c.points, POINTS.rfq, "and scored");
  assert.ok(lane.rfqFrom!.some((x) => x.leadId === "lead_new2"), "and named");
  const again = (await withLiveLanes(race, { ownerId: owner })).lanes.find((l) => l.first === "Chase")!;
  assert.equal(again.rfqs, 2, "the one already in the lane isn't counted twice");
});

test("every tapped call moves the dot before Close is read again, and the chat reaches every screen (10/27)", async () => {
  const ownerId = "user_live_owner";
  const team: Deps[] = [{ close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", ownerId) }] as never;
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, ownerId);
  const before = race.lanes[0];
  for (const [i, outcome] of ["voicemail", "reached_buyer", "no_answer"].entries()) {
    await store.putReview({ id: `live_${i}`, repId: ownerId, leadId: `lead_live_${i}`, callId: `acti_live_${i}`, state: "saved", outcome, createdAt: new Date().toISOString() });
  }
  // A failed build from days ago comes back from the store whatever the date asked for; it isn't one of today's calls.
  await store.putReview({ id: "live_old", repId: ownerId, leadId: "lead_live_old", callId: "acti_live_old", state: "failed", outcome: "no_answer", createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  await new Promise((r) => setTimeout(r, 2600)); // past the few-second count cache
  const after = (await withLiveLanes(race)).lanes[0];
  assert.equal(after.dials, Math.max(before.dials, 3));
  assert.equal(after.points, before.points + (after.dials - before.dials) * POINTS.dial);
  const live = await raceLive(ownerId, "America/Chicago");
  assert.equal(live.lanes?.[0].dials, after.dials, "the live check carries the lanes");
  assert.equal(live.goal, GOAL);
  await postChat(ownerId, "America/Chicago", { email: "walt@westgatesupply.com", name: "Walt Boxwell" }, "  Chase   is cooked  ");
  const chat = (await raceLive(ownerId, "America/Chicago")).chat;
  assert.equal(chat.at(-1)?.text, "Chase is cooked");
  assert.equal(chat.at(-1)?.name, "Walt Boxwell");
});

test("the weekly leaderboard knows who won each earlier day (10/27)", async () => {
  const ownerId = "user_board_owner";
  const team: Deps[] = [{ close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", ownerId) }] as never;
  await store.cacheSet("race:team", null, 1);
  const first = await teamRace(team, ownerId);
  const monday = first.weekDays?.[0]?.day;
  if (!monday) return; // a Monday: no earlier days this week yet
  await store.cacheSet(`raceday:${monday}`, [{ email: "chase@westgatesupply.com", name: "Chase Bent", points: 190 }, { email: "walt@westgatesupply.com", name: "Walt Boxwell", points: 40 }], 60_000);
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, ownerId);
  assert.deepEqual(race.weekDays?.[0], { day: monday, winner: { email: "chase@westgatesupply.com", name: "Chase Bent", points: 190 } });
});

test("a purchase order coming in isn't an RFQ (10/27: Fabricon's PO counted as one)", async () => {
  const { ADMIN_DOC } = await import("../src/stats.js");
  for (const f of ["WESTGATE PO#25-114-13519.pdf", "Purchase Order 12.pdf", "P.O. 4471.pdf"]) assert.ok(ADMIN_DOC.test(f), f);
  for (const f of ["Copy of HHWT - Commodities Pricing Exercise - Take-Off 7.13.26.xlsx", "RFQ 2231 pipe.pdf", "Pool equipment.pdf", "Portland plant.pdf"]) assert.ok(!ADMIN_DOC.test(f), f);
});

test("the live check is one shared copy (11/9): screens read the saved row, a tap or a post drops it, the full load reuses its lanes", async () => {
  const { raceWithLive, recordRfqTap } = await import("../src/race.js");
  const ownerId = "user_live_shared";
  const close = new FakeClose();
  const fresh = new Date(Date.now() - 5 * 86_400_000).toISOString();
  close.lead = (async (id: string) => ({ id, display_name: "Shared Co", date_created: fresh })) as never;
  const team: Deps[] = [{ close, llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", ownerId) }] as never;
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, ownerId);

  // Count what the store is asked for: the second check and the full load read the one saved copy.
  const s = store as unknown as { getSetting: (...a: unknown[]) => Promise<unknown>; listReviews: (...a: unknown[]) => Promise<unknown> };
  const real = { getSetting: s.getSetting, listReviews: s.listReviews };
  let reads = 0;
  s.getSetting = function (...a: unknown[]) { reads++; return real.getSetting.apply(this, a); };
  s.listReviews = function (...a: unknown[]) { reads++; return real.listReviews.apply(this, a); };
  try {
    const first = await raceLive(ownerId, "America/Chicago");
    const built = reads;
    assert.ok(built >= 3, `working it out reads the taps, the chat and the lanes (${built})`);
    await new Promise((r) => setTimeout(r, 5));
    const second = await raceLive(ownerId, "America/Chicago");
    assert.equal(reads, built, "the next check reads nothing new");
    assert.deepEqual({ ...second, now: "" }, { ...first, now: "" }, "the same copy");
    assert.notEqual(second.now, first.now, "with this moment's clock");
    const full = await raceWithLive(race, ownerId, "America/Chicago");
    assert.equal(reads, built, "the full load reuses the copy's lanes");
    assert.deepEqual(full.lanes, second.lanes);
    assert.equal(full.goal, GOAL);

    // A tap drops the copy: the very next check carries it.
    await store.cacheSet(`rfqline:${ownerId}`, { since: second.day, total: 0, thisWeek: 0, lastWeek: 0, firstToday: 0, firstThisWeek: 0, companies: 0, newThisWeek: 0, newLastWeek: 0, newThisMonth: 0, newLastMonth: 0, at: new Date().toISOString(), days: [] }, 3600_000);
    const tap = (await recordRfqTap(team, ownerId, team[0], "lead_shared"))!;
    const after = await raceLive(ownerId, "America/Chicago");
    assert.ok(after.events.some((e) => e.id === tap.id), "the tap is on the next check");
    assert.ok(reads > built, "worked out again");
    const n = reads;
    await postChat(ownerId, "America/Chicago", { email: "walt@westgatesupply.com", name: "Walt Boxwell" }, "shared copy says hi");
    assert.equal((await raceLive(ownerId, "America/Chicago")).chat.at(-1)?.text, "shared copy says hi", "a post is on the next check");
    assert.ok(reads > n);
  } finally {
    s.getSetting = real.getSetting;
    s.listReviews = real.listReviews;
  }
});

test("an RFQ counts for the inbox it came to (11/10: Global Welding), whoever else emailed or tapped, and the decision is written down", async () => {
  const { localDay } = await import("../src/stats.js");
  const { rfqCredits } = await import("../src/race.js");
  const walt = "user_wg_walt3", jacob = "user_wg_jacob3";
  const team: Deps[] = [
    { close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", walt) },
    { close: new FakeClose(), llm: demoLlm, rep: rep("Jacob Lizarraga", "jacob@westgatesupply.com", jacob) },
  ] as never;
  const today = localDay("America/Chicago", new Date()).day;
  const line = (extra: Record<string, unknown>) => ({ since: today, total: 1, thisWeek: 1, lastWeek: 0, firstToday: 1, firstThisWeek: 1, companies: 1, newThisWeek: 1, newLastWeek: 0, newThisMonth: 1, newLastMonth: 0, at: new Date().toISOString(),
    days: [{ day: today, count: 1, total: 1, newCompanies: 1, companiesTotal: 1, accounts: [{ leadId: "lead_gws", company: "Global Welding Services", how: "email", first: true, to: walt, ...extra }] }] });
  // Helen's list came to Walt. Jacob replied, so the company is on his line too, and he tapped "RFQ came in".
  await store.cacheSet(`rfqline:${walt}`, line({ card: true }), 3600_000);
  await store.cacheSet(`rfqline:${jacob}`, line({ marked: true }), 3600_000);
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, walt, { fresh: true });
  const w = race.lanes.find((l) => l.first === "Walt")!, j = race.lanes.find((l) => l.first === "Jacob")!;
  assert.deepEqual([w.rfqs, j.rfqs], [1, 0], "Walt's inbox, Walt's RFQ");
  assert.deepEqual(j.rfqFrom ?? [], []);
  assert.equal(race.events.find((e) => e.company === "Global Welding Services")!.email, "walt@westgatesupply.com");
  const credits = await rfqCredits(walt);
  assert.deepEqual([credits[`lead_gws|${today}`]?.rep, credits[`lead_gws|${today}`]?.why], ["walt@westgatesupply.com", "came to their inbox"]);
  // Only Jacob's line has caught it so far (Walt's refreshes later): still not Jacob's.
  await store.cacheSet(`rfqline:${walt}`, { ...line({}), days: [] }, 3600_000);
  await store.cacheSet("race:team", null, 1);
  const lag = await teamRace(team, walt, { fresh: true });
  assert.equal(lag.lanes.find((l) => l.first === "Jacob")!.rfqs, 0, "an RFQ to Walt's inbox never scores for Jacob");
});

test("a decided RFQ holds on every rebuild (11/10: credit moved as lines refreshed and people tapped)", async () => {
  const { localDay } = await import("../src/stats.js");
  const walt = "user_wg_walt4", chase = "user_wg_chase4";
  const team: Deps[] = [
    { close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", walt) },
    { close: new FakeClose(), llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", chase) },
  ] as never;
  const today = localDay("America/Chicago", new Date()).day;
  const line = (marked: boolean) => ({ since: today, total: 1, thisWeek: 1, lastWeek: 0, firstToday: 1, firstThisWeek: 1, companies: 1, newThisWeek: 1, newLastWeek: 0, newThisMonth: 1, newLastMonth: 0, at: new Date().toISOString(), inboxes: true,
    days: [{ day: today, count: 1, total: 1, newCompanies: 1, companiesTotal: 1, accounts: [{ leadId: "lead_phone", company: "Phone RFQ Co", how: "file", first: true, marked }] }] });
  // The file landed in a shared mailbox, so it's on both lines with no inbox to go by: Chase tapped it first, so it's his, and that's written down.
  await store.cacheSet(`rfqline:${walt}`, line(false), 3600_000);
  await store.cacheSet(`rfqline:${chase}`, line(true), 3600_000);
  await store.cacheSet("race:team", null, 1);
  const first = await teamRace(team, walt, { fresh: true });
  assert.deepEqual([first.lanes.find((l) => l.first === "Walt")!.rfqs, first.lanes.find((l) => l.first === "Chase")!.rfqs], [0, 1]);
  // Later Walt taps it too and Chase's line refreshes without the mark: it stays Chase's.
  await store.cacheSet(`rfqline:${walt}`, line(true), 3600_000);
  await store.cacheSet(`rfqline:${chase}`, line(false), 3600_000);
  await store.cacheSet("race:team", null, 1);
  const again = await teamRace(team, walt, { fresh: true });
  assert.deepEqual([again.lanes.find((l) => l.first === "Walt")!.rfqs, again.lanes.find((l) => l.first === "Chase")!.rfqs], [0, 1], "decided once, kept");
});

test("the first time the ledger runs, the days already on the board stay as they stood (11/10: don't lose the current stats)", async () => {
  const { localDay } = await import("../src/stats.js");
  const { rfqCredits } = await import("../src/race.js");
  const walt = "user_wg_walt5", chase = "user_wg_chase5";
  const team: Deps[] = [
    { close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", walt) },
    { close: new FakeClose(), llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", chase) },
  ] as never;
  const today = localDay("America/Chicago", new Date()).day;
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  // Yesterday's board had Tate under Chase. Under the new rule it'd be Walt's (his inbox), but what stood, stands.
  await store.cacheSet("race:team", { at: new Date().toISOString(), day: today, goal: 100, lanes: [
    { email: "walt@westgatesupply.com", name: "Walt Boxwell", first: "Walt", dials: 0, reached: 0, lineCards: 0, rfqs: 0, firstRfqs: 0, points: 0, week: null, error: null, rfqFrom: [] },
    { email: "chase@westgatesupply.com", name: "Chase Bent", first: "Chase", dials: 0, reached: 0, lineCards: 0, rfqs: 1, firstRfqs: 1, points: 15, week: null, error: null, rfqFrom: [{ leadId: "lead_tate", company: "Tate Fabricating", day: yesterday }] },
  ], events: [], chat: [] }, 3600_000);
  const line = () => ({ since: yesterday, total: 1, thisWeek: 1, lastWeek: 0, firstToday: 0, firstThisWeek: 1, companies: 1, newThisWeek: 1, newLastWeek: 0, newThisMonth: 1, newLastMonth: 0, at: new Date().toISOString(),
    days: [{ day: yesterday, count: 1, total: 1, newCompanies: 1, companiesTotal: 1, accounts: [{ leadId: "lead_tate", company: "Tate Fabricating", how: "email", first: true, to: walt }] }, { day: today, count: 0, total: 1, newCompanies: 0, companiesTotal: 1, accounts: [] }] });
  await store.cacheSet(`rfqline:${walt}`, line(), 3600_000);
  await store.cacheSet(`rfqline:${chase}`, line(), 3600_000);
  // With a copy on the board the rebuild runs behind it: wait for the ledger to show the rebuild has run.
  await teamRace(team, walt, { fresh: true, force: true });
  let credits = await rfqCredits(walt);
  for (let i = 0; i < 60 && !credits[`lead_tate|${yesterday}`]; i++) { await new Promise((r) => setTimeout(r, 50)); credits = await rfqCredits(walt); }
  assert.equal(credits[`lead_tate|${yesterday}`]?.rep, "chase@westgatesupply.com", "written down as it stood");
  const race = (await store.cacheGet<{ lanes: Array<{ first: string; rfqFrom?: Array<{ company: string }> }> }>("race:team"))!;
  const w = race.lanes.find((l) => l.first === "Walt")!, c = race.lanes.find((l) => l.first === "Chase")!;
  assert.deepEqual([w.rfqFrom?.map((x) => x.company) ?? [], c.rfqFrom?.map((x) => x.company)], [[], ["Tate Fabricating"]], "yesterday stays Chase's");
});

test("a guest's RFQ counts once, for the guest (11/10: EN-FAB came off Walt's lane twice and scored for Chase and Jameson both)", async () => {
  const { localDay } = await import("../src/stats.js");
  const { createGuest } = await import("../src/guests.js");
  const walt = "user_wg_walt6", chase = "user_wg_chase6";
  const team: Deps[] = [
    { close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", walt) },
    { close: new FakeClose(), llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", chase) },
  ] as never;
  const { guest } = await createGuest(walt, "Jameson");
  await store.putSetting(walt, `guestLeadIds:${guest.id}`, { "1": "lead_enfab" });
  const today = localDay("America/Chicago", new Date()).day;
  const line = (accounts: Array<Record<string, unknown>>) => ({ since: today, total: accounts.length, thisWeek: accounts.length, lastWeek: 0, firstToday: accounts.length, firstThisWeek: accounts.length, companies: accounts.length, newThisWeek: accounts.length, newLastWeek: 0, newThisMonth: accounts.length, newLastMonth: 0, at: new Date().toISOString(), inboxes: true,
    days: [{ day: today, count: accounts.length, total: accounts.length, newCompanies: accounts.length, companiesTotal: accounts.length, accounts }] });
  // Jameson sent EN-FAB the line card from Walt's account and the RFQ came back to Walt's inbox. Chase's board set the
  // lead to RFQ Received (it's his by the hand-off rule), so his line caught it as marked. Sistersville is Walt's own.
  await store.cacheSet(`rfqline:${walt}`, line([{ leadId: "lead_enfab", company: "EN-FAB", how: "file", first: true, to: walt, card: true }, { leadId: "lead_stw", company: "Sistersville Tank Works", how: "file", first: true, to: walt }]), 3600_000);
  await store.cacheSet(`rfqline:${chase}`, line([{ leadId: "lead_enfab", company: "EN-FAB", how: "marked", first: true }]), 3600_000);
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, walt, { fresh: true });
  const w = race.lanes.find((l) => l.first === "Walt")!, c = race.lanes.find((l) => l.first === "Chase")!, j = race.lanes.find((l) => l.email === `guest:${guest.id}`)!;
  assert.deepEqual([w.rfqs, c.rfqs, j.rfqs], [1, 0, 1], "Walt's inbox, Jameson's company: Jameson's RFQ");
  assert.deepEqual([w.rfqFrom?.map((x) => x.company), j.rfqFrom?.map((x) => x.company), c.rfqFrom ?? []], [["Sistersville Tank Works"], ["EN-FAB"], []]);
  assert.equal(w.rfqs, w.rfqFrom!.filter((x) => x.day === today).length, "the number is the list");
  assert.deepEqual(race.events.filter((e) => e.company === "EN-FAB").map((e) => e.email), [`guest:${guest.id}`], "celebrated once, for Jameson");
});

test("an old line copy with no inboxes can show a tiebreak but not write it down (11/10); the host's number always matches the list", async () => {
  const { localDay } = await import("../src/stats.js");
  const { createGuest } = await import("../src/guests.js");
  const { rfqCredits } = await import("../src/race.js");
  const walt = "user_wg_walt7", chase = "user_wg_chase7";
  const team: Deps[] = [
    { close: new FakeClose(), llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", walt) },
    { close: new FakeClose(), llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", chase) },
  ] as never;
  const { guest } = await createGuest(walt, "Jameson");
  await store.putSetting(walt, `guestLeadIds:${guest.id}`, { "1": "lead_enfab" });
  const today = localDay("America/Chicago", new Date()).day;
  const line = (accounts: Array<Record<string, unknown>>, inboxes: boolean) => ({ since: today, total: accounts.length, thisWeek: accounts.length, lastWeek: 0, firstToday: accounts.length, firstThisWeek: accounts.length, companies: accounts.length, newThisWeek: accounts.length, newLastWeek: 0, newThisMonth: accounts.length, newLastMonth: 0, at: new Date().toISOString(), ...(inboxes ? { inboxes: true } : {}),
    days: [{ day: today, count: accounts.length, total: accounts.length, newCompanies: accounts.length, companiesTotal: accounts.length, accounts }] });
  // Copies from before the inbox was kept: nothing says whose inbox EN-FAB came to. Chase tapped it, so for now it reads as his.
  await store.cacheSet(`rfqline:${walt}`, line([{ leadId: "lead_enfab", company: "EN-FAB", how: "file", first: true }, { leadId: "lead_other", company: "Other Co", how: "email", first: true }], false), 3600_000);
  await store.cacheSet(`rfqline:${chase}`, line([{ leadId: "lead_enfab", company: "EN-FAB", how: "file", first: true, marked: true }], false), 3600_000);
  await store.cacheSet("race:team", null, 1);
  const stale = await teamRace(team, walt, { fresh: true });
  const lane = (r: typeof stale, who: string) => r.lanes.find((l) => l.first === who || l.email === `guest:${guest.id}` && who === "Jameson")!;
  assert.deepEqual([lane(stale, "Walt").rfqs, lane(stale, "Chase").rfqs, lane(stale, "Jameson").rfqs], [1, 1, 0], "shown as Chase's for now");
  assert.deepEqual(lane(stale, "Walt").rfqFrom?.map((x) => x.company), ["Other Co"], "Walt's number is his list, not one short of it");
  assert.equal((await rfqCredits(walt))[`lead_enfab|${today}`], undefined, "not written down from an old copy");
  // The lines refresh and say whose inbox it came to: Walt's, so it's Jameson's, and that's what's written down.
  await store.cacheSet(`rfqline:${walt}`, line([{ leadId: "lead_enfab", company: "EN-FAB", how: "file", first: true, to: walt, card: true }, { leadId: "lead_other", company: "Other Co", how: "email", first: true, to: walt }], true), 3600_000);
  await store.cacheSet(`rfqline:${chase}`, line([{ leadId: "lead_enfab", company: "EN-FAB", how: "file", first: true, marked: true }], true), 3600_000);
  await store.cacheSet("race:team", null, 1);
  const fresh = await teamRace(team, walt, { fresh: true });
  assert.deepEqual([lane(fresh, "Walt").rfqs, lane(fresh, "Chase").rfqs, lane(fresh, "Jameson").rfqs], [1, 0, 1]);
  assert.equal((await rfqCredits(walt))[`lead_enfab|${today}`]?.why, "came to their inbox");
});

test("an inbox settles an RFQ only when its owner emailed the company (11/10: Novus came to Berni's inbox and scored for nobody)", async () => {
  const { localDay } = await import("../src/stats.js");
  const { rfqCredits } = await import("../src/race.js");
  const jacob = "user_wg_jacob8", berni = "user_wg_berni8";
  const team: Deps[] = [
    { close: new FakeClose(), llm: demoLlm, rep: rep("Jacob Lizarraga", "jacob@westgatesupply.com", jacob) },
    { close: new FakeClose(), llm: demoLlm, rep: rep("Berni Ortiz", "berni@westgatesupply.com", berni) },
  ] as never;
  const today = localDay("America/Chicago", new Date()).day;
  const line = (accounts: Array<Record<string, unknown>>) => ({ since: today, total: accounts.length, thisWeek: accounts.length, lastWeek: 0, firstToday: accounts.length, firstThisWeek: accounts.length, companies: accounts.length, newThisWeek: accounts.length, newLastWeek: 0, newThisMonth: accounts.length, newLastMonth: 0, at: new Date().toISOString(), inboxes: true,
    days: [{ day: today, count: accounts.length, total: accounts.length, newCompanies: accounts.length, companiesTotal: accounts.length, accounts }] });
  // Jacob emailed Novus; their file came to Berni's inbox, who never wrote to them. Jacob tapped it.
  await store.cacheSet(`rfqline:${jacob}`, line([{ leadId: "lead_novus", company: "Novus Process", how: "file", first: true, to: berni, marked: true, card: true }]), 3600_000);
  await store.cacheSet(`rfqline:${berni}`, line([]), 3600_000);
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, jacob, { fresh: true });
  assert.deepEqual([race.lanes.find((l) => l.first === "Jacob")!.rfqs, race.lanes.find((l) => l.first === "Berni")!.rfqs], [1, 0], "Jacob's: he worked it");
  assert.equal((await rfqCredits(jacob))[`lead_novus|${today}`], undefined, "left open, in case Berni's line catches it");
});
