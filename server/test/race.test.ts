import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { GOAL, POINTS, postChat, raceLive, raceRoster, setRaceRoster, teamRace, withLiveLanes } from "../src/race.js";
import { store } from "../src/store.js";

// The BDR race (10/25): a lane per rep, the car moves with dials, points decide the winner, RFQs are celebrated.
const rep = (name: string, email: string, id: string) => ({ name, email, closeUserId: id, timeZone: "America/Chicago" });

test("points: 180 calls and 20 line cards finish, an RFQ is worth 15; the roster leaves people out; a broken Close login is a flagged lane", async () => {
  assert.equal(GOAL, 180 * POINTS.dial + 20 * POINTS.lineCard);
  assert.equal(POINTS.rfq, 15);
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
  close.lead = (async (id: string) => ({ id, display_name: id === "lead_new" ? "Brand New Co" : "Old Customer Inc", date_created: id === "lead_new" ? fresh : old })) as never;
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
