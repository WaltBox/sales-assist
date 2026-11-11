import assert from "node:assert/strict";
import { test } from "node:test";
import { buyerOf, LADDER_GOAL, ladderFor, RUNG_POINTS, rungOfStatus, statusForOutcome } from "../src/ladder.js";

// The ladder (Walt 11/11): named buyer → card → reached → RFQ, one objective per lead, paid once per rung.
const lead = (status: string, contacts: Array<{ name: string; title?: string | null; email?: string; phone?: string; type?: string }> = []) => ({
  display_name: "Acme Fab, Inc.", status_label: status,
  contacts: contacts.map((c, i) => ({ id: `cont_${i}`, name: c.name, title: c.title ?? null, emails: c.email ? [{ email: c.email, type: "office" }] : [], phones: c.phone ? [{ phone: c.phone, type: c.type ?? "office" }] : [] })),
});

test("the named buyer is a person with a buying title or their own address, not the front desk or purchasing@", () => {
  assert.equal(buyerOf(lead("Fit", [{ name: "Main Office", phone: "+15550001" }]).contacts), null);
  assert.equal(buyerOf(lead("Fit", [{ name: "Purchasing", email: "purchasing@acme.com" }]).contacts), null, "a mailbox isn't a person");
  const ron = buyerOf(lead("Fit", [{ name: "Main Office", phone: "+15550001" }, { name: "Ron Sturm", title: "Purchasing Manager", email: "ron@acme.com", phone: "+15550002", type: "direct" }]).contacts)!;
  assert.equal(ron.name, "Ron Sturm");
  assert.equal(ron.direct, true);
  const titleOnly = buyerOf(lead("Fit", [{ name: "Kim Lee", title: "Buyer" }]).contacts)!;
  assert.equal(titleOnly.name, "Kim Lee");
  assert.equal(titleOnly.direct, false, "a name with no line or address isn't reachable yet");
  assert.equal(buyerOf(lead("Fit", [{ name: "Pat Kim", title: "Welder" }]).contacts), null, "not a buying title, no address");
  assert.equal(buyerOf(lead("Fit", [{ name: "Pat Kim", email: "pat@acme.com" }]).contacts)?.name, "Pat Kim", "their own address counts even without a title");
});

test("statuses read as rungs, the old names where they meant, and the side exits as out", () => {
  assert.equal(rungOfStatus("Fit"), "fit");
  assert.equal(rungOfStatus("Named buyer"), "named");
  assert.equal(rungOfStatus("Sent Line Card"), "card");
  assert.equal(rungOfStatus("Reached buyer"), "reached");
  assert.equal(rungOfStatus("RFQ Received"), "rfq");
  assert.equal(rungOfStatus("Good lead"), "fit");
  assert.equal(rungOfStatus("Called"), "fit");
  assert.equal(rungOfStatus("Qualified"), "reached");
  for (const s of ["Not a fit", "Bad Fit", "Disqualified", "Not Interested", "Vendor", "project managers"]) assert.equal(rungOfStatus(s), "out", s);
  assert.equal(rungOfStatus("Something new"), null);
  assert.equal(statusForOutcome("reached_buyer"), "Reached buyer");
  assert.equal(statusForOutcome("got_name"), "Named buyer");
  assert.equal(statusForOutcome("voicemail"), null);
});

