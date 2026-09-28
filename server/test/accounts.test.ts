import assert from "node:assert/strict";
import { test } from "node:test";
import { FOUND_TAG, markRescue, nextStep, prepareRescue, shortTask } from "../src/accounts.js";
import type { Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";

const NOW = new Date("2026-09-26T18:00:00Z");
const tz = "America/Los_Angeles";
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
  demoLineCards(close); // Harbor and Mesa never opened it
  const d: Deps = { close, llm: demoLlm, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: tz } };
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
