import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.js";
import { demoLlm, demoProposals, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, roddaCall } from "../src/fixtures.js";

const TOKEN = "test-token-test-token-test-token";
const close = new FakeClose({ calls: [roddaCall()] });
const app = createApp({
  reps: new Map([[TOKEN, { token: TOKEN, name: "Walt Boxwell", email: "walt@westgatesupply.com", close_api_key: "x", timezone: "America/Los_Angeles" }]]),
  closeFor: () => close,
  llm: demoLlm,
  website: async () => null,
});
let server: ReturnType<typeof app.listen>;
let base = "";
before(() => new Promise<void>((resolve) => {
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  });
}));
after(() => server.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const json = async (r: Response): Promise<Json> => r.json();
const call = (path: string, init: RequestInit & { token?: string | null } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }) },
  });

test("requires a known rep token", async () => {
  assert.equal((await call(`/api/leads/${DEMO_LEAD_ID}/brief`, { token: null })).status, 401);
  assert.equal((await call(`/api/leads/${DEMO_LEAD_ID}/brief`, { token: "nope" })).status, 401);
});

test("rejects malformed lead ids", async () => {
  const res = await call("/api/leads/..%2Fstatus/brief");
  assert.equal(res.status, 400);
});

test("brief → after-call → apply round trip", async () => {
  const brief = await json(await call(`/api/leads/${DEMO_LEAD_ID}/brief`));
  assert.equal(brief.brief.rating, "B");

  const ac = await json(await call(`/api/leads/${DEMO_LEAD_ID}/after-call`, { method: "POST", body: JSON.stringify({ rating: "B" }) }));
  assert.equal(ac.outcome, "conversation");
  assert.equal(ac.callId, "acti_demoRoddaCall0001");

  const applied = await call(`/api/leads/${DEMO_LEAD_ID}/apply`, { method: "POST", body: JSON.stringify({ proposals: ac.proposals, rating: "B" }) });
  assert.equal(applied.status, 200);
  const again = await call(`/api/leads/${DEMO_LEAD_ID}/apply`, { method: "POST", body: JSON.stringify({ proposals: ac.proposals, rating: "B" }) });
  assert.equal(again.status, 409);
});

test("apply validates the body", async () => {
  const bad = { ...demoProposals(), tasks: [{ due_at: 5 }] };
  const res = await call(`/api/leads/${DEMO_LEAD_ID}/apply`, { method: "POST", body: JSON.stringify({ proposals: bad }) });
  assert.equal(res.status, 400);
});

test("chat keeps proposals when the model does", async () => {
  const res = await call(`/api/leads/${DEMO_LEAD_ID}/chat`, { method: "POST", body: JSON.stringify({ message: "make that Thursday at 9", proposals: demoProposals() }) });
  const body = await json(res);
  assert.equal(res.status, 200);
  assert.equal(body.proposals.tasks.length, 2);
});

test("call-state validates since", async () => {
  assert.equal((await call(`/api/leads/${DEMO_LEAD_ID}/call-state?since=yesterday`)).status, 400);
  const ok = await call(`/api/leads/${DEMO_LEAD_ID}/call-state?since=${encodeURIComponent("2026-09-23T00:00:00Z")}`);
  assert.equal((await json(ok)).state, "ended");
});
