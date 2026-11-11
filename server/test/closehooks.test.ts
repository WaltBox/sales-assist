import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { createApp } from "../src/app.js";
import { ensureCloseWebhook, eventKind, forgetWebhookKeys, handleCloseEvent, hookStats, onCloseEvent, parseCloseEvent, signatureMatches, storedWebhook, timestampFresh, WANTED_EVENTS, type CloseEvent } from "../src/closehooks.js";
import { demoLlm, FakeClose, fakeCloseEvent, signCloseEvent } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID } from "../src/fixtures.js";
import { store } from "../src/store.js";

// The Close feed (11/10): Close posts what happened; the app checks the signature, drops replays, and acts.
const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles", sender: null, emailAccountId: null };

test("a delivery is read into an event; the signature is HMAC over timestamp and body with the hex key; stale timestamps are refused", () => {
  const body = JSON.stringify(fakeCloseEvent({ object_type: "activity.call", action: "completed", data: { id: "acti_1", lead_id: DEMO_LEAD_ID, user_id: DEMO_USER_ID, duration: 70 } }));
  const ev = parseCloseEvent(JSON.parse(body))!;
  assert.equal(eventKind(ev), "activity.call.completed");
  assert.equal(ev.leadId, DEMO_LEAD_ID);
  assert.equal(ev.userId, DEMO_USER_ID);
  assert.equal(ev.objectId, "acti_1");
  assert.equal(ev.data?.duration, 70);
  assert.equal(parseCloseEvent({ hello: 1 }), null);
  assert.equal(parseCloseEvent({ event: { object_type: "lead" } }), null, "no action");
  const key = "0f".repeat(32);
  const h = signCloseEvent(key, body);
  assert.ok(signatureMatches(Buffer.from(body), h["close-sig-timestamp"], h["close-sig-hash"], ["ab".repeat(32), key]), "any held key will do");
  assert.ok(!signatureMatches(Buffer.from(body), h["close-sig-timestamp"], h["close-sig-hash"], ["ab".repeat(32)]));
  assert.ok(!signatureMatches(Buffer.from(body + " "), h["close-sig-timestamp"], h["close-sig-hash"], [key]), "the exact bytes");
  assert.ok(!signatureMatches(Buffer.from(body), "1", h["close-sig-hash"], [key]));
  assert.ok(!signatureMatches(Buffer.from(body), h["close-sig-timestamp"], h["close-sig-hash"], ["not-hex"]), "a key that isn't hex never matches, never throws");
  assert.ok(timestampFresh(String(Math.floor(Date.now() / 1000) - 60)));
  assert.ok(!timestampFresh(String(Math.floor(Date.now() / 1000) - 6 * 60)));
  assert.ok(!timestampFresh("1"));
  assert.ok(!timestampFresh("soon"));
});

test("the subscription: made once with the owner's key and its key kept; a paused one is switched back on; doubles go; one whose key we lost is replaced", async () => {
  const close = new FakeClose();
  const owner: Deps = { close, llm: demoLlm, rep };
  const url = "https://sales-assist.test";
  await store.putSetting("team", "closeWebhook", null);
  const first = await ensureCloseWebhook(owner, { force: true, url });
  assert.ok(first.ok && first.made && !first.renewed);
  assert.equal(first.url, `${url}/api/close/webhook`);
  const sub = (await storedWebhook())!;
  assert.equal(sub.id, first.id);
  assert.equal(sub.signatureKey, close.webhooks_[0].signature_key, "the key Close handed back, kept for the signature check");
  assert.deepEqual(sub.events, WANTED_EVENTS);
  assert.deepEqual(close.webhooks_[0].events.map((e) => `${e.object_type}.${e.action}`).sort(), WANTED_EVENTS.map((e) => `${e.object_type}.${e.action}`).sort());
  // Nothing to do: nothing made.
  const again = await ensureCloseWebhook(owner, { force: true, url });
  assert.ok(again.ok && !again.made && !again.renewed);
  assert.equal(close.webhooks_.length, 1);
  // Close paused it (three days of failed deliveries): switched back on, same key.
  close.webhooks_[0].status = "paused";
  const back = await ensureCloseWebhook(owner, { force: true, url });
  assert.ok(back.ok && back.renewed && !back.made);
  assert.equal(close.webhooks_[0].status, "active");
  assert.equal((await storedWebhook())!.signatureKey, sub.signatureKey);
  // A second subscription for the same URL (made by hand): deleted, ours stays.
  await close.createWebhook({ url: `${url}/api/close/webhook`, events: [{ object_type: "lead", action: "updated" }] });
  assert.equal(close.webhooks_.length, 2);
  await ensureCloseWebhook(owner, { force: true, url });
  assert.deepEqual(close.webhooks_.map((w) => w.id), [sub.id]);
  // The setting is gone (a fresh database): the one in Close can't be verified, so it's replaced and the new key kept.
  await store.putSetting("team", "closeWebhook", null);
  const replaced = await ensureCloseWebhook(owner, { force: true, url });
  assert.ok(replaced.made);
  assert.equal(close.webhooks_.length, 1);
  assert.notEqual(close.webhooks_[0].id, sub.id);
  assert.equal((await storedWebhook())!.id, close.webhooks_[0].id);
  // Another app's subscription on another URL is never touched.
  await close.createWebhook({ url: "https://zapier.test/hook", events: [{ object_type: "lead", action: "created" }] });
  await ensureCloseWebhook(owner, { force: true, url });
  assert.equal(close.webhooks_.length, 2);
  // Without a URL there's nothing to subscribe with.
  const none = await ensureCloseWebhook(owner, { force: true, url: null });
  assert.ok(!none.ok && /APP_URL/.test(none.problem ?? ""));
});

