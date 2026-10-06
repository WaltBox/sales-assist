import assert from "node:assert/strict";
import { test } from "node:test";
import { FOUND_TAG, markRescue, nextStep, prepareRescue, shortTask } from "../src/accounts.js";
import { store } from "../src/store.js";
import type { Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";

const NOW = new Date("2026-09-26T18:00:00Z");
const tz = "America/Los_Angeles";
// The demo line cards are dated "N days ago" from here: a Wednesday, 10am Pacific, so the suite reads the same at any hour.
const WED = new Date("2026-10-07T17:00:00Z");
const base = { cardSentAt: "2026-09-23T16:00:00Z", lastOut: "2026-09-23T16:00:00Z", lastIn: null, rfqPromised: false, tasks: [], now: NOW, tz };

test("accounts: the next step reads the calls and tasks, not just the emails", () => {
  // They replied last: answer them, whatever else is going on.
  assert.equal(nextStep({ ...base, seen: "replied", lastIn: "2026-09-24T16:00:00Z" }).kind, "reply");
  // DelHur (9/25): opened, no RFQs right now, a check-in on Oct 15. That's a hold, not a bump.
  const hold = nextStep({ ...base, seen: "opened", lastOut: "2026-09-10T16:00:00Z", tasks: [{ text: "[B] Check in with Michael (Purchasing) at DelHur Industries, Inc. — 555", date: "2026-10-15T17:00:00Z" }], company: "DelHur Industries, Inc." });
  assert.equal(hold.kind, "scheduled");
  assert.equal(hold.label, "Check in with Michael (Purchasing)");
  assert.equal(hold.tag, "Call · Oct 15");
  // SBI (9/26): Tammy never opened the line card. Even with a task Monday, it's a rescue call first.
  const tammy = nextStep({ ...base, seen: "not_opened", who: "Tammy", tasks: [{ text: "[A] Try Tammy Kafton, Purchasing Manager again at SBI MFG", date: "2026-09-28T14:30:00Z" }], company: "SBI MFG" });
  assert.equal(tammy.kind, "rescue");
  assert.equal(tammy.rescue, true);
  assert.equal(tammy.label, "Get the line card in front of Tammy");
  assert.equal(tammy.tag, "Call");
  assert.match(tammy.detail, /also a task open for Sep 28/);
  // Sent again on a call yesterday, not marked either way: give them a moment.
  assert.equal(nextStep({ ...base, seen: "not_opened", who: "Tammy", lastOut: "2026-09-25T18:00:00Z" }).kind, "waiting");
  // Walt 9/28: talked to them or emailed them since the line card: off the list for a week, then back if still unseen.
  const talked = nextStep({ ...base, seen: "not_opened", who: "Bud", lastTalk: "2026-09-25T17:00:00Z" });
  assert.equal(talked.kind, "waiting");
  assert.equal(talked.label, "Bud finding it · talked Sep 25");
  assert.equal(talked.due, "2026-10-02T17:00:00.000Z");
  assert.equal(nextStep({ ...base, seen: "not_opened", who: "Carlos", lastOut: "2026-09-24T16:00:00Z" }).label, "Carlos finding it · emailed Sep 24");
  // A week on, still not opened and no RFQ: it's a rescue call again.
  const later = { ...base, now: new Date("2026-10-03T18:00:00Z") };
  assert.equal(nextStep({ ...later, seen: "not_opened", who: "Bud", lastTalk: "2026-09-25T17:00:00Z" }).kind, "rescue");
  // A voicemail or a call before the line card went out doesn't count.
  assert.equal(nextStep({ ...base, seen: "not_opened", lastTalk: null }).kind, "rescue");
  assert.equal(nextStep({ ...base, seen: "not_opened", lastTalk: "2026-09-22T17:00:00Z" }).kind, "rescue");
  // They couldn't find it: back to a call, and check the address.
  assert.match(nextStep({ ...base, seen: "not_opened", who: "Tammy", lastOut: "2026-09-25T18:00:00Z", notFound: true, markedAt: "2026-09-25T18:05:00Z" }).label, /^Get a working email for Tammy$/);
  // A callback due today on an account that has seen it: just the callback.
  const due = nextStep({ ...base, seen: "opened", lastOut: "2026-09-24T16:00:00Z", tasks: [{ text: "[A] Call Diane Townsend (Purchasing Manager) at Almet, Inc.", date: "2026-09-26T16:00:00Z" }], company: "Almet, Inc." });
  assert.equal(due.kind, "call_due");
  // Not opened, nothing scheduled: a rescue call. Too soon: give it a day.
  assert.equal(nextStep({ ...base, seen: "not_opened" }).kind, "rescue");
  assert.equal(nextStep({ ...base, seen: "not_opened", cardSentAt: "2026-09-26T15:00:00Z", lastOut: "2026-09-26T15:00:00Z" }).kind, "waiting");
  // Opened, a week of quiet: bump. If they promised an RFQ, the bump is about that.
  assert.equal(nextStep({ ...base, seen: "opened", lastOut: "2026-09-18T16:00:00Z" }).kind, "bump");
  assert.match(nextStep({ ...base, seen: "opened", lastOut: "2026-09-18T16:00:00Z", rfqPromised: true }).label, /^Get the RFQ they promised$/);
  // Josipa (9/26): has your email, promised an RFQ, callback due. Email her, don't call a fourth time.
  const josipa = nextStep({ ...base, seen: "confirmed", who: "Josipa", rfqPromised: true, lastOut: "2026-09-25T17:07:00Z", tasks: [{ text: "[A] Call Josipa Kristo at South Shore Controls, Inc.", date: "2026-09-24T18:50:00Z" }] });
  assert.equal(josipa.kind, "bump");
  assert.equal(josipa.label, "Get the RFQ Josipa promised");
  assert.equal(josipa.tag, "Email");
  // AqueoUS (9/26): Matt sent "Westgate pricing check.xlsx". The old "nudge Matt for his list" task doesn't apply: quote it.
  const matt = nextStep({ ...base, seen: "replied", who: "Matt", lastIn: "2026-09-23T19:07:00Z", lastOut: "2026-09-23T19:13:00Z",
    rfq: { at: "2026-09-23T19:07:00Z", files: ["Westgate pricing check.xlsx"], quotedAt: null },
    tasks: [{ text: "[A] Nudge Matt Michon if his Henry Pratt / PRV valve list hasn't arrived", date: "2026-09-26T16:00:00Z" }] });
  assert.equal(matt.kind, "quote");
  assert.equal(matt.label, "Price Matt's RFQ");
  assert.equal(matt.tag, "Quote");
  assert.match(matt.detail, /Westgate pricing check\.xlsx on Sep 23/);
  // Quoted and quiet for 3 days: follow up on the quote.
  assert.equal(nextStep({ ...base, seen: "replied", lastOut: "2026-09-22T16:00:00Z", rfq: { at: "2026-09-21T16:00:00Z", files: ["rfq.pdf"], quotedAt: "2026-09-22T16:00:00Z" } }).label, "Hear back on the quote");
  // CIBS (9/24): their mail server blocked the line card. That's a call for another address, not an RFQ.
  const cibs = nextStep({ ...base, seen: "bounced", who: "Matt", bounced: "blocked", toAddr: "m.mendez@champion-building.com" });
  assert.equal(cibs.label, "Get past Matt's mail filter");
  assert.match(cibs.detail, /allow westgatesupply\.com/);
  // They said on a call they have it: not a rescue.
  assert.notEqual(nextStep({ ...base, seen: "confirmed" }).kind, "rescue");
});

test("bounce notices aren't replies or RFQs", async () => {
  const { isBounce } = await import("../src/accounts.js");
  const { realAttachments } = await import("../src/stats.js");
  assert.ok(isBounce({ subject: "Delivery Status Notification (Failure)" }));
  assert.ok(isBounce({ subject: "Undeliverable: Westgate Supply – line card" }));
  assert.ok(!isBounce({ subject: "RE: Call Follow Up: Westgate Supply", sender: "Matt <mmichon@aqueousvets.com>" }));
  assert.deepEqual(realAttachments([{ filename: "icon.png", content_type: "image/png" }, { filename: "file", content_type: "text/rfc822-headers" }]), []);
  assert.deepEqual(realAttachments([{ filename: "image001.png", content_type: "image/png" }, { filename: "Westgate pricing check.xlsx", content_type: "application/vnd.ms-excel" }]), ["Westgate pricing check.xlsx"]);
});

test("tasks read as goals", async () => {
  const { taskGoal } = await import("../src/accounts.js");
  assert.equal(taskGoal("[A] Call whoever handles purchasing at Hefco Enterprises Inc.", "Hefco Enterprises Inc.", "Hefco Enterprises"), "Find who buys at Hefco Enterprises");
  assert.equal(taskGoal("[A] Call Josipa Kristo at South Shore Controls, Inc.", "South Shore Controls, Inc.", "South Shore Controls"), "Reach Josipa Kristo");
  assert.equal(taskGoal("[B] Try Tammy Kafton, Purchasing Manager again at SBI MFG", "SBI MFG", "SBI MFG"), "Reach Tammy Kafton, Purchasing Manager");
  assert.equal(taskGoal("[B] Check in with Michael (Purchasing) at DelHur Industries, Inc.", "DelHur Industries, Inc.", "DelHur Industries"), "Check in with Michael (Purchasing)");
});

test("task titles come out short: no company, no briefing, initials kept", () => {
  assert.equal(shortTask("[A] Call Diane Townsend (Purchasing Manager) at Almet, Inc. — 555-1212", "Almet, Inc."), "Call Diane Townsend (Purchasing Manager)");
  assert.equal(shortTask("[B] Call H.C. (Clifford) Province at Tryer Process Equipment", "Tryer Process Equipment"), "Call H.C. (Clifford) Province");
  assert.equal(shortTask("[B] Call Chemtec purchasing (936-856-1704), ask for Brianne by name.", "Chemtec Energy"), "Call Chemtec purchasing");
});

test("rescue: the email is drafted in Close ahead of the call, a reply in the line card's thread; the app never sends it", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  close.sentWithOpens = [{
    id: "acti_card1", status: "sent", direction: "outgoing", subject: "Westgate Supply – line card", date_sent: "2026-09-23T16:00:00Z",
    opens: [], to: ["Rob Roy <rob@roddaelectric.com>"], thread_id: "thread_1", contact_id: "cont_rob",
    attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }],
  } as never];
  const d: Deps = { close, llm: demoLlm, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: tz, sender: "Walt <walt@westgatesupply.com>", emailAccountId: "emailacct_demo" } };
  const r = await prepareRescue(d, DEMO_LEAD_ID);
  const draft = close.writes.find((w) => w.op === "email")!.body as Record<string, unknown>;
  assert.equal(draft.inReplyToId, "acti_card1", "same thread as the line card");
  assert.equal(draft.threadId, "thread_1");
  assert.equal(draft.scheduleAt ?? null, null, "a draft, not scheduled");
  assert.equal(r.subject, "Re: Westgate Supply – line card");
  assert.equal(r.attachedLineCard, false, "no attachment: the card is in the email right under it");
  assert.equal(r.body, "Hi Rob!\n\nJust bumping this back to the top of your inbox. The line card is in my email below.\n\nMind replying \"got it\" so I know it came through?\n\nWalt Boxwell");
  assert.doesNotMatch(r.body, /[—–]/);

  // "Found it" goes into Close as a note the accounts page reads back.
  await markRescue(d, DEMO_LEAD_ID, true, "Rob Roy");
  const note = close.writes.filter((w) => w.op === "note").pop()!.body as { note: string };
  assert.ok(note.note.startsWith(`${FOUND_TAG} Rob Roy found the line card email`));
});

