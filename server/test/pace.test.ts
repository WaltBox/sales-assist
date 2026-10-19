import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { DAILY_CAP, dailyCapFor, dedupeDue, setDailyCap, slowToday } from "../src/automations.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { store, type Automation } from "../src/store.js";

test("slow down (10/19): a lower daily limit, and today's queued extras pulled back, most overdue kept", async () => {
  const repId = "user_pace";
  const close = new FakeClose();
  const now = new Date("2026-10-19T14:30:00Z"); // 7:30 in LA, before the 7:50 sends
  const d: Deps = { close, llm: demoLlm, now: () => now, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: repId, timeZone: "America/Los_Angeles" } };
  assert.equal(await dailyCapFor(d), DAILY_CAP, "full speed until slowed");
  await assert.rejects(setDailyCap(d, 33), /Pick one of/);

  const row = (i: number): Automation => ({ id: `em_${i}`, repId, leadId: `lead_${i}`, company: `Co ${i}`, to: `b${i}@co${i}.com`, subject: "s", kind: "bump", label: "Rhythm email", reason: "r",
    scheduledFor: new Date(Date.parse("2026-10-19T14:50:00Z") + i * 60_000).toISOString(), createdAt: "2026-10-19T11:05:00Z", status: "scheduled" } as Automation);
  for (let i = 0; i < 5; i++) await store.putAutomation(row(i));
  await store.putAutomation({ ...row(9), id: "em_sent", status: "sent", scheduledFor: "2026-10-19T14:00:00Z" });

  const dry = await slowToday(d, 2, { dryRun: true });
  assert.deepEqual([dry.queued, dry.pulled], [5, 3]);
  assert.equal(close.writes.length, 0, "a dry run changes nothing");

  await setDailyCap(d, 20);
  assert.equal(await dailyCapFor(d), 20);
  const r = await slowToday(d, 2);
  assert.deepEqual(r.companies, ["Co 2", "Co 3", "Co 4"], "the first queued (most overdue) stay");
  assert.deepEqual(close.writes.filter((w) => w.op === "unschedule").map((w) => (w.body as { id: string }).id), ["em_2", "em_3", "em_4"]);
  const rows = await store.listAutomations(repId, new Date(0).toISOString());
  assert.deepEqual(rows.filter((x) => x.status === "scheduled").map((x) => x.id).sort(), ["em_0", "em_1"]);
  assert.equal(rows.find((x) => x.id === "em_sent")!.status, "sent", "what already went out is untouched");
  // Pulled-back companies are due again: nothing scheduled or sent blocks them.
  const { keep } = dedupeDue([{ leadId: "lead_3", company: "Co 3", contact: { email: "b3@co3.com" } }], rows, { now: new Date("2026-10-20T11:05:00Z") });
  assert.equal(keep.length, 1);
});
