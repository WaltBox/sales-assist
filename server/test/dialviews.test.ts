import assert from "node:assert/strict";
import { test } from "node:test";
import { dialQuery, syncDialViews } from "../src/dialviews.js";
import { demoLineCards, demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import type { Deps } from "../src/assistant.js";

test("the Close call lists: these leads, minus anyone whose Last reached is today", () => {
  const q = dialQuery(["lead_a", "lead_b"], "cf_reached", "America/Los_Angeles", new Date("2026-10-06T15:30:00Z")) as { query: { queries: unknown[] } };
  const [, ids, reached] = q.query.queries as [unknown, { queries: Array<{ value: string }> }, { negate: boolean; field: { custom_field_id: string }; condition: { on_or_after: unknown } }];
  assert.deepEqual(ids.queries.map((x) => x.value), ["lead_a", "lead_b"]);
  assert.equal(reached.negate, true);
  assert.equal(reached.field.custom_field_id, "cf_reached");
  assert.deepEqual(reached.condition.on_or_after, { type: "fixed_local_date", which: "start", value: "2026-10-06" }, "today, as a local date");
});

test("reached: the tap or the transcript puts today's date on the lead; no answer doesn't", async () => {
  const { markReached, REACHED_FIELD } = await import("../src/dialviews.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  const d: Deps = { close, llm: demoLlm, now: () => new Date("2026-10-06T16:00:00Z"), rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: "user_reached_test", timeZone: "America/Los_Angeles" } };
  assert.equal(await markReached(d, "lead_x"), true);
  const field = (await close.leadCustomFields()).find((f) => f.name === REACHED_FIELD)!;
  assert.ok(field, "the field is created once");
  assert.equal(close.leadFields_.lead_x[`custom.${field.id}`], "2026-10-06");
  await markReached(d, "lead_y");
  assert.equal((await close.leadCustomFields()).filter((f) => f.name === REACHED_FIELD).length, 1, "not created twice");
});

test("the views are created once by name, then updated in place each morning", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close);
  const d: Deps = { close, llm: demoLlm, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles" } };
  const first = await syncDialViews(d);
  assert.equal(first.length, 4);
  assert.ok(first.every((v) => v.created));
  const again = await syncDialViews(d);
  assert.ok(again.every((v) => !v.created), "updated, not duplicated");
  assert.deepEqual(again.map((v) => v.id), first.map((v) => v.id));
  assert.equal((await close.savedSearches()).length, 4);
});