test("rescue drafts are made for every unopened account, once each", async () => {
  const { ensureRescueDrafts, accountsBoard } = await import("../src/accounts.js");
  const { demoLineCards } = await import("../src/demo.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close, WED); // Harbor and Mesa never opened it (Valley's went out yesterday: not two days in a row, 9/30)
  const d: Deps = { close, llm: demoLlm, now: () => WED, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: tz } };
  assert.equal((await ensureRescueDrafts(d)).made, 2);
  assert.equal((await ensureRescueDrafts(d)).made, 0, "not drafted twice");
  const board = await accountsBoard(d, { fresh: true });
  for (const name of ["Harbor Fabrication", "Mesa Pipe & Supply"]) assert.ok(board.accounts.find((a) => a.company === name)!.rescueDraft, `${name}: draft ready`);
  assert.ok(!close.writes.some((w) => w.op === "send"), "nothing sent");

  // On the call, the side panel shows it with a Send button: that draft only, once, only this rep's.
  const { rescueFor, sendRescue } = await import("../src/accounts.js");
  const harbor = board.accounts.find((a) => a.company === "Harbor Fabrication")!;
  const { draft } = await rescueFor(d, harbor.leadId);
  assert.ok(draft);
  assert.match(draft!.body, /^Hi Dana!/);
  await assert.rejects(sendRescue(d, "lead_someOtherLead000001", draft!.id), /Can't find/);
  await assert.rejects(sendRescue({ ...d, rep: { ...d.rep, closeUserId: "user_someoneElse" } }, harbor.leadId, draft!.id), /Can't find/);
  assert.deepEqual(await sendRescue(d, harbor.leadId, draft!.id), { sent: true, to: "Dana Ruiz <dana@harborfab.test>" });
  await assert.rejects(sendRescue(d, harbor.leadId, draft!.id), /isn't a draft anymore/, "a second click doesn't send twice");
  assert.equal(close.writes.filter((w) => w.op === "send").length, 1);
  assert.equal((await rescueFor(d, harbor.leadId)).draft, null, "sent: nothing waiting anymore");
});

test("ticking \"They got it\" on the call saves a [Got it] note, so the account reads as confirmed (9/29)", async () => {
  const { accountsBoard } = await import("../src/accounts.js");
  const { demoLineCards } = await import("../src/demo.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close, WED); // Harbor never opened it
  const d: Deps = { close, llm: demoLlm, now: () => WED, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: tz } };
  const before = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Harbor Fabrication")!;
  assert.equal(before.seen, "not_opened");
  const r = await markRescue(d, "lead_demoHarborFab000001", true, "Dana", "call");
  assert.match(r.note, /^\[Got it\] Dana confirmed on the call .* that the line card email came through \(not in spam\)\. OK to send RFQ check-ins\.$/);
  const after = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Harbor Fabrication")!;
  assert.equal(after.seen, "confirmed");
  assert.notEqual(after.next.kind, "rescue", "no spam rescue once they've said they got it");
});

test("RFQ status: who it's waiting on, from the emails, unless a newer [RFQ status] note says otherwise (9/29)", async () => {
  const { rfqStatus } = await import("../src/accounts.js");
  const r = { at: "2026-09-23T15:00:00Z", files: ["Westgate pricing check.xlsx"], quotedAt: null as string | null };
  assert.deepEqual([rfqStatus(r, null, []).stage, rfqStatus(r, null, []).waitingOn], ["With pricing", "westgate"]);
  const po = rfqStatus({ ...r, files: ["Purchase Order PO010763.pdf"], quotedAt: "2026-09-28T21:17:00Z" }, null, []);
  assert.equal(po.stage, "Order in");
  const quoted = { ...r, quotedAt: "2026-09-25T15:00:00Z" };
  assert.deepEqual([rfqStatus(quoted, null, []).stage, rfqStatus(quoted, null, []).waitingOn], ["Quote sent", "buyer"]);
  assert.deepEqual([rfqStatus(quoted, "2026-09-26T15:00:00Z", []).stage, rfqStatus(quoted, "2026-09-26T15:00:00Z", []).waitingOn], ["Buyer answered", "you"]);
  // The rep's update: "Berni's pricing it".
  const mark = [{ note: "[RFQ status] With pricing · Berni has it, back Thu", date_created: "2026-09-24T15:00:00Z" }];
  const m = rfqStatus(r, null, mark);
  assert.deepEqual([m.stage, m.waitingOn, m.note, m.manual], ["With pricing", "westgate", "Berni has it, back Thu", true]);
  // A quote going out after that update moves it on by itself.
  assert.equal(rfqStatus(quoted, null, mark).stage, "Quote sent");
});

test("board sections: money, people waiting, promised times, hot, chasing; your own test leads hidden (9/29)", async () => {
  const { sectionOf, isOwnLead } = await import("../src/accounts.js");
  const base = { seen: "opened" as const, opens: { person: 1, maybe: 0, filter: 0, last: null, app: null }, rfq: null };
  const next = (kind: string, tag = "Call") => ({ kind, tag, label: "", detail: "", due: null, rescue: false }) as never;
  const rfq = { at: "2026-09-23T15:00:00Z", files: ["pricing.xlsx"], quotedAt: null, status: {} as never };
  assert.equal(sectionOf({ ...base, rfq, next: next("quote") }), "rfq", "an RFQ leaves the action list for the RFQs page");
  assert.equal(sectionOf({ ...base, rfq, next: next("reply") }), "rfq");
  assert.equal(sectionOf({ ...base, next: next("reply") }), "answer");
  assert.equal(sectionOf({ ...base, next: next("call_due") }), "callback");
  assert.equal(sectionOf({ ...base, next: next("rescue") }), "seen");
  assert.equal(sectionOf({ ...base, opens: { ...base.opens, person: 3 }, next: next("waiting", "Wait") }), "hot", "Mercer, opened 3×");
  assert.equal(sectionOf({ ...base, opens: { ...base.opens, person: 6 }, next: next("scheduled") }), "later", "Steel West: the callback they asked for (Oct 15) wins");
  assert.equal(sectionOf({ ...base, next: next("bump", "Email") }), "followup");
  assert.equal(sectionOf({ ...base, next: next("bump", "Email · auto") }), "later", "the automatic email has it");
  assert.equal(sectionOf({ ...base, next: next("waiting", "Wait") }), "later");
  // Reached out today: out of the way until tomorrow, but their reply still needs you (9/29).
  assert.equal(sectionOf({ ...base, touchedToday: "2026-09-29T17:00:00Z", next: next("call_due") }), "today");
  assert.equal(sectionOf({ ...base, touchedToday: "2026-09-29T17:00:00Z", opens: { ...base.opens, person: 5 }, next: next("waiting", "Wait") }), "today");
  assert.equal(sectionOf({ ...base, touchedToday: "2026-09-29T17:00:00Z", next: next("reply") }), "answer");
  // Reached or emailed on the last business day: rests today, not two days in a row (9/30). Their reply still needs you.
  assert.equal(sectionOf({ ...base, touchedLastDay: "2026-09-29T17:00:00Z", next: next("call_due") }), "rest");
  assert.equal(sectionOf({ ...base, touchedLastDay: "2026-09-29T17:00:00Z", next: next("reply") }), "answer");
  assert.equal(isOwnLead({ company: "Test Lead Fabrication, Inc.", contact: { name: "Walt Boxwell", email: null, phone: null } }), true);
  assert.equal(isOwnLead({ company: "Acme", contact: { name: "Walt", email: "walt@westgatesupply.com", phone: null } }), true);
  assert.equal(isOwnLead({ company: "Top Coat Fabrication", contact: { name: "Kelsey", email: "kelsey@topcoat.com", phone: null } }), false);

  // An RFQ that came in as their reply is a quote to price, not "Answer Mayra" (VGas).
  const n = nextStep({ seen: "replied", cardSentAt: "2026-09-20T15:00:00Z", lastOut: "2026-09-25T15:00:00Z", lastIn: "2026-09-29T15:00:00Z", rfqPromised: false, tasks: [], now: new Date("2026-09-29T18:00:00Z"), tz, who: "Mayra",
    rfq: { at: "2026-09-29T15:00:00Z", files: ["materials.pdf"], quotedAt: null } });
  assert.equal(n.kind, "quote");
  assert.equal(n.label, "Price Mayra's RFQ");
});

test("an RFQ typed into the email counts, and a teammate looped in means it's with pricing (Josipa, 9/25–9/28)", async () => {
  const { rfqInBody, rfqStatus } = await import("../src/accounts.js");
  const josipa = "Hi, I think this will me an idea of how much the cost difference is. I am not sure that I like your website, I am sorry. Do you have a line card I can have?\n\nItem Description Ordered\nWELDNUT OFFSET 1/4-20 18-8SS 100\n\nOn Wed, Sep 24, 2026 at 11:25 AM Walt Boxwell wrote:\n> Hi Josipa";
  assert.equal(rfqInBody("RE: Westgate Supply – line card", josipa), true);
  assert.equal(rfqInBody("Re: line card", "Please quote the attached"), true);
  assert.equal(rfqInBody("RFQ 26-0100", "Hello Jacob, see below."), true, "a new RFQ email");
  assert.equal(rfqInBody("Re: Westgate Supply – line card", "Thanks for sending that over. I'll be sure to reach out when we have a materials list or RFQ."), false, "a mention, not an ask (Metal Rise)");
  assert.equal(rfqInBody("26-0100 Bolting & Gaskets.", "Hi Walt, can you please also quote the following"), true, "Mayra's second ask");
  assert.equal(rfqInBody("RE: 26-407 Equipment, RFQ, WG", "You too! Thank you"), false, "a thank-you on the RFQ thread isn't a new RFQ");
  assert.equal(rfqInBody("Re: line card", "Got it, thanks! I'll send something when a project comes up."), false);
  // Only their own words count, not the part list quoted from an older email.
  assert.equal(rfqInBody("Re: quote", "Thanks!\n\nOn Mon, Sep 28, 2026 at 1:00 PM Walt wrote:\n> Item Description Qty"), false);
  const s = rfqStatus({ at: "2026-09-25T17:02:00Z", files: ["Items listed in the email"], quotedAt: null }, null, [], { at: "2026-09-28T20:02:00Z", who: "Jacob" });
  assert.deepEqual([s.stage, s.waitingOn, s.note], ["With pricing", "westgate", "Jacob has it"]);
});

test("\"got it\" once per day, clears this week's calls, and a far-off check-in doesn't block the automatic emails (Hefco, 9/29)", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  const now = new Date("2026-09-29T17:00:00Z");
  const d: Deps = { close, llm: demoLlm, now: () => now, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: tz } };
  close.extraTasks.push(
    { id: "task_soon", lead_id: "lead_hefco", assigned_to: DEMO_USER_ID, text: "Call whoever handles purchasing", date: "2026-09-25T19:00:00Z", is_complete: false },
    { id: "task_nov", lead_id: "lead_hefco", assigned_to: DEMO_USER_ID, text: "Check in with Damon", date: "2026-11-12T16:00:00Z", is_complete: false },
    { id: "task_other", lead_id: "lead_other", assigned_to: DEMO_USER_ID, text: "Call someone else", date: "2026-09-29T19:00:00Z", is_complete: false },
  );
  const r = await markRescue(d, "lead_hefco", true, "Damon", "call");
  assert.equal(r.completedTasks, 1);
  assert.deepEqual(close.writes.filter((w) => w.op === "task-complete").map((w) => (w.body as { taskId: string }).taskId), ["task_soon"]);
  // A second tick the same day: no second note.
  close.notes = (async () => [{ id: "note_1", note: r.note, date_created: "2026-09-29T16:40:00Z" }]) as never;
  const again = await markRescue(d, "lead_hefco", true, "Damon", "call");
  assert.equal(again.saved, false);
  assert.equal(close.writes.filter((w) => w.op === "note").length, 1);
  // Confirmed with only the Nov 12 check-in left: the email path, not "Call · Nov 12".
  const next = nextStep({ seen: "confirmed", cardSentAt: "2026-09-24T16:11:00Z", lastOut: "2026-09-24T16:11:00Z", lastIn: null, rfqPromised: false,
    tasks: [{ text: "Check in with Damon", date: "2026-11-12T16:00:00Z" }], now, tz, who: "Damon", autoOn: true });
  assert.notEqual(next.kind, "scheduled");
});

test("\"RFQ came in\": an [RFQ received] note puts the account on the RFQs page and clears this week's chase calls (Mitchell Concrete, 9/29)", async () => {
  const { markRfqReceived, accountsBoard } = await import("../src/accounts.js");
  const { demoLineCards } = await import("../src/demo.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close, WED);
  const d: Deps = { close, llm: demoLlm, now: () => WED, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: tz } };
  close.extraTasks.push({ id: "task_chase", lead_id: "lead_demoHarborFab000001", assigned_to: DEMO_USER_ID, text: "Call Dana for the RFQ", date: new Date().toISOString(), is_complete: false });
  const r = await markRfqReceived(d, "lead_demoHarborFab000001", "Materials list, sent to Jacob");
  assert.equal(r.note, "[RFQ received] Materials list, sent to Jacob");
  assert.equal(r.completedTasks, 1);
  // The board reads the note back (FakeClose keeps notes as writes; feed it to the board's note list).
  const noteW = close.writes.find((w) => w.op === "note")!.body as { leadId: string; note: string };
  const origList = close.listSince.bind(close);
  close.listSince = (async (kind: string, q: never) => kind === "note" ? [{ id: "n1", lead_id: noteW.leadId, note: noteW.note, date_created: new Date().toISOString(), user_id: DEMO_USER_ID }] : origList(kind as never, q)) as never;
  const harbor = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Harbor Fabrication")!;
  assert.equal(harbor.section, "rfq");
  assert.deepEqual(harbor.rfq!.files, ["Materials list, sent to Jacob"]);
  assert.equal(harbor.rfq!.status.stage, "With pricing");
});

test("lead status follows the funnel, forward only, never over the rep's own statuses (9/29)", async () => {
  const { advanceStatus, funnelStatusFor } = await import("../src/accounts.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  const d: Deps = { close, llm: demoLlm, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: tz } };
  assert.equal(await advanceStatus(d, DEMO_LEAD_ID, "Sent Line Card", "Called"), "Sent Line Card");
  assert.equal(await advanceStatus(d, DEMO_LEAD_ID, "Sent Line Card", "RFQ Received"), null, "never backwards");
  assert.equal(await advanceStatus(d, DEMO_LEAD_ID, "Sent Line Card", "Qualified"), "Sent Line Card", "Qualified + line card → Sent Line Card (9/30)");
  assert.equal(await advanceStatus(d, DEMO_LEAD_ID, "Quoted", "Customer"), null);
  // "Great fit" on browse: Potential → Good lead, but never over a lead that's already been called.
  assert.equal(await advanceStatus(d, DEMO_LEAD_ID, "Good lead", "Potential"), "Good lead");
  assert.equal(await advanceStatus(d, DEMO_LEAD_ID, "Good lead", "Called"), null);
  assert.equal(await advanceStatus(d, DEMO_LEAD_ID, "Called", "Good lead"), "Called", "and Good lead moves on once it's worked");
  assert.equal(close.writes.filter((w) => w.op === "status").length, 4);
  const rfq = (stage: string) => ({ rfq: { at: "", files: [], quotedAt: null, status: { stage } as never } });
  assert.equal(funnelStatusFor({ rfq: null }), "Sent Line Card");
  assert.equal(funnelStatusFor(rfq("With pricing")), "RFQ Received");
  assert.equal(funnelStatusFor(rfq("Quote sent")), "Quoted");
});

test("our own line card quoted back in their reply isn't their RFQ (Air Tech Cooling, 9/30)", async () => {
  const { theirFiles } = await import("../src/stats.js");
  assert.deepEqual(theirFiles([{ filename: "Westgate_Supply_Line_Card.pdf", content_type: "application/pdf" }, { filename: "image001.png", content_type: "image/png" }]), []);
  assert.deepEqual(theirFiles([{ filename: "WG-Quote-WG-GQYGS7.pdf", content_type: "application/pdf" }]), []);
  assert.deepEqual(theirFiles([{ filename: "Westgate pricing check.xlsx", content_type: "application/vnd.ms-excel" }]), ["Westgate pricing check.xlsx"], "AqueoUS's sheet is theirs");
  assert.deepEqual(theirFiles([{ filename: "Westgate Supply RFQ.xlsx", content_type: "application/vnd.ms-excel" }]), ["Westgate Supply RFQ.xlsx"]);
});

test("a rescue draft greets a real first name only, and carries a meme the company hasn't had (10/2)", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  close.sentWithOpens = [{
    id: "acti_card_rh", status: "sent", direction: "outgoing", subject: "Great talking with you – Westgate Supply line card", date_sent: "2026-09-28T15:43:00Z",
    opens: [], to: ["B. Kelley <bkelley@rhmachinellc.com>"], thread_id: "thread_rh", contact_id: "cont_bk",
    attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }],
  } as never];
  const d: Deps = { close, llm: demoLlm, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: "user_rescue_meme", timeZone: tz, sender: "Walt <walt@westgatesupply.com>", emailAccountId: "emailacct_demo" } };
  const forklift = { name: "forklift.jpg", url: "https://x.supabase.co/storage/v1/object/public/memes/forklift.jpg" };
  const r = await prepareRescue(d, DEMO_LEAD_ID, { meme: forklift });
  assert.ok(r.body.startsWith("Hi there!"), `an initial is not a name: ${r.body.split("\n")[0]}`);
  const draft = close.writes.find((w) => w.op === "email")!.body as { html: string | null };
  assert.ok(r.meme, "a meme was picked");
  assert.match(draft.html ?? "", new RegExp(r.meme!.replace(".", "\\.")), "the meme is inline in the draft");
  const seen = (await store.getSetting<Record<string, string[]>>("user_rescue_meme", "rescueMemes"))!;
  assert.deepEqual(seen[DEMO_LEAD_ID], [r.meme], "remembered, so they never get it twice");
});