test("the route: unsigned or stale deliveries are refused, a signed one is answered at once and handled behind it, a replay is answered and dropped", async () => {
  const TOKEN = "feed-token-feed-token-feed-token";
  const close = new FakeClose();
  const app = createApp({
    reps: new Map([[TOKEN, { token: TOKEN, name: "Walt Boxwell", email: "walt@westgatesupply.com", close_api_key: "x", timezone: "America/Los_Angeles" }]]),
    closeFor: () => close, llm: demoLlm, website: async () => null,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // The app's own subscription: its key is what deliveries are checked against.
    await ensureCloseWebhook({ close, llm: demoLlm, rep }, { force: true, url: "https://sales-assist.test" });
    forgetWebhookKeys();
    const key = (await storedWebhook())!.signatureKey;
    const got: CloseEvent[] = [];
    onCloseEvent("test", async (ev) => { got.push(ev); return `saw ${eventKind(ev)}`; });
    const payload = fakeCloseEvent({ object_type: "activity.note", action: "created", id: "ev_route1", data: { id: "note_1", lead_id: DEMO_LEAD_ID, note: "Spoke with Renee" } });
    const body = JSON.stringify(payload);
    const post = (headers: Record<string, string>, b = body) => fetch(`${base}/api/close/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: b });
    assert.equal((await post({})).status, 401, "unsigned");
    assert.equal((await post({ "close-sig-timestamp": "1", "close-sig-hash": "00" })).status, 401, "wrong key");
    const old = signCloseEvent(key, body, new Date(Date.now() - 10 * 60_000));
    assert.equal((await post(old)).status, 401, "signed ten minutes ago: a replay");
    const r = await post(signCloseEvent(key, body));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    for (let i = 0; i < 100 && !got.length; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(got.length, 1);
    assert.equal(got[0].id, "ev_route1");
    assert.equal(got[0].leadId, DEMO_LEAD_ID);
    // Close sends the same event again (a retry): answered, not handled twice.
    const dup = await post(signCloseEvent(key, body));
    assert.deepEqual(await dup.json(), { ok: true, duplicate: true });
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(got.length, 1);
    assert.equal(hookStats.duplicates >= 1, true);
    // The older route takes the same deliveries (the subscription made by the script posts there).
    const payload2 = fakeCloseEvent({ object_type: "activity.call", action: "completed", id: "ev_route2", data: { id: "acti_r2", lead_id: DEMO_LEAD_ID, user_id: DEMO_USER_ID } });
    const b2 = JSON.stringify(payload2);
    assert.equal((await fetch(`${base}/api/webhooks/close`, { method: "POST", headers: { "content-type": "application/json", ...signCloseEvent(key, b2) }, body: b2 })).status, 200);
    for (let i = 0; i < 100 && got.length < 2; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(got[1]?.id, "ev_route2");
    assert.equal(hookStats.byKind["activity.call.completed"] >= 1, true);
    // Not an event at all.
    const junk = JSON.stringify({ hello: 1 });
    assert.equal((await post(signCloseEvent(key, junk), junk)).status, 400);
  } finally {
    server.close();
  }
});

test("a sink that fails doesn't stop the others, and the failure is kept for the status page", async () => {
  onCloseEvent("broken", async () => { throw new Error("no good"); });
  const seen: string[] = [];
  onCloseEvent("after", async (ev) => { seen.push(ev.objectType); });
  const ev = parseCloseEvent(fakeCloseEvent({ object_type: "lead", action: "updated", id: "ev_fail1" }))!;
  await handleCloseEvent(ev, { depsForUser: async () => null, allDeps: async () => [], ownerDeps: async () => null });
  assert.deepEqual(seen, ["lead"]);
  assert.match(hookStats.lastError ?? "", /broken: no good/);
});
