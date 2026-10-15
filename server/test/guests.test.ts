import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID } from "../src/fixtures.js";
import { createGuest, GUEST_DAILY_CAP, guestFor, guestSend, guestView, listGuests, setGuestActive } from "../src/guests.js";
import { store } from "../src/store.js";

const rep = (id: string) => ({ name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: id, timeZone: "America/Los_Angeles", sender: '"Walt Boxwell" <walt@westgatesupply.com>', emailAccountId: "emailacct_demo" });

test("guest links (10/15): a link finds its guest, turning it off stops it, and the token is never stored", async () => {
  const repId = "user_guest1";
  const { guest, token } = await createGuest(repId, "Jake Miller");
  assert.ok(token.length >= 30);
  assert.equal((await guestFor(token, [repId]))?.guest.id, guest.id);
  assert.equal(await guestFor("not-a-real-token-at-all-xxxxx", [repId]), null);
  const saved = JSON.stringify(await listGuests(repId));
  assert.ok(!saved.includes(token), "only a hash of the token is kept");
  await setGuestActive(repId, guest.id, false);
  assert.equal(await guestFor(token, [repId]), null, "off: the link stops working");
  await setGuestActive(repId, guest.id, true);
  assert.ok(await guestFor(token, [repId]), "back on");
  await assert.rejects(createGuest(repId, "   "), /Give the guest a name/);
});

test("a guest send goes out from the rep's account with the line card, notes who sent it, and joins the sequence", async () => {
  const { mailDns } = await import("../src/linecard.js");
  mailDns.resolveMx = (async () => [{ exchange: "mx.example.com", priority: 10 }]) as never;
  const repId = "user_guest2";
  const close = new FakeClose();
  const d: Deps = { close, llm: demoLlm, rep: rep(repId) };
  const { guest } = await createGuest(repId, "Jake Miller");

  // Not in Close: a new lead with the contact, then the line card to it.
  const r1 = await guestSend(d, guest, { company: "Brand New Fab LLC", name: "Dana", email: "Dana@BrandNewFab.com" });
  assert.equal(r1.newLead, true);
  const made = close.writes.find((w) => w.op === "lead-create")!.body as { name: string; email: string; contactName: string };
  assert.deepEqual([made.name, made.email, made.contactName], ["Brand New Fab LLC", "dana@brandnewfab.com", "Dana"]);
  const email = close.writes.filter((w) => w.op === "email").pop()!.body as { to: string[]; attachments: Array<{ filename: string }>; sender: string; body: string };
  assert.deepEqual(email.to, ["dana@brandnewfab.com"]);
  assert.equal(email.sender, '"Walt Boxwell" <walt@westgatesupply.com>', "from the rep, not the guest");
  assert.equal(email.attachments[0].filename, "Westgate_Supply_Line_Card.pdf", "the line card rides along, so the account joins the sequence");
  assert.match(email.body, /^Hi Dana,\n\nJake suggested I send this your way\./);
  const note = close.writes.find((w) => w.op === "note" && /\[Guest\]/.test((w.body as { note: string }).note))!.body as { note: string };
  assert.match(note.note, /^\[Guest\] Jake Miller sent the line card to Dana <dana@brandnewfab\.com>/);

  // Already in Close (found by the address): no new lead.
  close.findLeadsResult = [{ id: DEMO_LEAD_ID, display_name: "Rodda Electric, Inc." }];
  const before = close.writes.filter((w) => w.op === "lead-create").length;
  const r2 = await guestSend(d, guest, { company: "Rodda", name: null, email: "renee@roddaelectric.com" });
  assert.equal(r2.newLead, false);
  assert.equal(r2.company, "Rodda Electric, Inc.");
  assert.equal(close.writes.filter((w) => w.op === "lead-create").length, before);

  const g = (await listGuests(repId)).find((x) => x.id === guest.id)!;
  assert.equal(g.sends.length, 2);
  assert.deepEqual(guestView(g).recent.map((s) => s.to), ["renee@roddaelectric.com", "dana@brandnewfab.com"]);
  assert.ok(!("leadId" in guestView(g).recent[0]), "the guest page shows only what they sent, no Close ids");
});

test("a guest send is refused when the link is off, the address is bad, or the day's cap is hit", async () => {
  const repId = "user_guest3";
  const close = new FakeClose();
  const d: Deps = { close, llm: demoLlm, rep: rep(repId) };
  const { guest } = await createGuest(repId, "Pat");
  await assert.rejects(guestSend(d, guest, { company: "X", email: "not an email" }), /doesn't look like an email/);
  await assert.rejects(guestSend(d, guest, { company: "  ", email: "a@b.com" }), /company name/);
  // A day's worth already sent.
  const all = await listGuests(repId);
  all[0].sends = Array.from({ length: GUEST_DAILY_CAP }, (_, i) => ({ at: new Date().toISOString(), company: `C${i}`, to: `x${i}@y.com`, name: null, leadId: "l", newLead: false }));
  await store.putSetting(repId, "guests", all);
  await assert.rejects(guestSend(d, guest, { company: "X", email: "a@b.com" }), new RegExp(`${GUEST_DAILY_CAP} line cards today`));
  await setGuestActive(repId, guest.id, false);
  await assert.rejects(guestSend(d, guest, { company: "X", email: "a@b.com" }), /turned off/);
  assert.ok(!close.writes.some((w) => w.op === "email"), "nothing sent");
});
