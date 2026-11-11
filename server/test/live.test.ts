import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetRecords, rebuildRecord, recordFor } from "../src/accountstate.js";
import { callState, resetCallStateChecks, type Deps } from "../src/assistant.js";
import { handleCloseEvent, parseCloseEvent, type HookContext } from "../src/closehooks.js";
import { demoLlm, FakeClose, fakeCloseEvent } from "../src/demo.js";
import { DEMO_LEAD_ID, roddaCall, roddaLead } from "../src/fixtures.js";
import { POINTS, raceLive, teamRace, withLiveLanes } from "../src/race.js";
import { store } from "../src/store.js";

// Live (11/10): a call made in Close moves the West Game and the side panel within seconds, from Close's events.
const rep = (name: string, email: string, id: string) => ({ name, email, closeUserId: id, timeZone: "America/Chicago", sender: null, emailAccountId: null });
const ctxFor = (team: Deps[], owner: Deps): HookContext => ({ depsForUser: async (id) => team.find((t) => t.rep.closeUserId === id) ?? null, allDeps: async () => team, ownerDeps: async () => owner });

test("West Game: a call completed in Close bumps the racer's dials (and talks, when it was a real conversation) on the next live check", async () => {
  const ownerId = "user_live_owner";
  const close = new FakeClose();
  const walt: Deps = { close, llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", ownerId) };
  const team = [walt];
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, ownerId, { fresh: true });
  assert.equal(race.lanes.find((l) => l.first === "Walt")?.dials, 0);
  const now = new Date().toISOString();
  const ev = (id: string, extra: Record<string, unknown>) => parseCloseEvent(fakeCloseEvent({ object_type: "activity.call", action: "completed", lead_id: DEMO_LEAD_ID, user_id: ownerId, data: { id, lead_id: DEMO_LEAD_ID, user_id: ownerId, direction: "outbound", date_created: now, ...extra } }))!;
  await handleCloseEvent(ev("acti_live_1", { disposition: "no-answer", duration: 0 }), ctxFor(team, walt));
  await handleCloseEvent(ev("acti_live_2", { disposition: "answered", duration: 95 }), ctxFor(team, walt));
  // The same call reported twice (created, then completed) is one dial.
  await handleCloseEvent(ev("acti_live_2", { disposition: "answered", duration: 95 }), ctxFor(team, walt));
  // An inbound call isn't a dial.
  await handleCloseEvent(ev("acti_live_in", { direction: "inbound", disposition: "answered", duration: 300 }), ctxFor(team, walt));
  // The ladder (11/11): a buyer reached is a status move to Reached buyer on a lead with a conversation of a minute
  // or more; the move alone (a tap on a 30s call) doesn't count. A buyer named is a move to Named buyer.
  const move = (lead: string, label: string) => parseCloseEvent(fakeCloseEvent({ object_type: "activity.lead_status_change", action: "created", lead_id: lead, user_id: ownerId, data: { lead_id: lead, new_status_label: label, old_status_label: "Fit", date_created: now } }))!;
  await handleCloseEvent(move(DEMO_LEAD_ID, "Reached buyer"), ctxFor(team, walt));
  await handleCloseEvent(move("lead_live_short000000001", "Reached buyer"), ctxFor(team, walt));
  await handleCloseEvent(ev("acti_live_short", { lead_id: "lead_live_short000000001", disposition: "answered", duration: 30 }), ctxFor(team, walt));
  // A buyer named is a move to Named buyer backed by a contact the rep made on the lead (11/11: the migration's moves
  // alone paid Walt 440); a move with no contact behind it is a script's, not a name.
  await handleCloseEvent(move("lead_live_script00000001", "Named buyer"), ctxFor(team, walt));
  await (walt.close as FakeClose).createContact("lead_live_named000000001", { name: "Pat Buyer", title: "Buyer", email: null, phone: null });
  await handleCloseEvent(move("lead_live_named000000001", "Named buyer"), ctxFor(team, walt));
  const live = await withLiveLanes(race, { ownerId });
  const lane = live.lanes.find((l) => l.first === "Walt")!;
  assert.equal(lane.dials, 3);
  assert.equal(lane.reached, 1, "the minute-long call's lead, not the 30-second one");
  assert.equal(lane.named, 1);
  assert.equal(lane.points, 3 * POINTS.dial + POINTS.reached + POINTS.named);
  // The shared live copy every screen reads was dropped by the event, so it shows them too.
  const shown = await raceLive(ownerId, "America/Chicago");
  assert.equal(shown.lanes?.find((l) => l.first === "Walt")?.dials, 3);
  // A call from yesterday reported late doesn't count for today.
  await handleCloseEvent(ev("acti_live_old", { disposition: "answered", duration: 95, date_created: new Date(Date.now() - 2 * 86_400_000).toISOString() }), ctxFor(team, walt));
  assert.equal((await withLiveLanes(race, { ownerId })).lanes.find((l) => l.first === "Walt")?.dials, 3);
});