test("rescue drafts are never duplicated: a timed-out check keeps the old one, and a draft already in the thread is reused (10/2)", async () => {
  const { ensureRescueDrafts } = await import("../src/accounts.js");
  const { demoLineCards } = await import("../src/demo.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close, WED);
  const userId = "user_rescue_dupes";
  for (const e of close.sentEmails) e.user_id = userId; // demoLineCards writes as the demo user
  for (const t of close.extraTasks) t.assigned_to = userId;
  const d: Deps = { close, llm: demoLlm, now: () => WED, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: userId, timeZone: tz } };
  assert.equal((await ensureRescueDrafts(d)).made, 2);
  const drafts = (await store.getSetting<Record<string, string>>(userId, "rescueDrafts"))!;
  const ids = Object.values(drafts);
  // Close times out while checking the existing drafts: nothing new is written.
  for (const id of ids) close.emailFetchFails.add(id);
  assert.equal((await ensureRescueDrafts(d)).made, 0, "a timeout is not a reason to draft again");
  close.emailFetchFails.clear();
  // Another run (or an earlier store) lost track of the drafts, but they're still waiting in Close: reuse them.
  for (const [leadId, id] of Object.entries(drafts)) {
    close.sentEmails.push({ id, lead_id: leadId, user_id: userId, status: "draft", direction: "outgoing", subject: "Re: Westgate Supply – line card", date_created: new Date().toISOString(), opens: [] } as never);
  }
  await store.putSetting(userId, "rescueDrafts", {});
  assert.equal((await ensureRescueDrafts(d)).made, 0, "the waiting drafts are reused, not duplicated");
  assert.deepEqual(await store.getSetting(userId, "rescueDrafts"), drafts, "and tracked again");
});

