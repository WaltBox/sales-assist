import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { cardOnReach, markBuyerReached, markRfqIncoming, saveBuyer } from "../src/buyer.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID } from "../src/fixtures.js";
import { store } from "../src/store.js";

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: "user_buyer_walt", timeZone: "America/Chicago", sender: null, emailAccountId: null };
const deps = (close: FakeClose): Deps => ({ close: close as unknown as Deps["close"], llm: demoLlm, rep, now: () => new Date("2026-11-12T15:00:00Z") });

test("the name and email typed on the card go onto the lead in Close as a contact, and the lead moves to Named buyer (Walt 11/11)", async () => {
  const close = new FakeClose({ calls: [] });
  close.leadStatus.set(DEMO_LEAD_ID, "Fit");
  const r = await saveBuyer(deps(close), DEMO_LEAD_ID, { name: "  Jen Braun ", title: "Purchasing Agent", email: "JBraun@teamind.com", phone: "" });
  const made = close.writes.find((w) => w.op === "contact");
  assert.ok(made, "a contact was created");
  assert.deepEqual(made!.body, { leadId: DEMO_LEAD_ID, name: "Jen Braun", title: "Purchasing Agent", email: "jbraun@teamind.com", phone: null });
  assert.equal(r.contactId, made!.id);
  assert.equal(r.status, "Named buyer");
  assert.equal(close.leadStatus.get(DEMO_LEAD_ID), "Named buyer");
  // Never backwards: a lead already at Sent Line Card stays there.
  close.leadStatus.set(DEMO_LEAD_ID, "Sent Line Card");
  assert.equal((await saveBuyer(deps(close), DEMO_LEAD_ID, { name: "Jen Braun" })).status, null);
  assert.equal(close.leadStatus.get(DEMO_LEAD_ID), "Sent Line Card");
});

test("an email for a person already on the lead is added to that contact, keeping what Close had; a bad email or no name is refused", async () => {
  const close = new FakeClose({ calls: [] });
  close.leadStatus.set(DEMO_LEAD_ID, "Named buyer");
  await saveBuyer(deps(close), DEMO_LEAD_ID, { contactId: "cont_robroy", name: "Rob Roy", email: "rob@roddaelectric.com" });
  const upd = close.writes.find((w) => w.op === "contact-update");
  assert.ok(upd, "the contact was updated, not a second one made");
  assert.equal(close.writes.filter((w) => w.op === "contact").length, 0);
  assert.deepEqual(upd!.body, { contactId: "cont_robroy", emails: [{ email: "rob@roddaelectric.com", type: "office" }] });
  await assert.rejects(saveBuyer(deps(close), DEMO_LEAD_ID, { name: "Pat", email: "not-an-email" }), /email doesn't look right/);
  await assert.rejects(saveBuyer(deps(close), DEMO_LEAD_ID, { name: "   " }), /name is needed/);
});

test("Reached marks the buyer reached in Close: the status moves to Reached buyer, never backwards", async () => {
  const close = new FakeClose({ calls: [] });
  close.leadStatus.set(DEMO_LEAD_ID, "Sent Line Card");
  const r = await markBuyerReached(deps(close), DEMO_LEAD_ID);
  assert.equal(r.status, "Reached buyer");
  assert.equal(close.leadStatus.get(DEMO_LEAD_ID), "Reached buyer");
  close.leadStatus.set(DEMO_LEAD_ID, "RFQ Received");
  assert.equal((await markBuyerReached(deps(close), DEMO_LEAD_ID)).status, null);
  assert.equal(close.leadStatus.get(DEMO_LEAD_ID), "RFQ Received");
});

test("RFQ incoming writes the promise note Close and the heat map already read, with the name and when; no status move", async () => {
  const close = new FakeClose({ calls: [] });
  close.leadStatus.set(DEMO_LEAD_ID, "Reached buyer");
  await markRfqIncoming(deps(close), DEMO_LEAD_ID, { name: "Jim", when: "by Thursday" });
  const note = close.writes.find((w) => w.op === "note");
  assert.ok(note);
  assert.deepEqual(note!.body, { leadId: DEMO_LEAD_ID, note: "[RFQ promised] Jim said they'll send one, by Thursday (tapped on the call card).", pinned: false });
  assert.equal(close.leadStatus.get(DEMO_LEAD_ID), "Reached buyer");
});

test("only the name is required (Walt 11/11): a name alone is saved as the buyer, titled so the ladder knows it; with an email no title is made up", async () => {
  const close = new FakeClose({ calls: [] });
  close.leadStatus.set(DEMO_LEAD_ID, "Fit");
  await saveBuyer(deps(close), DEMO_LEAD_ID, { name: "Jim" });
  assert.deepEqual(close.writes.find((w) => w.op === "contact")!.body, { leadId: DEMO_LEAD_ID, name: "Jim", title: "Buyer", email: null, phone: null });
  const close2 = new FakeClose({ calls: [] });
  await saveBuyer(deps(close2), DEMO_LEAD_ID, { name: "Jim", email: "jim@jrhoe.com" });
  assert.deepEqual(close2.writes.find((w) => w.op === "contact")!.body, { leadId: DEMO_LEAD_ID, name: "Jim", title: null, email: "jim@jrhoe.com", phone: null });
});

test("the card goes the moment the buyer is reached (Walt 11/12): with an address and no card to it yet; nothing without an address", async () => {
  const close = new FakeClose({ calls: [] });
  close.leadStatus.set(DEMO_LEAD_ID, "Named buyer");
  assert.deepEqual(await cardOnReach(deps(close), DEMO_LEAD_ID), { sent: null, again: false, why: "no email for Rob Roy" });
  close.lead_.contacts[1].emails = [{ email: "rob@roddaelectric.com", type: "office" }];
  const r = await cardOnReach(deps(close), DEMO_LEAD_ID);
  assert.equal(r.sent, "rob@roddaelectric.com");
  assert.equal(r.again, false);
  assert.ok(close.writes.some((w) => w.op === "send" || w.op === "draft" || w.op === "email"), "an email went out");
  // It pays nothing: recorded as the app's own send, which the hand-card count leaves out (Walt 11/12).
  const auto = (await store.getSetting<Array<{ id: string }>>("user_buyer_walt", "autoCardIds")) ?? [];
  assert.equal(auto.length, 1);
  // (Real Close lists the send on the lead afterwards, so a second reach finds "already has it"; the fake doesn't.)
});

test("a second Save with the same name updates that person, never a twin (11/13: Jeff Gallon twice at Hahn & Clay)", async () => {
  const close = new FakeClose({ calls: [] });
  close.leadStatus.set(DEMO_LEAD_ID, "Fit");
  await saveBuyer(deps(close), DEMO_LEAD_ID, { name: "Rob Roy", email: "rob@roddaelectric.com" });
  assert.equal(close.writes.filter((w) => w.op === "contact").length, 0, "Rob Roy is already on the lead: updated, not added");
  assert.equal(close.writes.filter((w) => w.op === "contact-update").length, 1);
});
