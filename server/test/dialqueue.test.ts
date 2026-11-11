import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { parseCloseEvent, type HookContext } from "../src/closehooks.js";
import { demoLlm, FakeClose, fakeCloseEvent } from "../src/demo.js";
import { buildQueue, captureGreeting, DEAL, greetingName, greetingNames, nextUp, stageOf, syncQueue, windowAt } from "../src/dialqueue.js";
import { DEMO_LEAD_ID, roddaCall } from "../src/fixtures.js";
import { handleCloseEvent } from "../src/closehooks.js";
import { store } from "../src/store.js";

// The dial queue (Walt 11/11): working leads and discovery dealt together, a voicemail breaker, names off greetings.
const tz = "America/Chicago";
const userId = "user_queue_walt";
const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: userId, timeZone: tz, sender: null, emailAccountId: null };
const contact = (name: string, title: string | null, email?: string, phone?: string) => ({ id: `cont_${name.replace(/\W/g, "")}`, name, title, emails: email ? [{ email, type: "office" }] : [], phones: phone ? [{ phone, type: "direct" }] : [{ phone: "+15550000000", type: "office" }] });
function setup(now = new Date("2026-11-12T14:30:00Z")) { // Thu 8:30am Central
  const close = new FakeClose({ calls: [] });
  close.customFields_.push({ id: "cf_owner", name: "Lead owner" }, { id: "cf_tier", name: "icp_tier" });
  const lead = (id: string, name: string, status: string, tier: string, contacts: unknown[] = [], state = "TX") => ({ id, display_name: name, status_label: status, addresses: [{ state }], contacts, "custom.cf_owner": userId, "custom.cf_tier": tier });
  close.ownedLeads = [
    lead("lead_q_ron00000000000001", "Acme Fab", "Named buyer", "A", [contact("Ron Sturm", "Purchasing Manager", "ron@acme.test")]),
    lead("lead_q_card0000000000001", "Beta Vessels", "Sent Line Card", "A", [contact("Kim Lee", "Buyer", "kim@beta.test")]),
    lead("lead_q_fitA000000000001", "Gamma Skids", "Fit", "A", [contact("Main Office", null)]),
    lead("lead_q_fitB000000000001", "Delta Steel", "Fit", "B", [contact("Main Office", null)], "OH"),
    lead("lead_q_fitA200000000001", "Epsilon Process", "Fit", "A", [contact("Main Office", null)]),
    lead("lead_q_avoid00000000001", "Zeta Electric", "Fit", "Avoid", [contact("Pat Kim", "Buyer", "pat@zeta.test")]),
    lead("lead_q_rfq000000000001", "Eta Boilers", "RFQ Received", "A", [contact("Ann Roe", "Buyer", "ann@eta.test")]),
    lead("lead_q_task000000000001", "Theta Mechanical", "Fit", "B", [contact("Main Office", null)]),
  ];
  // The card went to Kim on Tuesday; a callback is due this morning on Theta.
  close.sentEmails.push({ id: "acti_q_card", lead_id: "lead_q_card0000000000001", user_id: userId, status: "sent", direction: "outgoing", subject: "Westgate Supply – line card", date_sent: "2026-11-10T16:00:00Z", date_created: "2026-11-10T16:00:00Z", to: ["Kim Lee <kim@beta.test>"], attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }], opens: [] });
  close.extraTasks.push({ id: "task_q_theta", lead_id: "lead_q_task000000000001", assigned_to: userId, text: "Call back Sam at Theta", date: "2026-11-12T15:30:00Z", is_complete: false });
  const d: Deps = { close, llm: demoLlm, now: () => now, rep };
  const ctx: HookContext = { depsForUser: async (id) => (id === userId ? d : null), allDeps: async () => [d], ownerDeps: async () => d };
  return { close, d, ctx };
}

test("the stage from My leads: status, buyer and card, whichever is further; Avoid and the exits are out", () => {
  const base = { status: "Fit", buyer: null, cardSentAt: null, tier: "A" };
  assert.equal(stageOf(base), "fit");
  const ron = { id: "c", name: "Ron", title: "Buyer", email: "r@x.test", phone: null, direct: true, line: null };
  assert.equal(stageOf({ ...base, buyer: ron }), "named");
  assert.equal(stageOf({ ...base, buyer: ron, cardSentAt: "2026-11-10T16:00:00Z" }), "card");
  assert.equal(stageOf({ ...base, status: "Reached buyer", buyer: ron }), "reached");
  assert.equal(stageOf({ ...base, tier: "Avoid", buyer: ron }), "out");
  assert.equal(stageOf({ ...base, status: "Not Interested", buyer: ron }), "out");
  assert.equal(stageOf({ ...base, status: "Potential", tier: null }), "potential");
});

