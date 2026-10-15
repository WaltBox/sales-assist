import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanReply, heatFor, signalFromNote, whenFromPhrase, type HeatIn } from "../src/heat.js";

// Heat v3 (10/14): who's most likely to send an RFQ soon, from what they said and did, never from dials.
const tz = "America/Chicago";
const now = new Date("2026-10-14T15:00:00Z"); // Wed Oct 14, 10am Central
const base = (over: Partial<HeatIn> = {}): HeatIn => ({
  now, tz, company: "Acme Fab, Inc.", contactName: "Kim Lee", signals: [], notes: [], replies: [], clickedAt: null, openDays: [],
  lastOutAt: "2026-10-12T15:00:00Z", rfq: null, paused: null, tier: "project", rfqTiming: null, ...over,
});
const note = (date: string, text: string) => ({ note: text, date_created: date });

test("when they said work comes: the day it means", () => {
  assert.equal(whenFromPhrase("middle of next week", "2026-10-07T18:00:00Z", tz), "2026-10-14", "said Wed 10/7: Wed 10/14 (Seahurst)");
  assert.equal(whenFromPhrase("next week", "2026-10-09T18:00:00Z", tz), "2026-10-12");
  assert.equal(whenFromPhrase("Monday", "2026-10-07T18:00:00Z", tz), "2026-10-12");
  assert.equal(whenFromPhrase("tomorrow", "2026-10-13T18:00:00Z", tz), "2026-10-14");
  assert.equal(whenFromPhrase("end of the month", "2026-10-13T18:00:00Z", tz), "2026-10-31");
  assert.equal(whenFromPhrase("after the first of the year", "2026-10-13T18:00:00Z", tz), "2027-01-05");
  assert.equal(whenFromPhrase("mid November", "2026-10-13T18:00:00Z", tz), "2026-11-10");
  assert.equal(whenFromPhrase("whenever", "2026-10-13T18:00:00Z", tz), null);
});

test("a reply is read without the signature (Cleaver-Brooks: \"Got it Joe Jefferson Purchasing / Buyer [cid:…]\")", () => {
  assert.equal(cleanReply("Got it Joe Jefferson Purchasing / Buyer I [cid:image001.png@01DC]"), "Got it");
  assert.equal(cleanReply("Is this all domestic? Thanks, Munish Patel (773) 321-9635"), "Is this all domestic?");
  const h = heatFor(base({ replies: [{ at: "2026-10-12T15:00:00Z", text: "Got it Joe Jefferson Purchasing / Buyer I [cid:image001.png@01DC]" }] }));
  assert.notEqual(h.band, "today", "a \"got it\" isn't a question");
});

test("a promise: a day to send it, then chase it; it never counts once an RFQ came after", () => {
  const fresh = heatFor(base({ signals: [{ at: "2026-10-14T13:00:00Z", callId: "c1", tapped: "reached_buyer", buyer: true, promised: true, nextOne: false, softYes: false, noneNow: false, benchmark: false, expectedWhen: null, who: "Norma Diaz", summary: null }] }));
  assert.equal(fresh.band, "week");
  const old = heatFor(base({ signals: [{ at: "2026-10-08T15:00:00Z", callId: "c2", tapped: "reached_buyer", buyer: true, promised: true, nextOne: false, softYes: false, noneNow: false, benchmark: false, expectedWhen: null, who: "Norma Diaz", summary: null }] }));
  assert.equal(old.band, "today");
  assert.match(old.reason, /^Chase it: Norma promised an RFQ on Oct 8, 6 days ago/);
  const sent = heatFor(base({ signals: [{ at: "2026-10-08T15:00:00Z", callId: "c2", tapped: null, buyer: true, promised: true, nextOne: false, softYes: false, noneNow: false, benchmark: false, expectedWhen: null, who: "Norma", summary: null }], rfq: { at: "2026-10-10T15:00:00Z", quotedAt: null } }));
  assert.equal(sent.band, "off", "an RFQ in lives on the RFQs page");
});

