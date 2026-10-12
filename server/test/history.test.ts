import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHistory } from "../src/history.js";

test("lead history (10/11): counts, each call with the note written for it, emails both ways, newest first", () => {
  const ctx = {
    calls: [
      { id: "c1", direction: "outbound", date_created: "2026-09-28T17:00:00Z", disposition: "answered", duration: 95, note: null },
      { id: "c2", direction: "outbound", date_created: "2026-09-30T17:00:00Z", disposition: "no-answer", duration: 0, note: null },
      { id: "c3", direction: "outbound", date_created: "2026-10-01T17:00:00Z", disposition: "vm-left", duration: 30, note: null },
    ],
    notes: [
      { id: "n1", note: "9/28: Talked to Jake. No RFQs now, call back in November. [RFQ asked]", date_created: "2026-09-28T17:04:00Z" },
      { id: "n2", note: "Opener: Hi, this is Walt with Westgate Supply…", date_created: "2026-09-28T16:59:00Z" },
    ],
  } as never;
  const emails = [
    { id: "e1", direction: "outgoing", status: "sent", date_sent: "2026-09-28T17:10:00Z", to: ["jake@x.com"], subject: "Westgate Supply – line card", body_text: "Hi Jake", attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }] },
    { id: "e2", direction: "incoming", status: "inbox", date_sent: "2026-09-29T15:00:00Z", sender: "Jake Griffin <jake@x.com>", subject: "RE: line card", body_text: "Got it, thanks.\n\nOn Mon, Sep 28, 2026 at 10:10 AM Walt wrote:\n> Hi Jake" },
    { id: "e3", direction: "incoming", status: "inbox", date_sent: "2026-09-29T15:01:00Z", sender: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", body_text: "" },
  ] as never;
  const h = buildHistory(ctx, emails);
  assert.deepEqual(h.counts, { calls: 3, connected: 1, voicemails: 1, noAnswer: 1, emailsOut: 1, replies: 1 });
  assert.equal(h.lineCard?.to, "jake@x.com");
  assert.match(h.talked[0].note!, /^9\/28: Talked to Jake\. No RFQs now, call back in November\.$/, "the call's own note, tags dropped");
  assert.deepEqual(h.events.map((e) => e.kind), ["voicemail", "no_answer", "reply", "email", "call"]);
  assert.equal(h.events.find((e) => e.kind === "reply")!.text, "Jake Griffin wrote: Got it, thanks.");
  assert.ok(!h.events.some((e) => /Opener:/.test(e.text)), "saved openers aren't history");
});