test("the deal: follow-ups and buyer calls lead the morning, discovery is a third at most, out and RFQ leads never appear", async () => {
  const { d } = setup();
  await store.putSetting("team", "leadOwnerFieldId", "cf_owner");
  await store.putSetting("team", "icpFieldIds", { tier: "cf_tier", segment: null, buys: null, why: null });
  const q = await buildQueue(d);
  assert.equal(q.window, "morning");
  assert.equal(windowAt(8), "morning"); assert.equal(windowAt(11), "midday"); assert.equal(windowAt(14), "afternoon"); assert.equal(windowAt(16), "late");
  assert.equal(DEAL.morning.filter((p) => p === "discovery").length, 3, "three discovery slots in ten");
  const names = q.cards.map((c) => `${c.pile}:${c.company}`);
  assert.ok(!names.some((n) => /Zeta|Eta/.test(n)), "Avoid and RFQ Received are out of the queue");
  assert.equal(q.cards[0].pile, "buyer", "the morning opens on a buyer call");
  assert.equal(q.cards[0].company, "Beta Vessels", "the card that went Tuesday: follow up");
  assert.match(q.cards[0].why, /card went Nov 10, Kim: follow up/);
  assert.equal(q.cards[1].pile, "followup");
  assert.match(q.cards[1].why, /^callback 9:30/);
  const ron = q.cards.find((c) => c.company === "Acme Fab")!;
  assert.equal(ron.pile, "quick", "named, no card yet: send Ron the card, no phone needed");
  assert.equal(ron.noPhone, true);
  const disc = q.cards.filter((c) => c.pile === "discovery");
  assert.deepEqual(disc.map((c) => c.company), ["Epsilon Process", "Gamma Skids", "Delta Steel"], "A before B, Gulf before Ohio (ties by name, as My leads lists them)");
  assert.deepEqual(q.piles, { buyer: 1, followup: 1, discovery: 3, quick: 1 });
  assert.equal(q.cards.at(-1)!.rank, q.cards.length);
});

test("the breaker: two mailboxes in a row and the next card is a company that picks up; three discovery calls with no human and it's a quick win", async () => {
  const { d } = setup();
  const q = await buildQueue(d);
  const vm = (id: string, leadId: string, at: string, more: Record<string, unknown> = {}) => [id, { at, leadId, vm: true, ...more }] as const;
  const day = "2026-11-12";
  // Beta (buyer) and Theta (follow-up) already dialed, both mailboxes.
  await store.putSetting(userId, "callsToday", { day, calls: Object.fromEntries([vm("c1", "lead_q_card0000000000001", "2026-11-12T14:00:00Z"), vm("c2", "lead_q_task000000000001", "2026-11-12T14:05:00Z")]), lineCards: {} });
  let n = await nextUp(d, q);
  assert.equal(n.breaker, "mailboxes");
  assert.equal(n.card?.pile, "quick", "nothing left that has picked up before, so the next non-discovery card");
  // Three discovery calls, nobody home: a quick win next.
  await store.putSetting(userId, "callsToday", { day, calls: Object.fromEntries([
    ["c3", { at: "2026-11-12T14:10:00Z", leadId: "lead_q_fitA000000000001", vm: false, reached: false }],
    ["c4", { at: "2026-11-12T14:12:00Z", leadId: "lead_q_fitA200000000001", vm: true }],
    ["c5", { at: "2026-11-12T14:14:00Z", leadId: "lead_q_fitB000000000001", vm: false, reached: false }],
  ]), lineCards: {} });
  n = await nextUp(d, q);
  assert.equal(n.breaker, "no human");
  assert.equal(n.card?.company, "Acme Fab");
  // A conversation resets it.
  await store.putSetting(userId, "callsToday", { day, calls: { c6: { at: "2026-11-12T14:20:00Z", leadId: "lead_q_card0000000000001", reached: true } }, lineCards: {} });
  n = await nextUp(d, q);
  assert.equal(n.breaker, null);
  assert.equal(n.card?.company, "Theta Mechanical", "the first card not called today");
  assert.equal(n.left, q.cards.length - 1);
});