test("the objective follows the rung, from the status or the facts, whichever is further; Avoid is out", () => {
  const fit = ladderFor({ lead: lead("Fit"), tier: "A", repFirst: "Chase" });
  assert.equal(fit.stage, "fit");
  assert.match(fit.objective, /Get the buyer's name/);
  assert.match(fit.say!, /Who handles your pipe, fittings and bolting purchasing/);
  assert.deepEqual(fit.next, { rung: "named", points: RUNG_POINTS.named, label: "the buyer's name and email" });
  // A buyer on the lead while the status still says Fit: the rung is named, and the panel says the status is behind.
  const ron = [{ name: "Ron Sturm", title: "Purchasing Manager", email: "ron@acme.com" }];
  const named = ladderFor({ lead: lead("Fit", ron), tier: "A", repFirst: "Chase" });
  assert.equal(named.stage, "named");
  assert.equal(named.statusLags, true);
  assert.match(named.objective, /^Send Ron the card/);
  assert.match(named.say!, /^Hi Ron, it's Chase with Westgate Supply\. I sent you our line card\. What's the last RFQ you sent out/);
  assert.equal(named.next?.points, RUNG_POINTS.card);
  const card = ladderFor({ lead: lead("Named buyer", ron), tier: "A", cardSentAt: "2026-11-10T15:00:00Z", repFirst: "Chase" });
  assert.equal(card.stage, "card");
  assert.match(card.objective, /^Ron has the card\. Reach them by name/);
  assert.equal(card.next?.points, RUNG_POINTS.reached);
  const reached = ladderFor({ lead: lead("Sent Line Card", ron), tier: "A", cardSentAt: "2026-11-10T15:00:00Z", reachedAt: "2026-11-11T15:00:00Z", repFirst: "Chase" });
  assert.equal(reached.stage, "reached");
  assert.match(reached.objective, /Get the last RFQ, the quote they got, a PO, or three items/);
  assert.equal(reached.next?.points, RUNG_POINTS.rfq);
  const rfq = ladderFor({ lead: lead("RFQ Received", ron), tier: "A", rfqAt: "2026-11-11T16:00:00Z" });
  assert.equal(rfq.stage, "rfq");
  assert.equal(rfq.next?.rung, "quoted");
  // Paid once: a lead already past a rung never shows that rung's objective again.
  assert.notEqual(ladderFor({ lead: lead("Reached buyer", ron), tier: "A" }).next?.rung, "named");
  // Nobody named on the lead is discovery whatever the status says (Walt 11/11, a Sent Line Card lead with only Main
  // Office: "how the fuck are we to know that info is the buyer. We need their name"); the card says Close is ahead.
  const inbox = ladderFor({ lead: lead("Sent Line Card"), tier: "B" });
  assert.equal(inbox.stage, "fit");
  assert.equal(inbox.statusAhead, true);
  assert.match(inbox.objective, /^Close says Sent Line Card, but nobody's named here/);
  assert.equal(inbox.boxes.find((b) => b.key === "card")?.done, false, "a card to the main inbox isn't the card to the buyer");
  assert.equal(ladderFor({ lead: lead("Reached buyer"), tier: "B" }).stage, "fit");
  assert.equal(ladderFor({ lead: lead("RFQ Received"), tier: "B" }).stage, "rfq", "an RFQ is an RFQ, named or not");
  // No "Direct line" box (Walt 11/11): name, email, card, reached, RFQ.
  assert.deepEqual(ladderFor({ lead: lead("Fit"), tier: "A" }).boxes.map((b) => b.key), ["name", "email", "card", "reached", "rfq"]);
  // Avoid tier is out whatever the status says, unless they've sent an RFQ.
  assert.equal(ladderFor({ lead: lead("Fit", ron), tier: "Avoid" }).stage, "out");
  assert.equal(ladderFor({ lead: lead("RFQ Received", ron), tier: "Avoid" }).stage, "rfq");
  assert.equal(ladderFor({ lead: lead("Not Interested", ron), tier: "A" }).stage, "out");
  // Not tiered yet and nothing known: potential.
  assert.equal(ladderFor({ lead: lead("Potential"), tier: null }).stage, "potential");
  assert.equal(ladderFor({ lead: lead("Potential"), tier: "B" }).stage, "fit", "tiered: onto the ladder");
});

test("the finish is quite hard (Walt 11/11): a full morning is ~130, three new RFQs on top 250; only a monster day with RFQs finishes", () => {
  const morning = 60 * RUNG_POINTS.dial + 8 * RUNG_POINTS.named + 8 * RUNG_POINTS.card + 6 * RUNG_POINTS.reached;
  assert.equal(morning, 130);
  assert.ok(morning + 3 * (RUNG_POINTS.rfq + RUNG_POINTS.firstRfq) < LADDER_GOAL, "three new RFQs on a strong morning don't finish");
  const monster = 120 * RUNG_POINTS.dial + 12 * RUNG_POINTS.named + 12 * RUNG_POINTS.card + 10 * RUNG_POINTS.reached;
  assert.equal(monster, 230);
  assert.ok(monster + 2 * (RUNG_POINTS.rfq + RUNG_POINTS.firstRfq) < LADDER_GOAL, "even a monster day needs three");
  assert.ok(monster + 3 * (RUNG_POINTS.rfq + RUNG_POINTS.firstRfq) >= LADDER_GOAL, "Chase's best day (119 calls, 4 RFQs) finishes");
  assert.ok(120 * RUNG_POINTS.dial < LADDER_GOAL, "never on dials alone");
  assert.ok(monster < LADDER_GOAL, "never on names and conversations alone");
});

test("RFQ incoming (Walt 11/11): a promise keeps the rung, reads as warm, pays nothing until the RFQ lands", () => {
  const jim = [{ name: "Jim Colley", title: "Purchasing", email: "jcolley@jrhoe.com" }];
  const waiting = ladderFor({ lead: lead("Reached buyer", jim), tier: "A", reachedAt: "2026-11-11T15:00:00Z", promisedAt: "2026-11-11T15:20:00Z" });
  assert.equal(waiting.stage, "reached");
  assert.deepEqual(waiting.promised, { at: "2026-11-11T15:20:00Z" });
  assert.equal(waiting.label, "RFQ incoming");
  assert.match(waiting.steps[0], /^Watch for Jim's RFQ/);
  assert.equal(waiting.next?.rung, "rfq", "the next rung is still the RFQ, paid when it lands");
  assert.equal(ladderFor({ lead: lead("Reached buyer", jim), tier: "A" }).promised, null);
  assert.equal(ladderFor({ lead: lead("RFQ Received", jim), tier: "A", rfqAt: "x", promisedAt: "2026-11-11T15:20:00Z" }).promised, null, "landed: no longer waiting");
});

test("a contact named after its mailbox is the inbox, not the buyer (Power Source Services, 11/11): the lead stays in discovery", () => {
  const inbox = [{ id: "cont_pss", name: "psscolorado", title: null, emails: [{ email: "psscolorado@gmail.com", type: "office" }], phones: [] }];
  assert.equal(buyerOf(inbox as never), null);
  const L = ladderFor({ lead: lead("Sent Line Card", inbox as never), tier: "A" });
  assert.equal(L.stage, "fit");
  assert.equal(L.statusAhead, true);
});