test("their day: quiet before it, at the top on it (Vinny at Seahurst, \"middle of next week\")", () => {
  const sig = (at: string) => ({ at, callId: "c3", tapped: "reached_buyer", buyer: true, promised: false, nextOne: true, softYes: false, noneNow: true, benchmark: false, expectedWhen: "middle of next week", who: "Vincent", summary: null });
  const on = heatFor(base({ signals: [sig("2026-10-07T18:00:00Z")] }));
  assert.equal(on.band, "today");
  assert.match(on.reason, /middle of next week.*That's now/);
  const before = heatFor(base({ signals: [sig("2026-10-13T18:00:00Z")] }));
  assert.equal(before.band, "later", "said yesterday: off the map until next Wednesday");
  assert.equal(before.expected, "2026-10-21");
});

test("they gave a date (Allison at Alcatex, \"mid November to early December\"): off the map until then; anything newer brings them back", () => {
  const paused = { kind: "later", until: "2026-11-10T15:00:00Z", why: "They said: \"Mid November to early December before I know anything on that.\"" };
  const reply = { at: "2026-10-08T15:01:00Z", text: "Mid November to early December before I know anything on that. Thank you Allison Boen" };
  const h = heatFor(base({ contactName: "Allison Boen", paused, replies: [reply], notes: [note("2026-10-09T16:00:00Z", "Spoke with Allison. She said they expect work next week.")] }));
  assert.equal(h.band, "later", "not \"call today\" off an older call note");
  assert.equal(h.expected, "2026-11-10");
  assert.match(h.reason, /^Back Nov 10: Allison said/);
  const wrote = heatFor(base({ paused, replies: [reply, { at: "2026-10-13T15:00:00Z", text: "Actually, can you quote 20 ft of 4\" sch 40?" }] }));
  assert.notEqual(wrote.band, "later", "she wrote again: back on the map");
});

test("old call notes: \"nothing right now, I'll send the next one\" is the next one, not a promise to chase", () => {
  const s = signalFromNote(note("2026-10-12T20:00:00Z", "[RFQ promised] Spoke with Anthony on 10/12; he handles RFQs. They are not needing anything right now but he said he'll send RFQs our way when he has one."))!;
  assert.equal(s.promised, false);
  assert.equal(s.nextOne, true);
  assert.equal(s.noneNow, true);
  const p = signalFromNote(note("2026-10-12T20:00:00Z", "[RFQ promised] Spoke with Norma, who handles purchasing. She is working on a quote now and should be able to send it this week."))!;
  assert.equal(p.promised, true);
  assert.equal(p.who, "Norma");
  assert.equal(signalFromNote(note("2026-10-12T20:00:00Z", "[RFQ received] Came in outside Close")), null);
});

test("dials don't make anyone hot; a click, a question, a past quote and the off list do what they say", () => {
  assert.equal(heatFor(base()).band, "emails", "nothing from them: the emails carry it");
  assert.equal(heatFor(base({ clickedAt: "2026-10-14T14:00:00Z" })).band, "today");
  assert.equal(heatFor(base({ replies: [{ at: "2026-10-13T15:00:00Z", text: "What is the thickest galvanized plate you carry?" }] })).band, "today");
  const repeat = heatFor(base({ rfq: { at: "2026-09-20T15:00:00Z", quotedAt: "2026-09-22T15:00:00Z" } }));
  assert.ok(repeat.tags.includes("repeat"));
  assert.equal(heatFor(base({ paused: { kind: "out", until: null, why: "They said no." } })).band, "off");
});

test("an email pause isn't a date they gave (10/14: the reply cool-down and \"fewer emails\" made 11 wrong tasks)", () => {
  const cooling = heatFor(base({ paused: { kind: "cooling", until: "2026-10-22T15:00:00Z", why: "Cooling off: replied to the automatic emails" } }));
  assert.notEqual(cooling.band, "later");
  const fewer = heatFor(base({ paused: { kind: "later", until: "2026-11-07T15:00:00Z", why: "They said: \"please reduce frequency\"" }, replies: [{ at: "2026-10-08T15:00:00Z", text: "Can you please reduce frequency of messages to monthly at most?" }] }));
  assert.notEqual(fewer.band, "later");
});

test("their words: the line on their side of the call where they promised it (10/14)", async () => {
  const { promiseLine } = await import("../src/heat.js");
  assert.equal(promiseLine([
    { speaker_side: "rep", text: "Could I take a look at the RFQ?" },
    { speaker_side: "contact", text: "Yeah. Writing this down. And I will send you something, literally. I'll work on that right now before I go to lunch." },
  ]), "And I will send you something, literally.");
  assert.equal(promiseLine([{ speaker_side: "contact", text: "Send your info up and I'll get it out, disseminate it to our estimators." }]), null, "passing your info around isn't sending you an RFQ");
  assert.equal(promiseLine([{ speaker_side: "contact", text: "Nothing right now, sorry." }]), null);
  assert.equal(promiseLine([{ speaker_side: "contact", text: "Let me pull up my email. Well, just send me an email. You want to shoot me an email?" }]), null, "them asking you for something isn't a promise");
  assert.equal(promiseLine([{ speaker_side: "contact", text: "Sure. I'll send you our RFQs on that job this week." }]), "I'll send you our RFQs on that job this week.");
  const h = heatFor(base({ signals: [{ at: "2026-10-08T15:00:00Z", callId: "c9", tapped: "reached_buyer", buyer: true, promised: true, nextOne: false, softYes: false, noneNow: false, benchmark: false, expectedWhen: null, who: "John", summary: null, quote: "I'll work on that right now before I go to lunch." }] }));
  assert.equal(h.promise?.quote, "I'll work on that right now before I go to lunch.");
});

test("their words can soften a promise: \"when stuff comes up, I'll send over quotes\" is the next one (Key West, 10/14)", () => {
  const sig = { at: "2026-10-07T15:00:00Z", callId: "k1", tapped: "reached_buyer", buyer: true, promised: true, nextOne: false, softYes: false, noneNow: false, benchmark: false, expectedWhen: null, who: "Amanda", summary: null, quote: "And then when stuff comes up, I'll send over quotes." };
  const h = heatFor(base({ signals: [sig] }));
  assert.ok(!h.tags.some((t) => t.startsWith("promised")));
  assert.ok(h.tags.includes("next one is yours"));
});

test("an out-of-office reply isn't someone waiting on you (Alexander Mechanical, 10/14)", () => {
  const h = heatFor(base({ lastOutAt: "2026-10-01T15:00:00Z", replies: [{ at: "2026-10-02T15:00:00Z", text: "I will be out of the office Friday 10/2 and returning Monday 10/5. If urgent call my cell." }] }));
  assert.ok(!h.tags.includes("waiting on you"));
  assert.notEqual(h.band, "today");
});
