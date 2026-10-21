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
  const note = close.writes.find((w) => w.op === "note" && /\[Work trial\]/.test((w.body as { note: string }).note))!.body as { note: string };
  assert.match(note.note, /^\[Work trial\] Jake Miller \(work trial\) sent the line card to Dana <dana@brandnewfab\.com>\.$/);
  assert.equal((close.writes.filter((w) => w.op === "email").pop()!.body as { html: string | null }).html, null, "no meme unless they ask for one");

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
  all.find((x) => x.id === guest.id)!.sends = Array.from({ length: GUEST_DAILY_CAP }, (_, i) => ({ at: new Date().toISOString(), company: `C${i}`, to: `x${i}@y.com`, name: null, leadId: "l", newLead: false }));
  await store.putSetting(repId, "guests", all);
  await assert.rejects(guestSend(d, guest, { company: "X", email: "a@b.com" }), new RegExp(`${GUEST_DAILY_CAP} line cards today`));
  await setGuestActive(repId, guest.id, false);
  await assert.rejects(guestSend(d, guest, { company: "X", email: "a@b.com" }), /turned off/);
  assert.ok(!close.writes.some((w) => w.op === "email"), "nothing sent");
});

test("call list (10/15): the guest's sheet loads, each call is marked, a note goes on the company in Close, and it comes back as a CSV", async () => {
  const { putList, getList, markListLead, listSummary, listCsv } = await import("../src/guests.js");
  const repId = "user_guestList";
  const close = new FakeClose();
  const d: Deps = { close, llm: demoLlm, rep: rep(repId) };
  const { guest } = await createGuest(repId, "Jake Miller");
  const rows = [
    { company: "Accel Fire Systems, Inc.", phone: "(888) 952-2235", askFor: "Purchasing manager", what: "Fire protection", city: "Anchorage", state: "ak" },
    { company: "Rodda Electric, Inc.", phone: "(925) 240-6024", askFor: "Renee (Purchasing)", what: "", city: "Brentwood", state: "CA", outcome: "not a real outcome" },
    { company: "", phone: "(000) 000-0000" }, // no company: dropped
  ];
  const list = await putList(repId, guest, { name: "Worktrial leads", rows });
  assert.equal(list.leads.length, 2);
  assert.equal(list.leads[0].state, "AK", "state upper-cased");
  assert.equal(list.leads[1].outcome, null, "an outcome that isn't one of ours is ignored");
  await assert.rejects(putList(repId, guest, { rows: [{ company: "", phone: "" }] }), /company and a phone/);

  // Marking a call: the outcome sticks, and the company in Close gets a note (found by name).
  close.findLeadsResult = [{ id: DEMO_LEAD_ID, display_name: "Rodda Electric, Inc." }];
  await markListLead(d, guest, 1, { outcome: "Voicemail", notes: "Renee out till Monday" });
  const saved = (await getList(repId, guest.id))!;
  assert.equal(saved.leads[1].outcome, "Voicemail");
  const note = close.writes.find((w) => w.op === "note")!.body as { leadId: string; note: string };
  assert.deepEqual([note.leadId, note.note], [DEMO_LEAD_ID, "[Work trial] Called by Jake Miller (work trial): Voicemail. Notes: Renee out till Monday"]);
  assert.ok(!close.writes.some((w) => w.op === "status" || w.op === "task"), "notes only: no status changes, no tasks");
  // Same outcome again: no second note. A bad outcome is refused.
  await markListLead(d, guest, 1, { notes: "Renee out till Monday, try 9am" });
  assert.equal(close.writes.filter((w) => w.op === "note").length, 1);
  await assert.rejects(markListLead(d, guest, 1, { outcome: "Sold them a boat" }), /Pick an outcome/);
  await assert.rejects(markListLead(d, guest, 99, { outcome: "Voicemail" }), /isn't on your list/);

  const sum = listSummary(saved)!;
  assert.deepEqual([sum.total, sum.called, sum.by.Voicemail], [2, 1, 1]);
  const csv = listCsv((await getList(repId, guest.id))!);
  assert.match(csv.split("\n")[0], /^Company,Phone,Ask for,What they do,City,State,Outcome,Called at,Name they got,Email \(for line card\),Notes$/);
  assert.match(csv, /"Rodda Electric, Inc\.",\(925\) 240-6024,Renee \(Purchasing\),,Brentwood,CA,Voicemail,\d{4}-\d{2}-\d{2}T[^,]+,,,"Renee out till Monday, try 9am"/);
  // Got a name (10/15): the name is saved and goes into a note in Close.
  await markListLead(d, guest, 0, { outcome: "Got a name" });
  await markListLead(d, guest, 0, { gotName: "Mike Torres, purchasing, x214" });
  const named = (await getList(repId, guest.id))!.leads[0];
  assert.equal(named.gotName, "Mike Torres, purchasing, x214");
  assert.match((close.writes.filter((w) => w.op === "note").pop()!.body as { note: string }).note, /^\[Work trial\] Called by Jake Miller \(work trial\): Got a name\. Ask for: Mike Torres, purchasing, x214\.$/);
});

test("marks in a batch all stick, the answer doesn't wait on Close, and notes come after (10/15)", async () => {
  const { putList, getList, markListLeads } = await import("../src/guests.js");
  const repId = "user_guestBatch";
  const close = new FakeClose();
  const d: Deps = { close, llm: demoLlm, rep: rep(repId) };
  const { guest } = await createGuest(repId, "Ulysses");
  await putList(repId, guest, { rows: Array.from({ length: 5 }, (_, i) => ({ company: `Co ${i}`, phone: `(555) 555-010${i}`, state: "TX" })) });
  const r = await markListLeads(d, guest, [{ i: 0, outcome: "Voicemail" }, { i: 1, outcome: "No answer" }, { i: 3, outcome: "Got a name", gotName: "Sam" }]);
  assert.equal(r.called, 3);
  assert.equal(close.writes.filter((w) => w.op === "note").length, 0, "nothing written to Close before the answer");
  assert.equal(r.notes.length, 3, "three notes to write afterward");
  const saved = (await getList(repId, guest.id))!.leads;
  assert.deepEqual(saved.map((l) => l.outcome), ["Voicemail", "No answer", null, "Got a name", null]);
  // A later batch keeps the earlier marks.
  await markListLeads(d, guest, [{ i: 4, outcome: "Wrong number" }]);
  assert.equal((await getList(repId, guest.id))!.leads.filter((l) => l.outcome).length, 4);
});

test("follow-ups (10/15): everyone they called, with the Close status, line card opens and replies; line cards first", async () => {
  const { putList, markListLeads, guestFollowUps } = await import("../src/guests.js");
  const repId = "user_guestFollow";
  const close = new FakeClose();
  let now = new Date("2026-10-15T18:00:00Z");
  const d: Deps = { close, llm: demoLlm, rep: rep(repId), now: () => now };
  const { guest } = await createGuest(repId, "Ulysses");
  await putList(repId, guest, { rows: [
    { company: "Rodda Electric, Inc.", phone: "(925) 240-6024", state: "CA" },
    { company: "Nobody Home LLC", phone: "(555) 555-0101", state: "TX" },
    { company: "Not Called Yet Co", phone: "(555) 555-0102", state: "TX" },
  ] });
  await markListLeads(d, guest, [{ i: 0, outcome: "Wants line card", email: "renee@roddaelectric.com" }, { i: 1, outcome: "Voicemail" }]);
  // Rodda is in Close with a line card that was opened twice and a reply after it; Nobody Home isn't in Close.
  close.findLeadsResult = [{ id: DEMO_LEAD_ID, display_name: "Rodda Electric, Inc." }];
  close.leadStatus.set(DEMO_LEAD_ID, "Sent Line Card");
  close.sentWithOpens = [
    { id: "e1", status: "sent", direction: "outgoing", subject: "Westgate Supply line card", date_sent: "2026-10-15T17:00:00Z", opens: [{ opened_at: "2026-10-15T17:05:00Z", opened_by: null }, { opened_at: "2026-10-15T17:40:00Z", opened_by: null }], to: ["renee@roddaelectric.com"], attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }] },
    { id: "e2", status: "inbox", direction: "incoming", subject: "Re: line card", date_sent: "2026-10-15T17:50:00Z", opens: null },
  ];
  const origFind = close.findLeads.bind(close);
  close.findLeads = (async (q: string) => (/rodda/i.test(q) ? origFind(q) : [])) as never;

  const r = await guestFollowUps(d, guest);
  assert.deepEqual(r.rows.map((x) => x.company), ["Rodda Electric, Inc.", "Nobody Home LLC"], "only who they called, line cards first");
  const rodda = r.rows[0];
  assert.deepEqual([rodda.status, rodda.opens, rodda.lastOpenAt, rodda.repliedAt, rodda.lineCardTo, rodda.rfq], ["Sent Line Card", 2, "2026-10-15T17:40:00Z", "2026-10-15T17:50:00Z", "renee@roddaelectric.com", false]);
  assert.equal(r.rows[1].inClose, false);
  assert.ok(!close.writes.some((w) => w.op !== "note"), "reading only: nothing changed in Close");

  // Cached per company: a status change shows after ten minutes, or at once with fresh.
  close.leadStatus.set(DEMO_LEAD_ID, "RFQ Received");
  assert.equal((await guestFollowUps(d, guest)).rows[0].status, "Sent Line Card");
  const f = await guestFollowUps(d, guest, { fresh: true });
  assert.equal(f.rows.find((x) => x.company.startsWith("Rodda"))!.rfq, true);
  assert.equal(f.rows[0].company, "Nobody Home LLC", "an RFQ that's in goes to the bottom: Walt has it");
});