test("West Game: an RFQ that comes in by email is celebrated on the event, and a line card sent by hand scores", async () => {
  const ownerId = "user_live_rfq";
  const close = new FakeClose();
  close.lead_ = roddaLead({ date_created: new Date(Date.now() - 10 * 86_400_000).toISOString() } as never);
  const walt: Deps = { close, llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", ownerId) };
  const team = [walt];
  const now = new Date().toISOString();
  // We emailed them the line card last week.
  close.sentEmails.push({ id: "acti_card_live", lead_id: DEMO_LEAD_ID, user_id: ownerId, status: "sent", direction: "outgoing", subject: "Westgate Supply – line card", date_sent: new Date(Date.now() - 7 * 86_400_000).toISOString(), date_created: new Date(Date.now() - 7 * 86_400_000).toISOString(), attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }], to: ["rob@roddaelectric.com"] });
  await store.cacheSet("race:team", null, 1);
  const race = await teamRace(team, ownerId, { fresh: true });
  const email = { id: "acti_rfq_live", lead_id: DEMO_LEAD_ID, user_id: ownerId, direction: "incoming", status: "inbox", sender: "Rob Roy <rob@roddaelectric.com>", subject: "RFQ 26-0100", date_created: now, attachments: [{ filename: "rfq-26-0100.xlsx", content_type: "application/vnd.ms-excel" }], body_text: "Please quote the attached." };
  await handleCloseEvent(parseCloseEvent(fakeCloseEvent({ object_type: "activity.email", action: "created", lead_id: DEMO_LEAD_ID, user_id: ownerId, data: email }))!, ctxFor(team, walt));
  const live = await raceLive(ownerId, "America/Chicago");
  const celebrated = live.events.find((e) => e.company === "Rodda Electric, Inc.");
  assert.ok(celebrated, "on every screen within seconds");
  assert.equal(celebrated!.email, "walt@westgatesupply.com");
  assert.ok(celebrated!.showAt);
  const lane = (await withLiveLanes(race, { ownerId })).lanes.find((l) => l.first === "Walt")!;
  assert.equal(lane.rfqs, 1);
  // Our own quote coming back isn't an RFQ.
  const ours = { ...email, id: "acti_ours_live", attachments: [{ filename: "WG-2YT8TF_Quote.pdf", content_type: "application/pdf" }], subject: "FW: quote", body_text: "see attached" };
  await handleCloseEvent(parseCloseEvent(fakeCloseEvent({ object_type: "activity.email", action: "created", lead_id: DEMO_LEAD_ID, user_id: ownerId, data: ours }))!, ctxFor(team, walt));
  assert.equal((await withLiveLanes(race, { ownerId })).lanes.find((l) => l.first === "Walt")!.rfqs, 1);
  // A line card sent by hand from Close today.
  // To purchasing@ it wouldn't count (the ladder, 11/11): the card has to go to a person.
  const toBox = { id: "acti_card_box", lead_id: "lead_live_box000000001", user_id: ownerId, direction: "outgoing", status: "sent", date_sent: now, date_created: now, to: ["purchasing@other.test"], attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }] };
  await handleCloseEvent(parseCloseEvent(fakeCloseEvent({ object_type: "activity.email", action: "sent", lead_id: "lead_live_box000000001", user_id: ownerId, data: toBox }))!, ctxFor(team, walt));
  assert.equal((await withLiveLanes(race, { ownerId })).lanes.find((l) => l.first === "Walt")!.lineCards, 0, "a card to a shared mailbox isn't a card to a buyer");
  const card = { id: "acti_card_today", lead_id: "lead_live_other0000001", user_id: ownerId, direction: "outgoing", status: "sent", date_sent: now, date_created: now, to: ["Rob Roy <rob@other.test>"], attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }] };
  await handleCloseEvent(parseCloseEvent(fakeCloseEvent({ object_type: "activity.email", action: "sent", lead_id: "lead_live_other0000001", user_id: ownerId, data: card }))!, ctxFor(team, walt));
  assert.equal((await withLiveLanes(race, { ownerId })).lanes.find((l) => l.first === "Walt")!.lineCards, 1);
  // The sequence's own send (recorded as an automation) doesn't.
  await store.putAutomation({ id: "acti_auto_card", repId: ownerId, leadId: "lead_live_auto00000001", company: "X", to: "x@y.z", subject: "s", kind: "bump", label: "l", reason: "r", scheduledFor: now, createdAt: now, status: "sent", statusAt: now, note: null, checkedAt: null });
  await handleCloseEvent(parseCloseEvent(fakeCloseEvent({ object_type: "activity.email", action: "sent", lead_id: "lead_live_auto00000001", user_id: ownerId, data: { ...card, id: "acti_auto_card", lead_id: "lead_live_auto00000001" } }))!, ctxFor(team, walt));
  assert.equal((await withLiveLanes(race, { ownerId })).lanes.find((l) => l.first === "Walt")!.lineCards, 1);
});

