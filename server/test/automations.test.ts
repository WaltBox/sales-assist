import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsBoard } from "../src/accounts.js";
import type { Deps } from "../src/assistant.js";
import { automationsView, morningRun, planBumps, setAutomations, skipAutomation, syncAutomations } from "../src/automations.js";
import { demoLineCards, demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import { sendSlot } from "../src/followup.js";

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles", sender: '"Walt Boxwell" <walt@westgatesupply.com>', emailAccountId: "emailacct_demo" };
const setup = (userId: string) => {
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close); // Crest Mechanical: opened 3×, 9 quiet days → bump
  const d: Deps = { close, llm: demoLlm, rep: { ...rep, closeUserId: userId } };
  // demoLineCards writes as the demo user; rewrite to this test's user
  for (const e of close.sentEmails) e.user_id = userId;
  for (const t of close.extraTasks) t.assigned_to = userId;
  return { close, d };
};

test("bumps go out 9 to 11am their time on weekdays", () => {
  const tz = "America/Chicago";
  assert.equal(sendSlot(tz, new Date("2026-09-28T12:00:00Z")), "2026-09-28T09:00:00-05:00", "Monday 7am → 9am");
  assert.equal(sendSlot(tz, new Date("2026-09-28T14:30:00Z")), "2026-09-28T09:50:00-05:00", "Monday 9:30 → in 20 minutes");
  assert.equal(sendSlot(tz, new Date("2026-09-28T19:00:00Z")), "2026-09-29T09:00:00-05:00", "Monday 2pm → Tuesday 9am");
  assert.equal(sendSlot(tz, new Date("2026-09-26T15:00:00Z")), "2026-09-28T09:00:00-05:00", "Saturday → Monday 9am");
  assert.equal(sendSlot(tz, new Date("2026-09-28T12:00:00Z"), 12), "2026-09-28T09:12:00-05:00", "a batch is spread out");
});

test("off by default; when on, the day's bumps are scheduled in Close with the reason, once per account", async () => {
  const { close, d } = setup("user_auto1");
  assert.equal((await planBumps(d)).planned.length, 0, "off until you turn it on");
  assert.equal(await morningRun(d), null);
  await setAutomations(d, true);
  const r = await planBumps(d);
  assert.equal(r.planned.length, 1);
  const [a] = r.planned;
  assert.equal(a.company, "Crest Mechanical");
  assert.equal(a.status, "scheduled");
  assert.match(a.reason, /seen it, no RFQ yet/);
  const email = close.writes.find((w) => w.op === "email")!.body as { scheduleAt: string; inReplyToId: string };
  assert.equal(email.scheduleAt, a.scheduledFor, "scheduled in Close, which sends it");
  assert.ok(email.inReplyToId, "a reply in the line card's thread");
  assert.ok(!close.writes.some((w) => w.op === "send"), "nothing sent by us");
  // Planned again: not twice for the same account.
  assert.equal((await planBumps(d, { force: true })).planned.length, 0);
  // The account now says the bump is on its way instead of asking you to bump.
  const crest = (await accountsBoard(d, { fresh: true })).accounts.find((x) => x.company === "Crest Mechanical")!;
  assert.match(crest.next.tag, /^Email · auto /);
  assert.equal(crest.next.label, "Get a first RFQ from Amy");
  assert.ok(crest.events.some((e) => e.kind === "auto"));
});

test("the list follows Close: sent, skipped, and pulled back when they write in first", async () => {
  const { close, d } = setup("user_auto2");
  await setAutomations(d, true);
  const [a] = (await planBumps(d)).planned;

  // Skip: back to a draft in Close, marked skipped.
  const skipped = await skipAutomation(d, a.id);
  assert.equal(skipped.status, "skipped");
  assert.ok(close.writes.some((w) => w.op === "unschedule"));

  // Another account, sent by Close: shows as sent.
  const { close: c2, d: d2 } = setup("user_auto3");
  await setAutomations(d2, true);
  const [b] = (await planBumps(d2)).planned;
  c2.statusOf.set(b.id, "sent");
  await syncAutomations(d2);
  const view = await automationsView(d2);
  assert.equal(view.sent.length, 1);
  assert.equal(view.sent[0].company, "Crest Mechanical");
  assert.ok(view.sent[0].body, "the email itself, read from Close");

  // A third: they reply before it goes out. Close to send time, it's pulled back.
  const { close: c3, d: d3 } = setup("user_auto4");
  await setAutomations(d3, true);
  const [c] = (await planBumps(d3)).planned;
  c3.sentEmails.push({ id: "acti_reply_crest", lead_id: c.leadId, user_id: "user_auto4", status: "inbox", direction: "incoming", subject: "RE: Westgate Supply – line card", date_sent: new Date(Date.now() + 1000).toISOString(), sender: "Amy Chen <amy@crestmech.test>", opens: [] });
  const soon = { ...d3, now: () => new Date(new Date(c.scheduledFor!).getTime() - 30 * 60 * 1000) };
  await syncAutomations(soon);
  const after = await automationsView(d3);
  assert.equal(after.other[0].status, "stopped");
  assert.match(after.other[0].note!, /Pulled back: they wrote in/);
  assert.ok(c3.writes.some((w) => w.op === "unschedule"));
});

test("coming up: who gets an automatic email and when, if nothing changes; Hold keeps an account out", async () => {
  const { forecast, holdAccount, morningOf } = await import("../src/automations.js");
  const tz = "America/Los_Angeles";
  assert.equal(morningOf(new Date("2026-09-30T20:00:00Z"), tz).toISOString(), "2026-10-01T16:00:00.000Z", "Wed 1pm → Thu 9am");
  assert.equal(morningOf(new Date("2026-10-02T23:00:00Z"), tz).toISOString(), "2026-10-05T16:00:00.000Z", "Fri 4pm → Mon 9am");
  assert.equal(morningOf(new Date("2026-09-29T15:00:00Z"), tz).toISOString(), "2026-09-29T16:00:00.000Z", "Tue 8am → Tue 9am");

  const { d } = setup("user_auto5");
  const f = await forecast(d);
  const crest = f.find((x) => x.company === "Crest Mechanical");
  assert.ok(crest, "Crest's bump is due, so it's coming up");
  assert.equal(crest!.label, "Bump in the line card thread");
  assert.match(crest!.reason, /seen it, no RFQ yet/);
  assert.ok(!f.some((x) => x.company === "Harbor Fabrication"), "not-opened accounts are a call, never an automatic email");

  await holdAccount(d, crest!.leadId, true);
  assert.equal((await forecast(d)).find((x) => x.leadId === crest!.leadId)?.held, true);
  await setAutomations(d, true);
  assert.equal((await planBumps(d)).planned.length, 0, "held accounts aren't bumped");
  await holdAccount(d, crest!.leadId, false);
  assert.equal((await planBumps(d)).planned.length, 1);
});