test("gaps between emails count business days, by date, and follow the account's cadence (Walt 10/5)", () => {
  const fri = "2026-10-02T16:20:00Z"; // Friday 9:20am Pacific, when the 10/2 batch went out
  const seenIt = { cardSentAt: "2026-09-28T16:00:00Z", lastOut: fri, lastIn: null, rfqPromised: false, tasks: [], tz, seen: "opened" as const, who: "Dana" };
  const at = (iso: string, gap?: number) => nextStep({ ...seenIt, now: new Date(iso), gap });
  // A 3-day cadence: Monday is one business day later, not three days.
  assert.equal(at("2026-10-05T14:03:00Z", 3).kind, "waiting");
  assert.equal(at("2026-10-05T14:03:00Z", 3).label, "Dana has it · bump Oct 7");
  assert.equal(at("2026-10-05T14:03:00Z", 3).due, "2026-10-07T14:00:00.000Z", "due early that morning, so the page shows that day");
  assert.equal(at("2026-10-06T23:00:00Z", 3).kind, "waiting");
  assert.equal(at("2026-10-07T14:03:00Z", 3).kind, "bump", "Wednesday, at the 7am run");
  // 5 days is Friday, 7 days is the Tuesday after.
  assert.equal(at("2026-10-08T23:00:00Z", 5).kind, "waiting");
  assert.equal(at("2026-10-09T14:03:00Z", 5).kind, "bump");
  assert.equal(at("2026-10-12T14:03:00Z", 7).kind, "waiting");
  assert.equal(at("2026-10-13T14:03:00Z", 7).kind, "bump");
  // No cadence of its own: the standard, two business days (10/5). Friday's email is due Tuesday, at the 7am run,
  // even though it went out at 9:20 (counting 24-hour blocks it would slip a day).
  assert.equal(at("2026-10-05T14:03:00Z").label, "Dana has it · bump Oct 6");
  assert.match(at("2026-10-05T14:03:00Z").detail, /2 business days after your last email/);
  assert.equal(at("2026-10-05T14:03:00Z").kind, "waiting");
  assert.equal(at("2026-10-06T14:03:00Z").kind, "bump");
  // They replied and you answered: same gaps.
  assert.equal(nextStep({ ...seenIt, seen: "replied", now: new Date("2026-10-07T14:03:00Z"), gap: 3 }).kind, "bump");
  assert.equal(nextStep({ ...seenIt, seen: "replied", now: new Date("2026-10-06T14:03:00Z"), gap: 3 }).label, "Dana replied · bump Oct 7");

  // A quote: follow up after 3 business days. Quoted Friday is Wednesday, not Monday.
  const quoted = (iso: string) => nextStep({ ...seenIt, seen: "replied", now: new Date(iso), rfq: { at: "2026-10-01T16:00:00Z", files: ["rfq.pdf"], quotedAt: fri } });
  assert.equal(quoted("2026-10-05T18:00:00Z").label, "Quote out · follow up Oct 7");
  assert.equal(quoted("2026-10-07T14:03:00Z").label, "Hear back on the quote");
  // A promised RFQ: the ask goes after 3 business days too.
  const promised = (iso: string) => nextStep({ ...seenIt, seen: "confirmed", rfqPromised: true, now: new Date(iso) });
  assert.equal(promised("2026-10-05T18:00:00Z").label, "Dana owes an RFQ · email Oct 7");
  assert.equal(promised("2026-10-07T14:03:00Z").label, "Get the RFQ Dana promised");
  // Not opened: a rescue call after 2 business days. Sent Friday is Tuesday, not Sunday.
  const unopened = (iso: string) => nextStep({ ...seenIt, cardSentAt: fri, seen: "not_opened", now: new Date(iso) });
  assert.equal(unopened("2026-10-05T18:00:00Z").label, "Let the line card land · Oct 6");
  assert.equal(unopened("2026-10-06T14:03:00Z").kind, "rescue");
});