test("the side panel's call state comes from the record: a call in progress shows without a Close read; Close is asked only when the record is old, and then rarely", async () => {
  const close = new FakeClose({ calls: [] });
  const userId = "user_live_panel";
  const d: Deps = { close, llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", userId) };
  const since = new Date(Date.now() - 60_000).toISOString();
  // No record yet: Close is asked, as before.
  let closeReads = 0;
  const orig = close.calls.bind(close);
  close.calls = (async (q: Parameters<typeof orig>[0]) => { closeReads++; return orig(q); }) as never;
  assert.deepEqual(await callState(d, DEMO_LEAD_ID, since), { state: "idle" });
  assert.equal(closeReads, 1);
  // Close reports the dial; the record is rebuilt from the event (light: the lead and its calls).
  close.calls_.push(roddaCall({ id: "acti_panel_1", user_id: userId, status: "in-progress", disposition: null, duration: 0, date_created: new Date().toISOString(), recording_transcript: null }));
  await rebuildRecord(d, DEMO_LEAD_ID, "event", { light: true });
  closeReads = 0;
  const on = await callState(d, DEMO_LEAD_ID, since);
  assert.equal(on.state, "on_call");
  assert.equal((on as { callId: string }).callId, "acti_panel_1");
  assert.equal(closeReads, 0, "from the record");
  // It ends: the completed event rebuilds the record; the panel sees it ended.
  close.calls_[0] = roddaCall({ id: "acti_panel_1", user_id: userId, status: "completed", disposition: "answered", duration: 70, date_created: close.calls_[0].date_created, recording_transcript: null });
  await rebuildRecord(d, DEMO_LEAD_ID, "event", { light: true });
  closeReads = 0;
  const ended = await callState(d, DEMO_LEAD_ID, since);
  assert.equal(ended.state, "ended");
  assert.equal((ended as { duration: number }).duration, 70);
  assert.equal(closeReads, 0);
  // An old record (no event for a while): Close is asked, but at most every twenty seconds.
  const row = (await store.getAccountState(userId, DEMO_LEAD_ID))!;
  const data = row.data as { facts: { at: string } };
  data.facts.at = new Date(Date.now() - 10 * 60_000).toISOString();
  await store.putAccountState(row);
  forgetRecords(userId);
  assert.equal((await recordFor(d, DEMO_LEAD_ID))?.facts.at, data.facts.at);
  resetCallStateChecks(); // the first poll's Close read was moments ago; pretend it was a while back
  await callState(d, DEMO_LEAD_ID, since);
  await callState(d, DEMO_LEAD_ID, since);
  assert.equal(closeReads, 1, "one Close read for the two polls");
});
