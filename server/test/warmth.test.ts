import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyReply, warmthFor } from "../src/warmth.js";

// The heat map, rebuilt 10/12: replies read for what they say, opens by day, calls by length, signals fade on
// their own, paused accounts off the call bands.
type In = Parameters<typeof warmthFor>[0];
const base = (): In => ({
  seen: "opened", opens: { person: 0, maybe: 0, filter: 0, last: null, app: null }, events: [],
  touches: { dials: 1, talked: 1, voicemails: 0, noAnswer: 0, emailsOut: 1, emailsIn: 0, firstTouch: "2026-10-01T16:00:00Z", lastTalk: "2026-10-01T16:00:00Z" },
  contact: { name: "Kim Lee", email: "kim@x.com", phone: null }, rfqPromised: false, cardSentAt: "2026-10-01T16:30:00Z",
});
const now = new Date("2026-10-12T17:00:00Z");

test("replies are read for what they say (real ones from this week)", () => {
  const k = (t: string) => classifyReply(t, "2026-10-09T17:00:00Z").kind;
  assert.equal(k("Before I send the RFQ over, can you help me get Westgate set up on our end? Please send: W-9, 2–3 trade references"), "engaged");
  assert.equal(k("RFQ to follow."), "promise");
  assert.equal(k("Nothing yet."), "not_now");
  assert.equal(k("We don't have a need -I'll email you if anything comes up"), "not_now");
  assert.equal(k("We are pretty well covered at the moment. I will keep you in mind for future opportunities."), "not_now");
  assert.equal(k("I've spoken with the team and they aren't interested in moving suppliers at this time."), "out");
  assert.equal(k("Can you please reduce frequency of messages to quarterly or monthly at most?"), "later", "fewer emails isn't a no: back in a month");
  assert.equal(k("Haha yes I saw"), "other");
  assert.notEqual(k("Okay, please keep me posted. I need to provide an update on this by Monday."), "later", "no month here");
  assert.notEqual(k("Please let him know the best way to reach you and what you may need from us."), "later", "\"may\" is a verb");
  assert.equal(k("Thanks for the email. I do not need weekly reminders to send RFQ's. I will reach out if needed"), "no_emails", "Tammy at SBI, 10/12");
  const later = classifyReply("Mid November to early December before I know anything on that.", "2026-10-08T17:00:00Z");
  assert.equal(later.kind, "later");
  assert.equal(later.until!.slice(0, 10), "2026-11-10");
});

test("a question or vendor-setup ask is hot; a no is off the map; not-now pauses 1.5 weeks", () => {
  const ask = warmthFor({ ...base(), replyNotes: [{ at: "2026-10-09T17:00:00Z", text: "Before I send the RFQ over, can you send your W-9 and trade references?" }] }, now);
  assert.equal(ask.paused, null);
  assert.ok(ask.score >= 4, `${ask.score}: ${ask.why.join(" | ")}`);
  const no = warmthFor({ ...base(), replyNotes: [{ at: "2026-10-09T17:00:00Z", text: "They aren't interested in moving suppliers at this time." }] }, now);
  assert.equal(no.paused?.kind, "out");
  const notNow = warmthFor({ ...base(), replyNotes: [{ at: "2026-10-12T11:37:00Z", text: "Nothing yet." }] }, now);
  assert.equal(notNow.paused?.kind, "not_now");
  assert.equal(notNow.paused?.until?.slice(0, 10), "2026-10-22");
});

test("opens count by day, not raw count (Outlook's preview pane); opening the latest email fast is a bonus", () => {
  const oneDay = warmthFor({ ...base(), opens: { person: 32, maybe: 0, filter: 0, last: "2026-10-11T15:00:00Z", app: "Outlook" }, openDays: ["2026-10-11"] }, now);
  const threeDays = warmthFor({ ...base(), opens: { person: 3, maybe: 0, filter: 0, last: "2026-10-11T15:00:00Z", app: null }, openDays: ["2026-10-11", "2026-10-09", "2026-10-07"] }, now);
  assert.ok(threeDays.score > oneDay.score, `${threeDays.score} vs ${oneDay.score}`);
  const fast = warmthFor({ ...base(), openDays: ["2026-10-11"], lastOutAt: "2026-10-10T15:00:00Z", lastOpenAt: "2026-10-11T15:00:00Z" }, now);
  assert.ok(fast.why.some((w) => /latest email within 2 days/.test(w)));
});

test("a front-desk connect is worth little; a real conversation is worth a lot", () => {
  const desk = warmthFor({ ...base(), events: [{ at: "2026-10-10T16:00:00Z", kind: "call", text: "Call connected (38s)" }] }, now);
  const talk = warmthFor({ ...base(), events: [{ at: "2026-10-10T16:00:00Z", kind: "call", text: "Call connected (4 min)" }] }, now);
  assert.ok(talk.score - desk.score >= 1.5, `${talk.score} vs ${desk.score}`);
});

test("signals fade on their own, and a cooling period or a bounce pauses the account", () => {
  const fresh = warmthFor({ ...base(), replyNotes: [{ at: "2026-10-11T17:00:00Z", text: "Can you quote this?" }] }, now);
  const old = warmthFor({ ...base(), replyNotes: [{ at: "2026-09-12T17:00:00Z", text: "Can you quote this?" }] }, now);
  assert.ok(fresh.score > old.score * 4, `${fresh.score} vs ${old.score}`);
  const cool = warmthFor({ ...base(), openDays: ["2026-10-11"], cooling: { until: "2026-11-05T00:00:00Z", why: "Vicki asked for fewer emails" } }, now);
  assert.equal(cool.paused?.kind, "cooling");
  assert.equal(warmthFor({ ...base(), seen: "bounced" }, now).paused?.kind, "bounced");
});