test("shot down (Walt 10/5): Not Interested in Close with a note, callbacks cleared, off the board; undo puts the status back", async () => {
  const { accountsBoard, markNotInterested, undoNotInterested, NOT_INTERESTED_TAG } = await import("../src/accounts.js");
  const { demoLineCards } = await import("../src/demo.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close, WED);
  const userId = "user_shot_down";
  for (const e of close.sentEmails) e.user_id = userId;
  for (const t of close.extraTasks) t.assigned_to = userId;
  const d: Deps = { close, llm: demoLlm, now: () => WED, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: userId, timeZone: tz } };
  const mesa = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Mesa Pipe & Supply")!; // has a callback open
  await new Promise((r) => setTimeout(r, 30)); // let the board's background status sync finish first

  const r = await markNotInterested(d, mesa.leadId, "Buys everything through a sister company");
  assert.equal(r.status, "Not Interested");
  assert.equal(r.completedTasks, 1, "its open callback is marked done");
  assert.ok(close.writes.some((w) => w.op === "note" && (w.body as { note: string }).note === `${NOT_INTERESTED_TAG} Buys everything through a sister company`));
  assert.equal((await close.lead(mesa.leadId)).status_label, "Not Interested");
  const board = await accountsBoard(d);
  assert.ok(!board.accounts.some((a) => a.leadId === mesa.leadId), "off the board, so no calls and no automatic emails");
  assert.ok(board.accounts.some((a) => a.company === "Crest Mechanical"), "everyone else stays");
  // A second tap changes nothing in Close.
  const statusWrites = close.writes.filter((w) => w.op === "status").length;
  assert.equal((await markNotInterested(d, mesa.leadId, null)).prevStatus, null);
  assert.equal(close.writes.filter((w) => w.op === "status").length, statusWrites);

  // Tapped by mistake: back to where it was, and back on the board.
  await assert.rejects(undoNotInterested(d, mesa.leadId, null), /which status/);
  assert.equal((await undoNotInterested(d, mesa.leadId, r.prevStatus)).status, r.prevStatus);
  assert.ok((await accountsBoard(d)).accounts.some((a) => a.leadId === mesa.leadId));
  await assert.rejects(undoNotInterested(d, mesa.leadId, r.prevStatus), /already/);
});