test("names off voicemail greetings: read from the transcript, written to Close as an unconfirmed contact, and the queue asks for them", async () => {
  assert.equal(greetingName("Your call has been forwarded to the voicemail for Ron Sturm. No one is available."), "Ron Sturm");
  assert.equal(greetingName("Hello, this is Joseph Wolantoski at Marlowe Incorporated. I'm not available"), "Joseph Wolantoski");
  assert.equal(greetingName("Transferring to Tyler Emery. Tyler Emery is not available to take your call."), "Tyler Emery");
  assert.equal(greetingName("Thank you for calling PSP Industries. Please leave a message."), null);
  assert.equal(greetingName("Hey, this is Walt at Westgate Supply, I just sent you an email"), null, "never the rep");
  const { close, d, ctx } = setup();
  const call = roddaCall({ id: "acti_q_vm", lead_id: "lead_q_fitA000000000001", user_id: userId, disposition: "vm-left", duration: 70, recording_transcript: { utterances: [{ speaker_side: "contact", text: "Thank you for calling Gamma Skids." }, { speaker_side: "close-user", text: "Hi, Walt calling for purchasing." }, { speaker_side: "contact", text: "Your call has been forwarded to the voicemail for Ron Sturm. Please leave a message." }] } as never });
  close.calls_.push(call);
  const name = await captureGreeting(d, { id: call.id, lead_id: call.lead_id, disposition: call.disposition, duration: call.duration });
  assert.equal(name, "Ron Sturm");
  const made = close.writes.find((w) => w.op === "contact")!.body as { leadId: string; name: string; title: string };
  assert.equal(made.leadId, "lead_q_fitA000000000001");
  assert.equal(made.name, "Ron Sturm");
  assert.match(made.title, /voicemail greeting/);
  assert.equal((await greetingNames(userId))["lead_q_fitA000000000001"].name, "Ron Sturm");
  // Once is enough.
  assert.equal(await captureGreeting(d, { id: call.id, lead_id: call.lead_id, disposition: call.disposition, duration: call.duration }), null);
  assert.equal(close.writes.filter((w) => w.op === "contact").length, 1);
  // The queue now holds Gamma as a quick win: confirm Ron's line.
  const q = await buildQueue(d);
  const gamma = q.cards.find((c) => c.company === "Gamma Skids")!;
  assert.equal(gamma.pile, "quick");
  assert.match(gamma.why, /^Ron from the greeting: confirm the line/);
  // And the feed does the same on a completed call event.
  const ev = parseCloseEvent(fakeCloseEvent({ object_type: "activity.call", action: "completed", lead_id: "lead_q_fitA200000000001", user_id: userId, data: { id: "acti_q_vm2", lead_id: "lead_q_fitA200000000001", direction: "outbound", disposition: "vm-left", duration: 60 } }))!;
  close.calls_.push(roddaCall({ id: "acti_q_vm2", lead_id: "lead_q_fitA200000000001", user_id: userId, disposition: "vm-left", duration: 60, recording_transcript: { utterances: [{ speaker_side: "contact", text: "Hi, this is Brenner Bundyk. Leave a message and I'll call you back." }] } as never }));
  await handleCloseEvent(ev, ctx);
  assert.equal((await greetingNames(userId))["lead_q_fitA200000000001"]?.name, "Brenner Bundyk");
  void DEMO_LEAD_ID;
});

test("the queue in Close: queue_rank and queue_why on the ranked leads, cleared when they drop out, and one My queue view", async () => {
  const { close, d } = setup();
  await store.putSetting(userId, "queueWritten", { lead_q_stale000000000001: { rank: 7, why: "old" } });
  const r = await syncQueue(d);
  const ids = close.customFields_.filter((f) => ["queue_rank", "queue_why"].includes(f.name));
  assert.equal(ids.length, 2, "the two fields are made once");
  const ups = close.writes.filter((w) => w.op === "lead-update").map((w) => w.body as Record<string, unknown>);
  const first = ups.find((u) => u.leadId === "lead_q_card0000000000001")!;
  assert.equal(first[`custom.${ids[0].id}`], 1);
  assert.match(String(first[`custom.${ids[1].id}`]), /card went/);
  assert.ok(ups.some((u) => u.leadId === "lead_q_stale000000000001" && u[`custom.${ids[0].id}`] === null), "the stale rank is cleared");
  assert.equal(r.cleared, 1);
  assert.equal(r.written, 6);
  assert.ok(r.view, "My queue exists");
  assert.equal(close.savedSearches_.length, 1);
  assert.match(close.savedSearches_[0].name, /My queue/);
  // Nothing changed: nothing written again.
  const again = await syncQueue(d);
  assert.equal(again.written, 0);
  assert.equal(close.savedSearches_.length, 1, "the view is updated in place");
});