test("the guest's own email (10/16): saved once on the link, CC'd on every line card they send", async () => {
  const { setGuestCc } = await import("../src/guests.js");
  const { mailDns } = await import("../src/linecard.js");
  mailDns.resolveMx = (async () => [{ exchange: "mx.example.com", priority: 10 }]) as never;
  const repId = "user_guestCc";
  const close = new FakeClose();
  const d: Deps = { close, llm: demoLlm, rep: rep(repId) };
  const { guest } = await createGuest(repId, "Ulysses");
  await assert.rejects(setGuestCc(repId, guest.id, "not an email"), /doesn't look like an email/);
  assert.deepEqual(await setGuestCc(repId, guest.id, " Ulysses@Gmail.com "), { ccEmail: "ulysses@gmail.com" });
  assert.equal(guestView((await listGuests(repId)).find((x) => x.id === guest.id)!).ccEmail, "ulysses@gmail.com", "the page shows it back, so it stays");
  await guestSend(d, guest, { company: "Brand New Fab LLC", name: "Dana", email: "dana@brandnewfab.com" });
  const email = close.writes.filter((w) => w.op === "email").pop()!.body as { to: string[]; cc?: string[] };
  assert.deepEqual([email.to, email.cc], [["dana@brandnewfab.com"], ["ulysses@gmail.com"]]);
  // Cleared: no CC.
  await setGuestCc(repId, guest.id, "");
  await guestSend(d, guest, { company: "Brand New Fab LLC", name: "Dana", email: "dana@brandnewfab.com" });
  assert.deepEqual((close.writes.filter((w) => w.op === "email").pop()!.body as { cc?: string[] }).cc ?? [], []);
});

test("a Close export uploads (10/21): rows with a company and no phone get the phone, buyer, city and state from Close", async () => {
  const { fillFromClose, putList, createGuest: make } = await import("../src/guests.js");
  const close = new FakeClose();
  close.ownedLeads = [{ id: "lead_s", display_name: "Synergy Fabrication Inc", url: "https://synergyfabtx.com", description: "Synergy Fabrication Inc is a custom manufacturer based in Fort Worth, Texas, specializing in pressure vessels. Founded 2014.",
    addresses: [{ city: "Fort Worth", state: "TX" }], contacts: [{ name: "Main Office", phones: [{ phone: "+16828410097" }] }, { name: "Dana Ruiz", title: "Purchasing Manager", emails: [{ email: "dana@synergyfabtx.com" }] }] }];
  const d: Deps = { close, llm: demoLlm, rep: rep("user_fill") };
  const rows: Array<Record<string, unknown>> = [
    { company: "Synergy Fabrication Inc", website: "https://synergyfabtx.com", what: "x".repeat(500) },
    { company: "Nowhere Co", website: "https://nowhere.example" },
    { company: "Has A Phone LLC", phone: "(555) 555-0100", state: "CA" },
  ];
  const r = await fillFromClose(d, rows);
  assert.deepEqual([r.filled, r.notFound], [1, 1]);
  assert.deepEqual([rows[0].phone, rows[0].askFor, rows[0].city, rows[0].state, rows[0].email], ["(682) 841-0097", "Dana Ruiz (Purchasing Manager)", "Fort Worth", "TX", "dana@synergyfabtx.com"]);
  assert.match(String(rows[0].what), /^Synergy Fabrication Inc is a custom manufacturer/);
  assert.equal(rows[2].phone, "(555) 555-0100", "a row with a phone is left alone");
  const { guest } = await make("user_fill", "Liam");
  const list = await putList("user_fill", guest, { rows: r.rows });
  assert.deepEqual(list.leads.map((l) => l.company), ["Synergy Fabrication Inc", "Has A Phone LLC"], "no phone anywhere: left out");
  assert.ok(!close.writes.length, "reading only");
});
