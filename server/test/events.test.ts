import assert from "node:assert/strict";
import { test } from "node:test";
import { careerFor, eventsOf } from "../src/events.js";
import { RUNG_POINTS } from "../src/ladder.js";
import { store } from "../src/store.js";

const facts = {
  day: "2026-11-11",
  calls: [{ id: "acti_1", leadId: "lead_a", at: "2026-11-11T15:00:00Z" }, { id: "acti_2", leadId: "lead_b", at: "2026-11-11T15:10:00Z" }, { id: "acti_3", leadId: "lead_a", at: "2026-11-11T16:00:00Z" }],
  named: [{ leadId: "lead_a", at: "2026-11-11T15:05:00Z" }],
  cards: [{ leadId: "lead_a", at: "2026-11-11T15:06:00Z" }],
  reached: [{ leadId: "lead_b", at: "2026-11-11T15:12:00Z" }],
};

test("the day's events (11/11): a row per dial, per rung per company, per RFQ, with what each paid; ids are stable so a rewrite never doubles", () => {
  const rows = eventsOf("user_w", facts, [{ leadId: "lead_b", company: "Beta Vessels", first: true }], (id) => (id === "lead_a" ? "Acme Fab" : null));
  assert.deepEqual(rows.map((r) => r.kind), ["dial", "dial", "dial", "named", "card", "reached", "rfq"]);
  assert.equal(rows.reduce((n, r) => n + r.points, 0), 3 * RUNG_POINTS.dial + RUNG_POINTS.named + RUNG_POINTS.card + RUNG_POINTS.reached + RUNG_POINTS.rfq + RUNG_POINTS.firstRfq);
  assert.equal(rows.find((r) => r.kind === "named")!.company, "Acme Fab");
  assert.equal(rows.find((r) => r.kind === "rfq")!.id, "user_w:lead_b:rfq:2026-11-11");
  assert.deepEqual(eventsOf("user_w", facts, []).map((r) => r.id), rows.slice(0, 6).map((r) => r.id));
});

test("a season from the table: all time, this month, the best day and the RFQ list", async () => {
  const rows = [
    ...eventsOf("user_season", facts, [{ leadId: "lead_b", company: "Beta Vessels", first: true }]),
    ...eventsOf("user_season", { ...facts, day: "2026-10-27", calls: facts.calls.map((c) => ({ ...c, id: `${c.id}_oct`, at: "2026-10-27T15:00:00Z" })), named: [], cards: [], reached: [] }, [{ leadId: "lead_c", company: "Gamma", first: false }, { leadId: "lead_d", company: "Delta", first: true }]),
  ];
  await store.putRungEvents(rows);
  const c = await careerFor("user_season", "America/Chicago", new Date("2026-11-12T15:00:00Z"));
  assert.equal(c.since, "2026-10-27");
  assert.equal(c.days, 2);
  assert.equal(c.all.dials, 6);
  assert.equal(c.all.rfqs, 3);
  assert.equal(c.all.firstRfqs, 2);
  assert.equal(c.month.dials, 3);
  assert.equal(c.month.rfqs, 1);
  assert.equal(c.week.dials, 3, "the week from Monday Nov 9");
  assert.equal(c.today.dials, 0, "nothing on the 12th");
  assert.equal(c.best?.day, "2026-10-27", "two RFQs on one day beat the ladder day");
  assert.equal(c.rfqs.length, 3);
  // Written again, the same rows: nothing doubles.
  await store.putRungEvents(rows);
  assert.equal((await careerFor("user_season", "America/Chicago", new Date("2026-11-12T15:00:00Z"))).all.dials, 6);
});

test("a day written again is exact (11/12): rows that no longer hold are gone, not merged in", async () => {
  const day = { ...facts, day: "2026-11-05" };
  await store.putRungEvents(eventsOf("user_exact", day, [{ leadId: "lead_x", company: "Existing Customer", first: false }]));
  assert.equal((await careerFor("user_exact", "America/Chicago", new Date("2026-11-12T15:00:00Z"))).all.rfqs, 1);
  await store.deleteRungEvents("user_exact", "2026-11-05");
  await store.putRungEvents(eventsOf("user_exact", day, []));
  const c = await careerFor("user_exact", "America/Chicago", new Date("2026-11-12T15:00:00Z"));
  assert.equal(c.all.rfqs, 0);
  assert.equal(c.all.dials, 3);
});
