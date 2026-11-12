import assert from "node:assert/strict";
import { test } from "node:test";
import { callFacts, callStats } from "../src/analyzer.js";
import type { QueueItem } from "../src/queue.js";

const item = (o: Partial<QueueItem>): QueueItem => ({
  id: o.id ?? "it", repId: "user_a", leadId: o.leadId ?? "lead_x", company: o.company ?? "Acme", callId: o.callId ?? "acti", outcome: o.outcome ?? "reached_buyer",
  note: null, rating: null, createdAt: o.createdAt ?? "2026-11-05T15:00:00.000Z", state: o.state ?? "done", applied: null, saved: [], savedTaskAt: null, savedStatus: null,
  outcomeLabel: o.outcomeLabel ?? null, summary: o.summary ?? null, callWith: o.callWith ?? null, duration: o.duration ?? 120, taskId: null, smartTask: null,
  proposals: null, coaching: o.coaching ?? null, warnings: [],
} as QueueItem);

test("the analyzer (11/12): a call's facts carry what the company did in the two weeks after it, from the events table", () => {
  const items = [
    item({ id: "a", leadId: "lead_a", callWith: "Rob (Purchasing)", outcomeLabel: "Reached purchasing", duration: 240, coaching: { nice: "Asked for the last RFQ", next: null } }),
    item({ id: "b", leadId: "lead_b", callWith: "Main Office", outcomeLabel: "Gatekeeper, no name", duration: 70 }),
    item({ id: "c", leadId: "lead_c", duration: 20 }), // under 45s: no transcript, not a conversation
    item({ id: "d", leadId: "lead_d", state: "discarded" }),
  ];
  const events = [
    { id: "e1", repId: "user_a", leadId: "lead_a", company: "Acme", kind: "rfq" as const, at: "2026-11-09T12:00:00.000Z", day: "2026-11-09", points: 40, first: true },
    { id: "e2", repId: "user_a", leadId: "lead_a", company: "Acme", kind: "named" as const, at: "2026-10-01T12:00:00.000Z", day: "2026-10-01", points: 3, first: false }, // before the call: not "after"
    { id: "e3", repId: "user_a", leadId: "lead_b", company: "Beta", kind: "dial" as const, at: "2026-11-06T12:00:00.000Z", day: "2026-11-06", points: 1, first: false },
  ];
  const facts = callFacts(items, events, "America/Chicago");
  assert.deepEqual(facts.map((f) => f.id), ["a", "b"]);
  assert.deepEqual(facts[0].after, { named: false, card: false, reached: false, rfq: true });
  assert.deepEqual(facts[1].after, { named: false, card: false, reached: false, rfq: false });
  const s = callStats(facts);
  assert.equal(s.conversations, 2);
  assert.equal(s.after.rfq, 1);
  assert.deepEqual(s.byWho.map((w) => [w.who, w.n, w.won]), [["buyer", 1, 1], ["front desk", 1, 0]]);
  assert.deepEqual(s.byLength.map((b) => [b.band, b.n]), [["3 to 6 min", 1], ["under 1:30", 1]]);
});
