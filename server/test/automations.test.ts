import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsBoard } from "../src/accounts.js";
import type { Deps } from "../src/assistant.js";
import { automationsView, CADENCE_ARMS, dedupeDue, dropRescueDraft, MAX_BUMPS, morningRun, planBumps, sendBumpsNow, setAutomations, skipAutomation, stopScheduledFor, syncAutomations } from "../src/automations.js";
import { demoLineCards, demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import { sendSlot } from "../src/followup.js";
import { store } from "../src/store.js";

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

test("an account that sends an RFQ is out of automatic emails for good (VGas, 9/28)", async () => {
  const { forecast } = await import("../src/automations.js");
  const { close, d } = setup("user_auto6");
  const crestId = (await forecast(d)).find((x) => x.company === "Crest Mechanical")!.leadId;
  // Amy sends her RFQ.
  close.sentEmails.push({ id: "acti_crest_rfq", lead_id: crestId, user_id: "user_auto6", status: "inbox", direction: "incoming", subject: "RE: Westgate Supply – line card", date_sent: new Date().toISOString(), date_created: new Date().toISOString(), sender: "Amy Chen <amy@crestmech.test>", opens: [], attachments: [{ filename: "RFQ 26-114.pdf", content_type: "application/pdf" }] });
  const crest = (await accountsBoard(d, { fresh: true })).accounts.find((x) => x.leadId === crestId)!;
  const f = await forecast(d);
  assert.ok(!f.some((x) => x.leadId === crestId), "not coming up");
  await setAutomations(d, true);
  assert.equal((await planBumps(d)).planned.length, 0, "not planned");
  assert.ok(["reply", "quote"].includes(crest.next.kind), `the next step is yours (answer or price it), got ${crest.next.kind}`);
});

test("the automatic bump: back to the top + any RFQs, a meme inline (never one they've had), no AI (9/30)", async () => {
  const { bumpBodyFor } = await import("../src/followup.js");
  const { bumpHtml, memeFor } = await import("../src/memes.js");
  assert.equal(bumpBodyFor("Tammy", "Walt Boxwell", 0), "Hi Tammy!\n\nJust bumping this back to the top of your inbox. Any RFQs coming up I can price for you?\n\nWalt Boxwell");
  assert.notEqual(bumpBodyFor("Tammy", "Walt Boxwell", 1), bumpBodyFor("Tammy", "Walt Boxwell", 0), "a second bump isn't word for word the first");
  assert.match(bumpBodyFor(null, "Walt Boxwell"), /^Hi there!/);
  const meme = { name: "forklift.jpg", url: "https://x.supabase.co/storage/v1/object/public/memes/forklift.jpg" };
  const html = bumpHtml(bumpBodyFor("Tammy", "Walt Boxwell", 0), "Walt Boxwell", meme);
  assert.match(html, /^<p>Hi Tammy!<\/p><p>Just bumping.*<\/p><p><img src="https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/memes\/forklift\.jpg"[^>]*><\/p><p>Walt Boxwell<\/p>$/, "inline, between the ask and the name");
  // Never the same meme twice: a pick they've already had is replaced by one they haven't.
  const memes = [meme, { name: "bolts.png", url: "u2" }];
  const d = { rep: { closeUserId: "user_m" } } as never;
  const seen = new Map([["lead_t", new Set(["forklift.jpg"])]]);
  const got = await memeFor(d, "lead_t", { memes, seen, picks: { lead_t: "forklift.jpg" } });
  assert.equal(got?.name, "bolts.png");
  assert.equal(await memeFor(d, "lead_t", { memes, seen: new Map([["lead_t", new Set(["forklift.jpg", "bolts.png"])]]), picks: { lead_t: "bolts.png" } }), null, "seen them all: no meme rather than a repeat");
  assert.equal(await memeFor(d, "lead_x", { memes, seen, picks: { lead_x: null } }), null, "\"No meme\" is kept");
});

test("bump greetings: a nickname wins, initials and mailbox words get \"Hi there\" (10/1)", async () => {
  const { greetName } = await import("../src/followup.js");
  assert.equal(greetName("H.C. (Clifford) Provence"), "Clifford");
  assert.equal(greetName("J. Waite"), null);
  assert.equal(greetName("frontdesk"), null);
  assert.equal(greetName("hello"), null);
  assert.equal(greetName("Main Office"), null);
  assert.equal(greetName("Damon"), "Damon");
  assert.equal(greetName("kimberly kremer"), "Kimberly");
});

test("a bump never goes to a Westgate address: it threads under the newest email with the buyer (10/1)", async () => {
  const { writeFollowUp } = await import("../src/followup.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  close.sentWithOpens = [
    { id: "acti_form", thread_id: "t_form", status: "sent", direction: "outgoing", subject: "New RFQ WG-1 from test at test", date_sent: "2026-10-01T03:00:00Z", sender: "'Westgate Team' via team <team@westgatesupply.com>", to: ["team@westgatesupply.com"], opens: [] },
    { id: "acti_loop", thread_id: "t_card", status: "sent", direction: "outgoing", subject: "Re: Westgate Supply – line card", date_sent: "2026-09-30T18:00:00Z", sender: "Walt Boxwell <walt@westgatesupply.com>", to: ["jacob@westgatesupply.com", "rob.roy@gmail.com"], opens: [] },
  ] as never;
  const d = { close, llm: demoLlm, now: () => new Date("2026-10-08T16:00:00Z"), rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles" } } as never;
  const r = await writeFollowUp(d, DEMO_LEAD_ID, { force: true, template: { meme: null, nth: 0 } });
  assert.equal(r.status, "drafted");
  if (r.status !== "drafted") return;
  assert.equal(r.to, "rob.roy@gmail.com", "the buyer, not Jacob or team@");
  const draft = close.writes.filter((w) => w.op === "email").pop()!.body as { inReplyToId: string };
  assert.equal(draft.inReplyToId, "acti_loop", "threaded under the email with the buyer, not the form notification");
});

test("safety rails (10/2): one bump per account and per address, and never a second one inside the gap", () => {
  const acct = (leadId: string, company: string, email: string | null) => ({ leadId, company, contact: { email } });
  const { keep, dropped } = dedupeDue(
    [
      acct("lead_mercer", "Mercer Tech", "julie.a@mercer-tech.com"),
      acct("lead_mercer", "Mercer Tech", "julie.a@mercer-tech.com"), // listed twice (what happened 10/1)
      acct("lead_mercer2", "Mercer Tech (dup lead)", "Julie.A@mercer-tech.com"), // same inbox, another account
      acct("lead_crest", "Crest Mechanical", "amy@crestmech.test"),
      acct("lead_sent", "Already Bumped Co", "pat@already.test"),
      acct("lead_other", "Shared Inbox Co", "buyer@shared.test"),
    ],
    [
      { leadId: "lead_sent", to: "pat@already.test", status: "sent" },
      { leadId: "lead_x", to: "buyer@shared.test", status: "scheduled" },
      { leadId: "lead_old", to: "amy@crestmech.test", status: "skipped" }, // a skip doesn't count
    ],
  );
  assert.deepEqual(keep.map((a) => a.leadId), ["lead_mercer", "lead_crest"]);
  assert.deepEqual(dropped.map((x) => x.why), [
    "Listed twice today; one bump is enough.",
    "Listed twice today; one bump is enough.", // same inbox on a second account, same day
    "Already got an automatic email in the last 2 business days.",
    "buyer@shared.test already got an automatic email on another account in the last 2 business days.",
  ]);
});

test("safety rails (10/5): the gap is the account's own cadence in business days, not a calendar week", () => {
  const tz = "America/Los_Angeles";
  const acct = (leadId: string, company: string, email: string | null) => ({ leadId, company, contact: { email } });
  const due = [acct("lead_three", "Three Day Co", "a@three.test"), acct("lead_five", "Five Day Co", "b@five.test"), acct("lead_none", "No Cadence Co", "c@none.test"), acct("lead_queued", "Queued Co", "d@queued.test")];
  // Everyone got Friday's batch (10/2, 9:20am Pacific); Queued Co also has one scheduled.
  const friday = { status: "sent", statusAt: "2026-10-02T16:20:00Z" };
  const recent = [
    { leadId: "lead_three", to: "a@three.test", ...friday },
    { leadId: "lead_five", to: "b@five.test", ...friday },
    { leadId: "lead_none", to: "c@none.test", ...friday },
    { leadId: "lead_queued", to: "d@queued.test", status: "scheduled", scheduledFor: "2026-10-07T16:00:00Z" },
  ];
  const arms = { lead_three: 3, lead_five: 5, lead_queued: 3 };
  // Monday: one business day later. Nobody.
  assert.deepEqual(dedupeDue(due, recent, { now: new Date("2026-10-05T14:03:00Z"), tz, arms }).keep, []);
  // Tuesday: the standard two business days (10/5). The account with no cadence of its own goes.
  assert.deepEqual(dedupeDue(due, recent, { now: new Date("2026-10-06T14:03:00Z"), tz, arms }).keep.map((a) => a.leadId), ["lead_none"]);
  // Wednesday, the 7am run: the 3-day account goes too. The old 7-calendar-day rule dropped it.
  const wed = dedupeDue(due, recent, { now: new Date("2026-10-07T14:03:00Z"), tz, arms });
  assert.deepEqual(wed.keep.map((a) => a.leadId), ["lead_three", "lead_none"]);
  assert.deepEqual(wed.dropped.map((x) => x.why), [
    "Already got an automatic email in the last 5 business days.",
    "Already has an automatic email scheduled.",
  ]);
  // Friday at 7am: a business week after a 9:20am send. By date, not 24-hour blocks.
  assert.deepEqual(dedupeDue(due, recent, { now: new Date("2026-10-09T14:03:00Z"), tz, arms }).keep.map((a) => a.leadId), ["lead_three", "lead_five", "lead_none"]);
});

test("test mode is a hard stop: a real bump queued before it was turned on is pulled back before it sends", async () => {
  const { close, d } = setup("user_rails1");
  await setAutomations(d, true);
  const [c] = (await planBumps(d)).planned;
  await store.putSetting(d.rep.closeUserId, "autoTestMode", true);
  const soon = { ...d, now: () => new Date(new Date(c.scheduledFor!).getTime() - 30 * 60 * 1000) };
  await syncAutomations(soon);
  const after = await automationsView(d);
  assert.equal(after.other[0].status, "stopped");
  assert.match(after.other[0].note!, /Pulled back: test mode is on/);
  assert.ok(close.writes.some((w) => w.op === "unschedule"));
});

test("nobody gets a second automatic email inside their gap, even if one slipped into the queue", async () => {
  const { close, d } = setup("user_rails2");
  await setAutomations(d, true);
  const [c] = (await planBumps(d)).planned;
  // One already went out to this address the day before this one is due.
  await store.putAutomation({ ...c, id: "acti_prev_crest", status: "sent", statusAt: new Date(new Date(c.scheduledFor!).getTime() - 24 * 3600e3).toISOString() });
  const soon = { ...d, now: () => new Date(new Date(c.scheduledFor!).getTime() - 30 * 60 * 1000) };
  await syncAutomations(soon);
  const after = await automationsView(d);
  const row = after.other.find((x) => x.id === c.id)!;
  assert.equal(row.status, "stopped");
  assert.match(row.note!, /already got an automatic email on \d{4}-\d{2}-\d{2}/);
  assert.ok(close.writes.some((w) => w.op === "unschedule"));
});

test("a bump on the account's own cadence goes: 3 business days after the last one isn't \"a second one this week\" (10/5)", async () => {
  const { close, d } = setup("user_rails3");
  await setAutomations(d, true);
  const [planned] = (await planBumps(d)).planned;
  const c = { ...planned, arm: 3 };
  await store.putAutomation(c);
  // The one before it went out exactly 3 business days earlier.
  let prev = new Date(c.scheduledFor!);
  for (let n = 0; n < 3;) { prev = new Date(prev.getTime() - 24 * 3600e3); if (![0, 6].includes(new Date(prev.toLocaleString("en-US", { timeZone: rep.timeZone })).getDay())) n++; }
  await store.putAutomation({ ...c, id: "acti_prev_crest3", status: "sent", statusAt: prev.toISOString(), createdAt: prev.toISOString() });
  const soon = { ...d, now: () => new Date(new Date(c.scheduledFor!).getTime() - 30 * 60 * 1000) };
  await syncAutomations(soon);
  assert.equal((await automationsView(d)).upcoming.find((x) => x.id === c.id)?.status, "scheduled", "still going out");
  assert.ok(!close.writes.some((w) => w.op === "unschedule"));
});

test("shot down, or marked Not Interested in Close after it was planned: the bump is pulled back before it sends (10/5)", async () => {
  const { close, d } = setup("user_rails4");
  await setAutomations(d, true);
  const [c] = (await planBumps(d)).planned;
  close.leadStatus.set(c.leadId, "Not Interested");
  const soon = { ...d, now: () => new Date(new Date(c.scheduledFor!).getTime() - 30 * 60 * 1000) };
  await syncAutomations(soon);
  const row = (await automationsView(d)).other.find((x) => x.id === c.id)!;
  assert.equal(row.status, "stopped");
  assert.match(row.note!, /Pulled back: the lead is marked Not Interested in Close/);
  assert.ok(close.writes.some((w) => w.op === "unschedule"));
});

test("the Friday copy (10/2): pricing back Monday, plain ask, no hedging", async () => {
  const { bumpBodyFor } = await import("../src/followup.js");
  const body = bumpBodyFor("Dana", "Walt Boxwell", 0, "friday");
  assert.equal(body, "Hi Dana!\n\nHappy Friday! Bumping this back to the top before the weekend. If there's an RFQ on your desk, send it over and I'll have pricing back to you Monday morning.\n\nWalt Boxwell");
  assert.doesNotMatch(body, /no strings|no pressure|stack up|quotes back fast/i);
  assert.equal(bumpBodyFor("Dana", "Walt Boxwell", 0, null), bumpBodyFor("Dana", "Walt Boxwell", 0), "no variant: the usual rotation");
});

test("send now (10/2): out in minutes, staggered, with the copy, a meme, and the account's cadence arm; the rescue draft goes", async () => {
  const { close, d } = setup("user_sendnow");
  const crest = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Crest Mechanical")!;
  // A rescue draft is waiting for Crest in Close.
  close.writes.push({ op: "email", id: "acti_rescue_crest", body: { leadId: crest.leadId, to: [crest.contact.email], subject: "Re: Westgate Supply – line card", body: "" } } as never);
  await store.putSetting(d.rep.closeUserId, "rescueDrafts", { [crest.leadId]: "acti_rescue_crest" });
  const forklift = { name: "forklift.jpg", url: "https://x.supabase.co/storage/v1/object/public/memes/forklift.jpg" };
  const fixed = { ...d, now: () => new Date("2026-10-02T17:00:00Z") }; // Friday 10am Pacific
  const r = await sendBumpsNow(fixed, { leadIds: [crest.leadId, "lead_not_on_board"], variant: "friday", memes: [forklift] });
  assert.equal(r.planned.length, 1);
  const [row] = r.planned;
  assert.equal(row.variant, "friday");
  assert.equal(row.meme, "forklift.jpg");
  assert.ok((CADENCE_ARMS as readonly number[]).includes(row.arm!), `dealt a cadence arm: ${row.arm}`);
  const at = new Date(row.scheduledFor!).getTime() - new Date("2026-10-02T17:00:00Z").getTime();
  assert.ok(at >= 2 * 60_000 && at <= 3 * 60_000, `goes in about two minutes, not 9am tomorrow: ${row.scheduledFor}`);
  const email = close.writes.filter((w) => w.op === "email").pop()!.body as { body: string; html: string | null; scheduleAt: string };
  assert.match(email.body, /Happy Friday!/);
  assert.match(email.html ?? "", /forklift\.jpg/);
  assert.ok(close.writes.some((w) => w.op === "delete" && (w.body as { id: string }).id === "acti_rescue_crest"), "the rescue draft is deleted: never two emails");
  assert.deepEqual(await store.getSetting(d.rep.closeUserId, "rescueDrafts"), {});
  assert.deepEqual(r.skipped, [{ company: "lead_not_on_board", why: "Not on the accounts board." }]);
  // Same arm next time.
  assert.equal((await store.getSetting<Record<string, number>>(d.rep.closeUserId, "cadenceArms"))![crest.leadId], row.arm);
});

test("the cap (10/2): after the last allowed automatic bump an account comes back as a call, not another email", async () => {
  const { d } = setup("user_cap");
  const crest = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Crest Mechanical")!;
  for (let i = 0; i < MAX_BUMPS; i++) {
    await store.putAutomation({ id: `acti_prev_${i}`, repId: d.rep.closeUserId, leadId: crest.leadId, company: crest.company, to: crest.contact.email!, subject: "Re: x", kind: "bump", label: "", reason: "", scheduledFor: null, createdAt: new Date(Date.now() - (30 - i * 4) * 86400e3).toISOString(), status: "sent", statusAt: null, note: null, checkedAt: null });
  }
  const r = await sendBumpsNow(d, { leadIds: [crest.leadId], variant: "friday", memes: [] });
  assert.equal(r.planned.length, 0);
  assert.deepEqual(r.skipped, [{ company: "Crest Mechanical", why: `${MAX_BUMPS} automatic emails already; call them.` }]);
});

test("never two (10/2): a bump is pulled back if the rep emailed them by hand first, and a hand-sent rescue draft stops a queued bump", async () => {
  const { close, d } = setup("user_byhand");
  await setAutomations(d, true);
  const [c] = (await planBumps(d)).planned;
  close.sentEmails.push({ id: "acti_hand", lead_id: c.leadId, user_id: d.rep.closeUserId, status: "sent", direction: "outgoing", subject: "Re: Westgate Supply – line card", date_sent: new Date(Date.now() + 1000).toISOString(), opens: [] } as never);
  const soon = { ...d, now: () => new Date(new Date(c.scheduledFor!).getTime() - 30 * 60 * 1000) };
  await syncAutomations(soon);
  const after = await automationsView(d);
  assert.equal(after.other[0].status, "stopped");
  assert.match(after.other[0].note!, /Pulled back: you emailed them yourself/);

  const { close: c2, d: d2 } = setup("user_byhand2");
  await setAutomations(d2, true);
  const [b] = (await planBumps(d2)).planned;
  await stopScheduledFor(d2, b.leadId, "you sent the rescue draft yourself.");
  assert.ok(c2.writes.some((w) => w.op === "unschedule" && (w.body as { id: string }).id === b.id));
  assert.match((await automationsView(d2)).other[0].note!, /you sent the rescue draft yourself/);
  assert.equal(await dropRescueDraft(d2, b.leadId), false, "nothing to drop");
});