test("stop statuses: only the rep's \"no\" statuses take an account out", async () => {
  const { isOutStatus } = await import("../src/rules.js");
  for (const s of ["Not Interested", "not interested ", "Bad Fit", "Disqualified"]) assert.ok(isOutStatus(s), s);
  for (const s of ["Sent Line Card", "Qualified", "Customer", "Quoted", null, undefined, ""]) assert.ok(!isOutStatus(s), String(s));
});

test("bumpDue (10/5): the two-day cadence runs even with a callback on the books; not for the unopened, the replied-to, or an RFQ", async () => {
  const { buildAccount } = await import("../src/accounts.js");
  const { roddaLead } = await import("../src/fixtures.js");
  const now = new Date("2026-10-06T14:03:00Z"); // Tue 7:03am Pacific
  const d: Deps = { close: new FakeClose(), llm: demoLlm, now: () => now, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: tz } };
  const lead = roddaLead({ contacts: [{ id: "cont_renee", name: "Renee Alvarez", title: "Purchasing", emails: [{ email: "renee@roddaelectric.com", type: "office" }], phones: [] }] });
  const to = "renee@roddaelectric.com";
  const card = (over: Partial<{ opens: unknown[] }> = {}) => ({
    id: "em_card", user_id: DEMO_USER_ID, lead_id: lead.id, status: "sent", direction: "outgoing", subject: "Westgate Supply – line card", date_sent: "2026-10-02T16:20:00Z", date_created: "2026-10-02T16:20:00Z",
    to: [to], sender: "Walt <walt@westgatesupply.com>", attachments: [{ filename: "Westgate Supply Line Card.pdf", size: 1 }], thread_id: "th1", contact_id: lead.contacts[0].id,
    opens: [{ opened_at: "2026-10-02T18:00:00Z", opened_by: to, user_agent: "Mozilla/5.0 Outlook" }], ...over,
  });
  const build = (emails: unknown[], tasks: Array<{ text: string; date: string }> = []) => buildAccount({
    d, now, card: card() as never, lead, ours: (w: string | null | undefined) => !w || /westgatesupply/.test(w), emails: emails as never, notes: [], tasks, calls: [], autos: [], gap: 2,
  } as never);
  // Friday's email, opened, Tuesday morning: due, even with a callback set for the 15th.
  const a = build([card()], [{ text: "Check in with Renee", date: "2026-10-15T16:30:00Z" }]);
  assert.equal(a.next.kind, "scheduled");
  assert.equal(a.bumpDue, true);
  // Monday it wasn't (one business day).
  assert.equal(buildAccount({ d, now: new Date("2026-10-05T14:03:00Z"), card: card() as never, lead, ours: () => true, emails: [card()] as never, notes: [], tasks: [], calls: [], autos: [], gap: 2 } as never).bumpDue, false);
  // Never opened: a rescue call, not another email.
  assert.equal(build([card({ opens: [] })]).bumpDue, false);
  // They wrote back after the last email: answer first.
  const reply = { id: "em_r", lead_id: lead.id, status: "inbox", direction: "incoming", subject: "RE: line card", date_created: "2026-10-05T10:00:00Z", sender: to, to: ["walt@westgatesupply.com"], attachments: [], thread_id: "th1" };
  assert.equal(build([card(), reply]).bumpDue, false);
});
