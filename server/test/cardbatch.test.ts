import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { cardBatch } from "../src/cardbatch.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID } from "../src/fixtures.js";

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: "user_batch_walt", timeZone: "America/Chicago", sender: null, emailAccountId: null };
const now = new Date("2026-11-13T19:04:00Z"); // Fri 1:04 PM Central
const deps = (close: FakeClose): Deps => ({ close: close as unknown as Deps["close"], llm: demoLlm, rep, now: () => now });

test("a batch of cards is spaced out, never all at once (Walt 11/13: \"NOT ALL AT THE SAME TIME\"), and skips a buyer without their own address", async () => {
  const close = new FakeClose({ calls: [] });
  close.lead_.contacts[1].emails = [{ email: "rob@roddaelectric.com", type: "office" }];
  const ids = ["lead_batch_a000000000001", "lead_batch_b000000000001", "lead_batch_c000000000001"];
  const r = await cardBatch(deps(close), ids, { dryRun: true });
  const go = r.plan.filter((p) => !p.skip);
  assert.equal(go.length, 3);
  const times = go.map((p) => Date.parse(p.at!)).sort((a, b) => a - b);
  assert.ok(times[0] >= now.getTime() + 10 * 60_000, "the first one is at least ten minutes out");
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 4 * 60_000, "four minutes or more between sends");
  assert.equal(close.writes.filter((w) => /draft|email|send/.test(w.op)).length, 0, "a dry run sends nothing");
  close.lead_.contacts[1].emails = [{ email: "purchasing@roddaelectric.com", type: "office" }];
  const r2 = await cardBatch(deps(close), ids.slice(0, 1), { dryRun: true });
  assert.equal(r2.plan[0].skip, "no address of their own");
});
