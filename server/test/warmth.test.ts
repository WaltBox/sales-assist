import { strict as assert } from "node:assert";
import { test } from "node:test";
import { warmthFor } from "../src/warmth.js";

type In = Parameters<typeof warmthFor>[0];

const base = (): In => ({
  seen: "not_opened", opens: { person: 0, maybe: 0, filter: 0, last: null, app: null }, events: [],
  touches: { dials: 1, talked: 1, voicemails: 0, noAnswer: 0, emailsOut: 1, emailsIn: 0, firstTouch: "2026-10-01T16:00:00Z", lastTalk: "2026-10-01T16:00:00Z" },
  contact: { name: "Kim Lee", email: "kim@x.com", phone: null }, rfqPromised: false, cardSentAt: "2026-10-01T16:30:00Z",
});
const now = new Date("2026-10-05T17:00:00Z");

test("the intro call plus a name is cold, not warm", () => {
  const w = warmthFor(base(), now);
  assert.equal(w.score, 1.5);
  assert.equal(w.bucket, "cold");
});

test("opens, a reply and a second talk make it hot", () => {
  const a = base();
  a.opens = { person: 4, maybe: 0, filter: 0, last: "2026-10-03T12:00:00Z", app: "Outlook" };
  a.touches.talked = 2;
  a.events = [{ at: "2026-10-03T13:00:00Z", kind: "reply", text: "Kim replied: Re: line card" }, { at: "2026-10-02T15:00:00Z", kind: "call", text: "Call connected (4 min): talked parts" }];
  const w = warmthFor(a, now);
  assert.equal(w.bucket, "hot");
  assert.equal(w.lastSignal, "2026-10-03T13:00:00Z");
  assert.ok(w.why.some((s) => s.includes("wrote back")));
});

test("an RFQ promise alone is warm", () => {
  const a = base(); a.rfqPromised = true;
  assert.equal(warmthFor(a, now).bucket, "warm");
});

test("a bounce drags it down and a mailbox name earns nothing", () => {
  const a = base(); a.seen = "bounced"; a.contact.name = "info";
  const w = warmthFor(a, now);
  assert.equal(w.score, -2);
  assert.ok(!w.why.some((s) => s.includes("named buyer")));
});

test("a quiet lead fades after a week", () => {
  const a = base(); a.opens = { person: 3, maybe: 0, filter: 0, last: "2026-09-01T12:00:00Z", app: null };
  a.touches.talked = 3; a.touches.lastTalk = "2026-09-01T12:00:00Z";
  const fresh = warmthFor(a, new Date("2026-09-05T12:00:00Z"));
  const stale = warmthFor(a, new Date("2026-10-05T12:00:00Z"));
  assert.equal(fresh.score, 7.5);
  assert.ok(stale.score < 3, `faded to ${stale.score}`);
  assert.ok(stale.why.at(-1)!.startsWith("fades"));
});
