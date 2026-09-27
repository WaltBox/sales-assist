import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import { advance, listQueue, quickOutcome } from "../src/queue.js";
import { store } from "../src/store.js";

// Hosted on Vercel nothing sits and waits for Close's transcript: a review moves
// along when something pokes it (the tap, Close's webhook, the panel, the daily job).

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles", sender: '"Walt Boxwell" <walt@westgatesupply.com>', emailAccountId: "emailacct_demo" };

test("a review waits for the transcript without holding anything open, then builds once it lands", async () => {
  const wait = config.transcriptWaitMs;
  config.transcriptWaitMs = 60_000;
  try {
    const call = roddaCall({ id: "acti_waitTx", recording_transcript: null });
    const close = new FakeClose({ calls: [call] });
    const d: Deps = { close, llm: demoLlm, rep: { ...rep, closeUserId: "user_waitTx" } };
    const r = await quickOutcome(d, DEMO_LEAD_ID, { outcome: "reached_buyer", call_id: "acti_waitTx", rating: "B" });
    await new Promise((res) => setTimeout(res, 50));
    await advance(d, r.queued!);
    const [waiting] = await listQueue(d);
    assert.equal(waiting.state, "building", "no transcript yet: still waiting");
    assert.ok(!close.writes.some((w) => w.op === "note"), "nothing built yet");

    call.recording_transcript = roddaCall().recording_transcript; // Close finished transcribing
    await advance(d, r.queued!);
    const [built] = await listQueue(d);
    assert.equal(built.state, "saved");
    assert.ok(close.writes.some((w) => w.op === "note"));
    assert.equal((built as { transcript?: string | null }).transcript ?? null, null, "the transcript isn't stored; Close has it");
  } finally {
    config.transcriptWaitMs = wait;
  }
});

test("two pokes at once build a review only once", async () => {
  const wait = config.transcriptWaitMs;
  config.transcriptWaitMs = 60_000;
  const call = roddaCall({ id: "acti_twice2", recording_transcript: null });
  const close2 = new FakeClose({ calls: [call] });
  const d2: Deps = { close: close2, llm: demoLlm, rep: { ...rep, closeUserId: "user_twice" } };
  try {
    const r = await quickOutcome(d2, DEMO_LEAD_ID, { outcome: "reached_buyer", call_id: "acti_twice2", rating: "B" });
    await new Promise((res) => setTimeout(res, 50));
    call.recording_transcript = roddaCall().recording_transcript;
    await Promise.all([advance(d2, r.queued!), advance(d2, r.queued!), advance(d2, r.queued!)]);
    assert.equal(close2.writes.filter((w) => w.op === "note").length, 1);
    assert.equal(close2.writes.filter((w) => w.op === "email").length, 1);
  } finally {
    config.transcriptWaitMs = wait;
  }
});

test("Close's webhook: unsigned calls are refused; a signed call-updated event builds that call's review", async () => {
  const key = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const prevKey = config.closeWebhookKey;
  const wait = config.transcriptWaitMs;
  config.closeWebhookKey = key;
  config.transcriptWaitMs = 60_000;
  const TOKEN = "hook-token-hook-token-hook-token";
  const call = roddaCall({ id: "acti_hook", recording_transcript: null });
  const close = new FakeClose({ calls: [call] });
  const app = createApp({
    reps: new Map([[TOKEN, { token: TOKEN, name: "Walt Boxwell", email: "walt@westgatesupply.com", close_api_key: "x", timezone: "America/Los_Angeles" }]]),
    closeFor: () => close, llm: demoLlm, website: async () => null,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const d: Deps = { close, llm: demoLlm, rep };
    const r = await quickOutcome(d, DEMO_LEAD_ID, { outcome: "reached_buyer", call_id: "acti_hook", rating: "B" });
    await new Promise((res) => setTimeout(res, 50));
    const body = JSON.stringify({ event: { object_type: "activity.call", action: "updated", object_id: "acti_hook" } });
    const post = (headers: Record<string, string>) => fetch(`${base}/api/webhooks/close`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    assert.equal((await post({})).status, 401);
    assert.equal((await post({ "close-sig-timestamp": "1", "close-sig-hash": "00" })).status, 401);

    call.recording_transcript = roddaCall().recording_transcript;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", Buffer.from(key, "hex")).update(ts + body).digest("hex");
    assert.equal((await post({ "close-sig-timestamp": ts, "close-sig-hash": sig })).status, 200);
    for (let i = 0; i < 400 && (await store.getReview<{ state: string }>(r.queued!))?.state === "building"; i++) await new Promise((res) => setTimeout(res, 25));
    assert.equal((await store.getReview<{ state: string }>(r.queued!))?.state, "saved");
  } finally {
    server.close();
    config.closeWebhookKey = prevKey;
    config.transcriptWaitMs = wait;
  }
});

test("rescheduling reads the task back from Close: another rep's task can't be moved", async () => {
  const { rescheduleTask } = await import("../src/queue.js");
  const close = new FakeClose({ calls: [roddaCall({ id: "acti_rsOwn", disposition: "no-answer" })] });
  const d: Deps = { close, llm: demoLlm, rep: { ...rep, closeUserId: "user_rsOwn" }, now: () => new Date("2026-09-24T16:00:00Z") };
  const r = await quickOutcome(d, DEMO_LEAD_ID, { outcome: "no_answer", call_id: "acti_rsOwn", rating: "B" });
  await assert.rejects(rescheduleTask(d, "lead_someOtherLead000001", r.task!.id, "2026-09-25T17:00:00Z"), /Can't find/);
  const moved = await rescheduleTask(d, DEMO_LEAD_ID, r.task!.id, "2026-09-25T17:00:00Z");
  assert.equal(moved.due_at, "2026-09-25T10:00:00-07:00");
});
