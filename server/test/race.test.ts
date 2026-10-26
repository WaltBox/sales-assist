import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { POINTS, raceRoster, setRaceRoster, teamRace } from "../src/race.js";
import { store } from "../src/store.js";

// The BDR race (10/25): a lane per rep, the car moves with dials, points decide the winner, RFQs are celebrated.
const rep = (name: string, email: string, id: string) => ({ name, email, closeUserId: id, timeZone: "America/Chicago" });

test("points: an RFQ is worth 50 dials; the roster leaves people out; a broken Close login is a flagged lane", async () => {
  assert.equal(POINTS.rfq, 50 * POINTS.dial);
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
