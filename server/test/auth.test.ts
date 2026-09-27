import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.js";
import { issueSession, readSession } from "../src/auth.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { roddaCall } from "../src/fixtures.js";

// Sign in with email + password. Walt is already a rep (reps.json), so his first
// visit just sets a password; someone new also connects their Close API key.

const close = new FakeClose({ calls: [roddaCall()] }); // its me() is walt@westgatesupply.com
const app = createApp({
  reps: new Map([["old-token-old-token-old-token-1", { token: "old-token-old-token-old-token-1", name: "Walt Boxwell", email: "walt@westgatesupply.com", close_api_key: "x", timezone: "America/Los_Angeles" }]]),
  closeFor: () => close, llm: demoLlm, website: async () => null,
});
let server: ReturnType<typeof app.listen>;
let base = "";
before(() => new Promise<void>((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }); }));
after(() => server.close());

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const me = (token: string) => fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });

test("Walt: first visit sets a password, then email + password signs in everywhere", async () => {
  assert.deepEqual((await post("/api/auth/check", { email: " Walt@WestgateSupply.com " })).body, { email: "walt@westgatesupply.com", hasAccount: false, needsCloseKey: false });
  assert.equal((await post("/api/auth/signup", { email: "walt@westgatesupply.com", password: "short" })).status, 400);
  const made = await post("/api/auth/signup", { email: "walt@westgatesupply.com", password: "correct horse battery" });
  assert.equal(made.status, 200);
  assert.equal((await me(made.body.token as string)).status, 200);
  assert.equal((await post("/api/auth/signup", { email: "walt@westgatesupply.com", password: "another long one" })).status, 409, "can't take over an existing account");

  assert.equal((await post("/api/auth/check", { email: "walt@westgatesupply.com" })).body.hasAccount, true);
  assert.equal((await post("/api/auth/login", { email: "walt@westgatesupply.com", password: "wrong password!" })).status, 401);
  const inn = await post("/api/auth/login", { email: "walt@westgatesupply.com", password: "correct horse battery" });
  assert.equal(inn.status, 200);
  const rep = (await (await me(inn.body.token as string)).json()) as { rep: { name: string } };
  assert.equal(rep.rep.name, "Walt Boxwell");
  // The side panel's old token keeps working until it's replaced.
  assert.equal((await me("old-token-old-token-old-token-1")).status, 200);
});

test("only Westgate emails; someone new connects their own Close API key", async () => {
  assert.equal((await post("/api/auth/check", { email: "someone@gmail.com" })).status, 403);
  assert.equal((await post("/api/auth/check", { email: "berni@westgatesupply.com" })).body.needsCloseKey, true);
  const noKey = await post("/api/auth/signup", { email: "berni@westgatesupply.com", password: "a long enough password" });
  assert.equal(noKey.status, 428);
  assert.equal(noKey.body.needsCloseKey, true);
  // The fake Close key belongs to walt@, so it can't be used to sign up as berni@.
  const wrong = await post("/api/auth/signup", { email: "berni@westgatesupply.com", password: "a long enough password", close_api_key: "api_key_for_walt" });
  assert.equal(wrong.status, 400);
  assert.match(String(wrong.body.error), /belongs to walt@westgatesupply\.com/);
});

test("sessions can't be forged or used after they expire", async () => {
  const t = issueSession("walt@westgatesupply.com");
  assert.equal(readSession(t), "walt@westgatesupply.com");
  const [v, body] = t.split(".");
  const forged = `${v}.${Buffer.from(JSON.stringify({ e: "walt@westgatesupply.com", x: Date.now() + 1e9 })).toString("base64url")}.${t.split(".")[2]}`;
  assert.equal(readSession(forged), null, "a changed expiry breaks the signature");
  assert.equal(readSession(`${v}.${body}.AAAA`), null);
  assert.equal(readSession(t, Date.now() + 31 * 86400000), null, "expired after 30 days");
  assert.equal((await me(`${v}.${body}.AAAA`)).status, 401);
});
