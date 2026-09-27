import assert from "node:assert/strict";
import { test } from "node:test";
import { afterCall, RFQ_TAG, type Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import { dayStats, isReached, isVoicemail, localDay, resetStatsCache, weekStats } from "../src/stats.js";

const NOW = new Date("2026-09-23T21:31:00Z"); // Wed 2:31 PM Pacific
const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles" };
const deps = (close: FakeClose, now = NOW): Deps => ({ close, llm: demoLlm, rep, now: () => now });

const quiet = (id: string, at: string, over: Parameters<typeof roddaCall>[0] = {}) =>
  roddaCall({ id, date_created: at, disposition: "no-answer", duration: 0, recording_transcript: null, voicemail_transcript: null, ...over });

function day() {
  const close = new FakeClose({
    calls: [
      roddaCall(), // 2:28 PM, answered 96s, both sides talk
      quiet("acti_na", "2026-09-23T16:00:00Z", { lead_id: "lead_other" }), // 9 AM, no answer
      quiet("acti_vm", "2026-09-23T17:00:00Z", { disposition: "vm-left", duration: 30 }),
      quiet("acti_notme", "2026-09-23T17:10:00Z", { user_id: "user_someoneelse" }),
      quiet("acti_in", "2026-09-23T17:20:00Z", { direction: "inbound" }),
      quiet("acti_late", "2026-09-23T06:30:00Z"), // 11:30 PM Tuesday Pacific, already Wednesday in UTC
      roddaCall({ id: "acti_tue", date_created: "2026-09-22T18:00:00Z", duration: 60 }),
    ],
  });
  close.clock = () => NOW;
  return close;
}

test("the day starts at the rep's local midnight, not UTC", () => {
  const d = localDay("America/Los_Angeles", NOW);
  assert.equal(d.day, "2026-09-23");
  assert.equal(d.since.toISOString(), "2026-09-23T07:00:00.000Z");
  assert.equal(d.until.toISOString(), "2026-09-24T07:00:00.000Z");
  // The day clocks go back is 25 hours long.
  const fallBack = localDay("America/Los_Angeles", new Date("2026-11-01T20:00:00Z"));
  assert.equal(fallBack.until.getTime() - fallBack.since.getTime(), 25 * 3600e3);
});

test("today's stats count only this rep's outbound calls since local midnight", async () => {
  resetStatsCache();
  const close = day();
  await close.createNote(DEMO_LEAD_ID, `Renee will send tomorrow's list.\n\n${RFQ_TAG}`, false);
  await close.createNote("lead_other", "Plain note", false);
  await close.createTask(DEMO_LEAD_ID, "Call Renee", NOW.toISOString(), DEMO_USER_ID);
  const card = [{ filename: "Westgate_Supply_Line_Card.pdf" }];
  close.sentEmails = [
    { id: "e1", user_id: DEMO_USER_ID, status: "sent", direction: "outgoing", date_sent: "2026-09-23T20:00:00Z", date_created: "2026-09-22T20:00:00Z", attachments: card },
    { id: "e2", user_id: DEMO_USER_ID, status: "sent", direction: "outgoing", date_sent: "2026-09-23T20:05:00Z", date_created: "2026-09-23T20:00:00Z", attachments: [] },
    { id: "e3", user_id: DEMO_USER_ID, status: "draft", direction: "outgoing", date_created: "2026-09-23T20:00:00Z", attachments: card },
    { id: "e4", user_id: DEMO_USER_ID, status: "sent", direction: "outgoing", date_sent: "2026-09-22T20:00:00Z", date_created: "2026-09-22T19:00:00Z", attachments: card },
  ];
  const s = await dayStats(deps(close), { fresh: true });
  assert.equal(s.dials, 3); // Rodda, no answer, voicemail; not the other rep's, the inbound, or last night's
  assert.equal(s.companies, 2);
  assert.equal(s.reached, 1);
  assert.equal(s.voicemails, 1);
  assert.equal(s.emailsSent, 2);
  assert.equal(s.lineCards, 1);
  assert.equal(s.rfqs, 1);
  assert.equal(s.tasks, 1);
  assert.equal(s.best?.seconds, 96);
  assert.equal(s.best?.company, "Rodda Electric, Inc.");
  assert.equal(s.approximate, false);
  // 3 dials in 5.5 hours since 9 AM, 2.5 hours left until 5 PM.
  assert.equal(s.pace?.onPaceFor, 4);
  assert.deepEqual([...s.callIds].sort(), ["acti_demoRoddaCall0001", "acti_na", "acti_vm"]);
});

test("reached, voicemails, and RFQs are approximate while a recent call has no transcript", async () => {
  resetStatsCache();
  const close = day();
  close.calls_.push(roddaCall({ id: "acti_fresh", date_created: "2026-09-23T21:29:00Z", duration: 60, recording_transcript: null }));
  const s = await dayStats(deps(close), { fresh: true });
  assert.equal(s.approximate, true);
  assert.equal(s.dials, 4); // dials never wait
});

test("a call the rep tapped Voicemail isn't reached, even with two speakers", () => {
  const c = roddaCall({ id: "acti_x", duration: 80 });
  assert.equal(isReached(c, new Map()), true);
  assert.equal(isReached(c, new Map([["acti_x", "voicemail"]])), false);
  assert.equal(isVoicemail(c, new Map([["acti_x", "voicemail"]])), true);
});

test("the week view has Mon–Fri with today highlighted", async () => {
  resetStatsCache();
  const w = await weekStats(deps(day()));
  assert.deepEqual(w.days.map((x) => x.label), ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  assert.deepEqual(w.days.map((x) => [x.dials, x.reached, x.today]), [[0, 0, false], [2, 1, false], [3, 1, true], [0, 0, false], [0, 0, false]]);
});

test("after-call tags the note when an RFQ was promised", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  const r = await afterCall(deps(close), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001" });
  assert.ok(r.proposals.note?.text.endsWith(RFQ_TAG));
});

test("periods start at midnight today, Monday, and the 1st, in the rep's time zone", async () => {
  const { periodStart } = await import("../src/stats.js");
  const tz = "America/Los_Angeles";
  const sat = new Date("2026-09-27T02:00:00Z"); // Sat Sep 26, 7pm Pacific
  assert.equal(periodStart("today", tz, sat).toISOString(), "2026-09-26T07:00:00.000Z");
  assert.equal(periodStart("week", tz, sat).toISOString(), "2026-09-21T07:00:00.000Z", "Monday Sep 21");
  assert.equal(periodStart("month", tz, sat).toISOString(), "2026-09-01T07:00:00.000Z");
  assert.equal(periodStart("week", tz, new Date("2026-09-21T15:00:00Z")).toISOString(), "2026-09-21T07:00:00.000Z", "on a Monday, that Monday");
});
