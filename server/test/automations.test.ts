import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsBoard } from "../src/accounts.js";
import type { Deps } from "../src/assistant.js";
import { automationsView, CADENCE_ARMS, dedupeDue, dropRescueDraft, morningRun, planBumps, sendBumpsNow, setAutomations, skipAutomation, stopScheduledFor, syncAutomations } from "../src/automations.js";
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

test("bumps go out around their 8am, a random minute 7:50 to 8:34; Mondays after 10 (Walt 10/8, 10/12)", () => {
  const tz = "America/Chicago";
  const lo = () => 0, hi = () => 0.999;
  assert.equal(sendSlot(tz, new Date("2026-09-29T12:00:00Z"), 0, lo), "2026-09-29T07:50:00-05:00", "Tuesday 7am → earliest 7:50");
  assert.equal(sendSlot(tz, new Date("2026-09-29T12:00:00Z"), 0, hi), "2026-09-29T08:34:00-05:00", "Tuesday 7am → latest 8:34");
  assert.equal(sendSlot(tz, new Date("2026-09-29T13:00:00Z"), 0, lo), "2026-09-29T08:05:00-05:00", "Tuesday 8:00 → at least 5 minutes out");
  assert.equal(sendSlot(tz, new Date("2026-09-29T14:30:00Z"), 0, lo), "2026-09-30T07:50:00-05:00", "Tuesday 9:30 → past the window, Wednesday's");
  assert.equal(sendSlot(tz, new Date("2026-09-29T19:00:00Z"), 0, lo), "2026-09-30T07:50:00-05:00", "Tuesday 2pm → Wednesday's window");
  assert.equal(sendSlot(tz, new Date("2026-09-29T12:00:00Z"), 12, lo), "2026-09-29T08:02:00-05:00", "stagger nudges the earliest minute");
  // Monday morning is a pile of mail: Monday's go out 10:00 to 10:44.
  assert.equal(sendSlot(tz, new Date("2026-09-28T12:00:00Z"), 0, lo), "2026-09-28T10:00:00-05:00", "Monday 7am → 10:00");
  assert.equal(sendSlot(tz, new Date("2026-09-28T12:00:00Z"), 0, hi), "2026-09-28T10:44:00-05:00", "Monday 7am → latest 10:44");
  assert.equal(sendSlot(tz, new Date("2026-09-28T14:30:00Z"), 0, lo), "2026-09-28T10:00:00-05:00", "Monday 9:30 → still before Monday's window");
  assert.equal(sendSlot(tz, new Date("2026-09-26T15:00:00Z"), 0, lo), "2026-09-28T10:00:00-05:00", "Saturday → Monday's window");
  assert.equal(sendSlot(tz, new Date("2026-10-02T19:00:00Z"), 0, lo), "2026-10-05T10:00:00-05:00", "Friday 2pm → Monday's window");
  const slots = new Set(Array.from({ length: 40 }, () => sendSlot(tz, new Date("2026-09-29T12:00:00Z"))));
  assert.ok(slots.size > 12, `spread: ${slots.size} distinct minutes`);
  for (const x of slots) assert.ok(x >= "2026-09-29T07:50:00-05:00" && x <= "2026-09-29T08:34:00-05:00", x);
});

test("off by default; when on, the day's bumps are scheduled in Close with the reason, once per account", async () => {
  const { close, d } = setup("user_auto1");
  assert.equal((await planBumps(d)).planned.length, 0, "off until you turn it on");
  assert.equal(await morningRun(d), null);
  await setAutomations(d, true);
  const r = await planBumps(d);
  // Crest (opened, due) and the unopened accounts, which are in the sequence since 10/5. (The fixtures are dated from
  // the real clock, so which unopened ones are two business days out varies by weekday; these three always are.)
  for (const co of ["Crest Mechanical", "Harbor Fabrication", "Mesa Pipe & Supply"]) assert.ok(r.planned.some((p) => p.company === co), `${co} planned: ${JSON.stringify(r.planned.map((p) => p.company))}`);
  const a = r.planned.find((p) => p.company === "Crest Mechanical")!;
  assert.equal(a.status, "scheduled");
  assert.match(a.reason, /intro, email \d of \d|business days/, "the reason is where they are in the sequence (10/12)");
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
  // The label says where they are in the sequence (10/12), the reason says why that gap.
  assert.match(crest!.label, /intro, email \d|Rhythm email|Monthly email/);
  assert.match(crest!.reason, /business day/);
  const harbor = f.find((x) => x.company === "Harbor Fabrication");
  assert.ok(harbor, "not-opened accounts are in the sequence too (10/5)");
  assert.match(harbor!.label, /intro, email \d|Rhythm email|Monthly email/);
  assert.match(harbor!.preview ?? "", /RFQ/);
  assert.doesNotMatch(harbor!.preview ?? "", /junk/);

  await holdAccount(d, crest!.leadId, true);
  assert.equal((await forecast(d)).find((x) => x.leadId === crest!.leadId)?.held, true);
  await setAutomations(d, true);
  const held = await planBumps(d);
  assert.ok(!held.planned.some((p) => p.leadId === crest!.leadId), "held accounts aren't bumped");
  await holdAccount(d, crest!.leadId, false);
  assert.ok((await planBumps(d)).planned.some((p) => p.leadId === crest!.leadId));
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
  assert.ok(!(await planBumps(d)).planned.some((p) => p.leadId === crestId), "not planned");
  assert.ok(["reply", "quote"].includes(crest.next.kind), `the next step is yours (answer or price it), got ${crest.next.kind}`);
});

test("the automatic bump: back to the top + any RFQs, a meme inline (never one they've had), no AI (9/30)", async () => {
  const { bumpBodyFor } = await import("../src/followup.js");
  const { bumpHtml, memeFor } = await import("../src/memes.js");
  // The sequence copy (10/12): eager, full sentences, every one ends in the same plain ask.
  const CARD = "Line card's attached too, or you can grab it here: https://westgatesupply.com/brand/westgate-line-card.pdf";
  assert.equal(bumpBodyFor("Tammy", "Walt Boxwell", { nth: 0, track: "talked", round: 1, talkedDaysAgo: 1 }), `Hi Tammy!\n\nIt was great talking to you yesterday! Please send me over an RFQ and we'll get you a quote back.\n\n${CARD}\n\nThanks,\nWalt Boxwell`);
  assert.match(bumpBodyFor("Tammy", "Walt Boxwell", { nth: 0, track: "talked", round: 1, talkedDaysAgo: 4 }), /great talking to you the other day!/);
  assert.match(bumpBodyFor("Tammy", "Walt Boxwell", { nth: 0, track: "talked", round: 2 }), /good talking to you again!/);
  assert.match(bumpBodyFor("Tammy", "Walt Boxwell", { nth: 0, track: "talked", round: 1, talkedDaysAgo: 20 }), /I hope your week's going good!/, "weeks after the call: not \"great talking to you\"");
  assert.match(bumpBodyFor("Tammy", "Walt Boxwell", { nth: 1, track: "talked" }), /Send me the last RFQ you sent out, even if it's already been bought/);
  const all = [
    ...Array.from({ length: 8 }, (_, i) => bumpBodyFor("Tammy", "Walt Boxwell", { nth: i, track: "talked", round: 1 + (i % 3) })),
    ...Array.from({ length: 6 }, (_, i) => bumpBodyFor("Tammy", "Walt Boxwell", { nth: i, track: "cold" })),
  ];
  for (const b of all) {
    assert.match(b, /quote back|quote it/, "every one asks for the RFQ");
    assert.doesNotMatch(b, /circl|top of your inbox|no strings|no pressure|stack up|quotes back fast|junk|spam/i);
    assert.doesNotMatch(b, /sorry|block|annoy|still here|so many emails/i, "never self-aware about the emails (Walt 10/12)");
  }
  assert.match(bumpBodyFor(null, "Walt Boxwell"), /^Hi there!/);
  // Someone you haven't talked to: the cold lines, and the site link too.
  const cold = bumpBodyFor("Mike", "Walt Boxwell", { nth: 0, track: "cold", siteUrl: "https://t.example/l/abc/site", cardUrl: "https://t.example/l/abc/card" });
  assert.match(cold, /I wanted to bump this back up in case it got buried\. Please send me over an RFQ and we'll get you a quote back\./);
  assert.match(cold, /grab it here: https:\/\/t\.example\/l\/abc\/card/);
  assert.match(cold, /Our site is here if that's easier: https:\/\/t\.example\/l\/abc\/site/);
  // A shared mailbox: every other email asks who handles RFQs.
  assert.match(bumpBodyFor(null, "Walt Boxwell", { nth: 1, track: "cold", generic: true }), /whoever handles the pipe and fittings RFQs/);
  assert.doesNotMatch(bumpBodyFor(null, "Walt Boxwell", { nth: 2, track: "cold", generic: true }), /whoever handles/);
  const meme = { name: "forklift.jpg", url: "https://x.supabase.co/storage/v1/object/public/memes/forklift.jpg" };
  const html = bumpHtml(bumpBodyFor("Tammy", "Walt Boxwell", { nth: 0, talkedDaysAgo: 1 }), "Walt Boxwell", meme);
  assert.match(html, /^<p>Hi Tammy!<\/p><p>It was great talking to you yesterday!.*<\/p><p>Line card's attached too, or you can grab it here: <a href="[^"]+">[^<]+<\/a><\/p><p><img src="https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/memes\/forklift\.jpg"[^>]*><\/p><p[^>]*>There's a hilarious meme in here\. If it didn't come through, <a href="https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/memes\/forklift\.jpg"[^>]*>here it is<\/a>\.<\/p><p>Thanks,<br>Walt Boxwell<\/p>$/, "inline, with a link under it for mail apps that hide images, before the name");
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
  const r = await writeFollowUp(d, DEMO_LEAD_ID, { force: true, template: { meme: null, place: { nth: 0 } } });
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
  const body = bumpBodyFor("Dana", "Walt Boxwell", { nth: 0, variant: "friday" });
  assert.equal(body, "Hi Dana!\n\nI wanted to bump this before the week ends. Please send me over an RFQ and we'll get you a quote back.\n\nLine card's attached too, or you can grab it here: https://westgatesupply.com/brand/westgate-line-card.pdf\n\nThanks,\nWalt Boxwell");
  assert.doesNotMatch(body, /no strings|no pressure|stack up|quotes back fast/i);
  assert.equal(bumpBodyFor("Dana", "Walt Boxwell", { nth: 0, variant: null }), bumpBodyFor("Dana", "Walt Boxwell", { nth: 0 }), "no variant: the usual sequence");
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
  assert.equal(row.arm, crest.cadence.gap, "the row keeps the account's gap, for the scoreboard");
  const at = new Date(row.scheduledFor!).getTime() - new Date("2026-10-02T17:00:00Z").getTime();
  assert.ok(at >= 2 * 60_000 && at <= 3 * 60_000, `goes in about two minutes, not 9am tomorrow: ${row.scheduledFor}`);
  const email = close.writes.filter((w) => w.op === "email").pop()!.body as { body: string; html: string | null; scheduleAt: string };
  assert.match(email.body, /before the week ends/);
  assert.match(email.html ?? "", /forklift\.jpg/);
  assert.ok(close.writes.some((w) => w.op === "delete" && (w.body as { id: string }).id === "acti_rescue_crest"), "the rescue draft is deleted: never two emails");
  assert.deepEqual(await store.getSetting(d.rep.closeUserId, "rescueDrafts"), {});
  assert.deepEqual(r.skipped, [{ company: "lead_not_on_board", why: "Not on the accounts board." }]);
});

test("no cap (10/6): a tenth automatic bump still goes; only a cooling period stops the sequence", async () => {
  const { holdAccount } = await import("../src/automations.js");
  const { d } = setup("user_cap");
  const crest = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Crest Mechanical")!;
  for (let i = 0; i < 9; i++) {
    await store.putAutomation({ id: `acti_prev_${i}`, repId: d.rep.closeUserId, leadId: crest.leadId, company: crest.company, to: crest.contact.email!, subject: "Re: x", kind: "bump", label: "", reason: "", scheduledFor: null, createdAt: new Date(Date.now() - (40 - i * 4) * 86400e3).toISOString(), status: "sent", statusAt: null, note: null, checkedAt: null });
  }
  const r = await sendBumpsNow(d, { leadIds: [crest.leadId], variant: "friday", memes: [] });
  assert.equal(r.planned.length, 1, JSON.stringify(r.skipped));
  await holdAccount(d, crest.leadId, true, { days: 30 });
  const held = await sendBumpsNow(d, { leadIds: [crest.leadId], variant: "friday", memes: [] });
  assert.deepEqual(held.skipped.map((x) => x.why), ["On hold"]);
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

test("unconfirmed accounts (10/5, 10/6): in the sequence with the plain ask, and they stay in it (no automatic stop)", async () => {
  const { close, d } = setup("user_unconfirmed");
  await setAutomations(d, true);
  const board = await accountsBoard(d, { fresh: true });
  const harbor = board.accounts.find((a) => a.company === "Harbor Fabrication")!;
  const mesa = board.accounts.find((a) => a.company === "Mesa Pipe & Supply")!;
  assert.equal(harbor.seen, "not_opened"); assert.equal(mesa.seen, "not_opened");
  // Harbor already had three without an open; it still goes.
  for (let i = 0; i < 3; i++) {
    await store.putAutomation({ id: `acti_unc_${i}`, repId: d.rep.closeUserId, leadId: harbor.leadId, company: harbor.company, to: harbor.contact.email!, subject: "Re: x", kind: "bump", label: "", reason: "", scheduledFor: null, createdAt: new Date(Date.now() - (20 - i * 5) * 86400e3).toISOString(), status: "sent", statusAt: new Date(Date.now() - (20 - i * 5) * 86400e3).toISOString(), note: null, checkedAt: null });
  }
  // The sequence counts them (10/12): three in, it's past the cold intro and the app flags a call; the emails go on.
  const after = (await accountsBoard(d, { fresh: true })).accounts;
  const harbor2 = after.find((a) => a.company === "Harbor Fabrication")!;
  assert.equal(harbor2.cadence.nth, 3);
  assert.equal(harbor2.cadence.callFlag, true);
  const r = await planBumps(d);
  assert.ok(!r.skipped.some((s) => s.company === "Harbor Fabrication" && /limit|already/i.test(s.why)), JSON.stringify(r.skipped));
  if (harbor2.bumpDue) assert.ok(r.planned.some((p) => p.leadId === harbor.leadId), "Harbor's fourth bump goes");
  const m = r.planned.find((p) => p.leadId === mesa.leadId);
  if (after.find((a) => a.leadId === mesa.leadId)!.bumpDue) {
    assert.ok(m, `Mesa planned: ${JSON.stringify(r.planned.map((p) => p.company))} skipped: ${JSON.stringify(r.skipped)}`);
    assert.match(m!.variant ?? "", /^(cold|talked):r\d+:(intro|rhythm|monthly)$/);
    const email = close.writes.filter((w) => w.op === "email").map((w) => w.body as { body: string }).find((e) => /RFQ/.test(e.body));
    assert.ok(email, "the bump is the plain ask");
  }
});

test("the Emails tab (10/6): sent and queued rows, with whether the buyer opened or replied since", async () => {
  const { sentEmailsView } = await import("../src/automations.js");
  const { close, d } = setup("user_emails_tab");
  const board = await accountsBoard(d, { fresh: true });
  const crest = board.accounts.find((a) => a.company === "Crest Mechanical")!;
  const harbor = board.accounts.find((a) => a.company === "Harbor Fabrication")!;
  const base = { repId: d.rep.closeUserId, subject: "Re: x", kind: "bump" as const, label: "", reason: "", createdAt: new Date(Date.now() - 2 * 86400e3).toISOString(), note: null, checkedAt: null };
  // Crest: sent two days ago, and Amy opened it after (the fixture has an open yesterday).
  await store.putAutomation({ ...base, id: "acti_tab_crest", leadId: crest.leadId, company: crest.company, to: crest.contact.email!, status: "sent", statusAt: new Date(Date.now() - 2 * 86400e3).toISOString(), scheduledFor: null, meme: "a.jpg" });
  // Harbor: queued for later today.
  await store.putAutomation({ ...base, id: "acti_tab_harbor", leadId: harbor.leadId, company: harbor.company, to: harbor.contact.email!, status: "scheduled", statusAt: null, scheduledFor: new Date(Date.now() + 3600e3).toISOString() });
  const rows = await sentEmailsView(d, 7);
  const c = rows.find((r) => r.id === "acti_tab_crest")!, h = rows.find((r) => r.id === "acti_tab_harbor")!;
  assert.equal(c.status, "sent"); assert.equal(c.opened, crest.opens.last! > c.at!, "opened after the send, from Close's opens");
  assert.equal(c.replied, false);
  assert.equal(h.status, "scheduled"); assert.equal(h.opened, false); assert.equal(h.at, (await store.listAutomations(d.rep.closeUserId, new Date(0).toISOString())).find((r) => r.id === "acti_tab_harbor")!.scheduledFor);
  void close;
});

test("cooling periods (10/6): out of the sequence until the date, back in on their own after, or put back by hand", async () => {
  const { holdAccount, coolingFor, forecast } = await import("../src/automations.js");
  const { close, d } = setup("user_cooling");
  const crest = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Crest Mechanical")!;
  const r = await holdAccount(d, crest.leadId, true, { days: 30, why: "asked for fewer emails" });
  assert.ok(r.until && new Date(r.until).getTime() > Date.now() + 29 * 86400e3);
  assert.equal((await coolingFor(d, crest.leadId))?.why, "asked for fewer emails");
  assert.ok((await forecast(d)).find((f) => f.leadId === crest.leadId)?.held, "held on the Coming up page");
  assert.ok(close.writes.some((w) => w.op === "note" && /\[Cooling\] Out of the automatic emails until/.test((w.body as { note: string }).note)), "written to the lead in Close");
  await setAutomations(d, true);
  assert.ok(!(await planBumps(d)).planned.some((p) => p.leadId === crest.leadId), "not planned while cooling");
  // Thirty-one days on: back in by itself.
  const later: Deps = { ...d, now: () => new Date(Date.now() + 31 * 86400e3) };
  assert.equal(await coolingFor(later, crest.leadId), null);
  // Or put back by hand.
  await holdAccount(d, crest.leadId, false);
  assert.equal(await coolingFor(d, crest.leadId), null);
  assert.ok(close.writes.some((w) => w.op === "note" && /Back in the automatic emails/.test((w.body as { note: string }).note)));
});

test("never two in a day (10/8): two morning plans at once write one wave, and a same-day second email is pulled before it sends", async () => {
  const { close, d } = setup("user_twice");
  await setAutomations(d, true);
  // Two server copies planning the same morning, at the same moment (the hosted one and the Mac one, 10/8).
  const at = { ...d, now: () => new Date("2026-10-08T14:05:00Z") }; // Thursday 7:05am Pacific
  process.env.PLAN_MORNING = "1";
  const [r1, r2] = await Promise.all([morningRun(at), morningRun(at)]);
  const planned = [...(r1?.planned ?? []), ...(r2?.planned ?? [])];
  const perLead = new Map<string, number>();
  for (const p of planned) perLead.set(p.leadId, (perLead.get(p.leadId) ?? 0) + 1);
  assert.ok(planned.length > 0, "one of them planned");
  assert.ok([...perLead.values()].every((n) => n === 1), `nobody planned twice: ${JSON.stringify([...perLead])}`);
  assert.ok(!r1 || !r2 || !r1.planned.length || !r2.planned.length, "only one copy wrote the wave");
  // And if a second one slips in anyway, the pre-send check pulls the later one.
  const [c] = planned;
  const dupAt = new Date(new Date(c.scheduledFor!).getTime() + 4 * 60_000).toISOString();
  close.writes.push({ op: "email", id: "acti_dup_same_day", body: { leadId: c.leadId, to: [c.to], subject: c.subject, body: "x", scheduleAt: dupAt } } as never);
  await store.putAutomation({ ...c, id: "acti_dup_same_day", scheduledFor: dupAt, createdAt: new Date().toISOString(), checkedAt: null });
  await syncAutomations({ ...d, now: () => new Date(new Date(c.scheduledFor!).getTime() - 20 * 60_000) });
  const view = await automationsView(d);
  assert.equal(view.other.find((x) => x.id === "acti_dup_same_day")?.status, "stopped", "the later one is pulled back");
  assert.ok(view.upcoming.some((x) => x.id === c.id), "the first one still goes");
  delete process.env.PLAN_MORNING;
});

test("any reply cools the automatic emails for 1.5 weeks (10/12: \"nothing yet\" replies)", async () => {
  const { repliedRecently, REPLY_COOLDOWN_DAYS } = await import("../src/automations.js");
  const now = new Date("2026-10-12T16:00:00Z");
  assert.equal(REPLY_COOLDOWN_DAYS, 10.5);
  assert.equal(repliedRecently({ lastReplyAt: "2026-10-12T11:37:00Z" }, now), true, "\"Nothing yet\" this morning");
  assert.equal(repliedRecently({ lastReplyAt: "2026-10-03T16:00:00Z" }, now), true, "9 days ago: still cooling");
  assert.equal(repliedRecently({ lastReplyAt: "2026-10-01T03:00:00Z" }, now), false, "11+ days ago: back in");
  assert.equal(repliedRecently({ lastReplyAt: null }, now), false);
});

test("the bump fits the day it goes out (10/12: \"hope your week's going good\" on a Monday)", async () => {
  const { fitDay } = await import("../src/followup.js");
  const line = "Hope your week's going good! I'd love the chance to work with you guys. Got any RFQs I can take a crack at?";
  assert.match(fitDay(line, 1), /^Hope your week's off to a good start!/, "Monday");
  assert.match(fitDay(line, 3), /^Hope your week's going good!/, "Wednesday");
  assert.match(fitDay(line, 5), /^Happy Friday!/, "Friday");
  assert.doesNotMatch(fitDay("Happy Friday! Before the weekend hits, got any RFQs I can take a look at?", 2), /Friday|weekend/, "never a Friday line midweek");
  const mine = "I hope your week's going good! Please send me over an RFQ and we'll get you a quote back.";
  assert.match(fitDay(mine, 1), /^I hope your week's off to a good start!/, "the 10/12 line, Monday");
  assert.match(fitDay(mine, 5), /^Happy Friday! Please send/, "the 10/12 line, Friday");
});

test("the sequence (10/12): talked track 3 intro emails, cold track 2, then the rhythm by tier, a call flag, and monthly after 6 quiet", async () => {
  const { cadenceFor, isGenericAddress } = await import("../src/cadence.js");
  const talked = (nth: number, more = {}) => cadenceFor({ track: "talked", round: 1, nth, ...more });
  assert.deepEqual([0, 1, 2].map((n) => talked(n).gap), [1, 3, 5], "next morning, +3, +5");
  assert.ok([0, 1, 2].every((n) => talked(n).phase === "intro" && !talked(n).callFlag));
  assert.equal(talked(3).phase, "rhythm");
  assert.equal(talked(3).callFlag, true, "intro done: call them");
  assert.equal(talked(3, { tier: "steady" }).gap, 3);
  assert.equal(talked(3, { tier: "project" }).gap, 5);
  assert.equal(talked(3, { tier: "occasional" }).gap, 15);
  assert.equal(talked(3, { tier: "steady", generic: true }).gap, 5, "a shared mailbox is weekly at most");
  assert.equal(talked(6).phase, "monthly");
  assert.equal(talked(6).gap, 20);
  assert.equal(talked(6, { heardBack: true }).phase, "rhythm", "they replied or clicked: not monthly");
  const cold = (nth: number, more = {}) => cadenceFor({ track: "cold", round: 1, nth, ...more });
  assert.deepEqual([0, 1].map((n) => cold(n).gap), [2, 5]);
  assert.equal(cold(2).callFlag, true, "after 2: call the main line and ask for them");
  assert.equal(cold(2, { tier: "steady" }).gap, 5, "never talked: weekly at most");
  assert.equal(isGenericAddress("info@acme.com"), true);
  assert.equal(isGenericAddress("estimating@acme.com"), true);
  assert.equal(isGenericAddress("mike.jones@acme.com"), false);
});

test("a click on the line card or site link (10/12): a call today, no automatic email for 3 business days; a mail scanner doesn't count", async () => {
  const { trackMeme, logLinkClick, clicksFor, newToken } = await import("../src/memes.js");
  const { close, d } = setup("user_click");
  void close;
  await setAutomations(d, true);
  const crest = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.company === "Crest Mechanical")!;
  const token = newToken();
  await trackMeme({ token, repId: d.rep.closeUserId, repName: "Walt Boxwell", repEmail: "walt@westgatesupply.com", leadId: crest.leadId, meme: "", emailId: "acti_x" });
  // A link scanner follows it first: logged on the email, not on the account.
  await logLinkClick(token, "card", "Mozilla/5.0 (compatible; Proofpoint URL Defense)");
  assert.equal((await clicksFor(d.rep.closeUserId))[crest.leadId], undefined);
  await logLinkClick(token, "card", "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0");
  assert.ok((await clicksFor(d.rep.closeUserId))[crest.leadId], "a person's click is on the account");
  const after = (await accountsBoard(d, { fresh: true })).accounts.find((a) => a.leadId === crest.leadId)!;
  assert.equal(after.next.tag, "Call");
  assert.match(after.next.label, /clicked your email/);
  assert.equal(after.section, "hot");
  assert.equal(after.bumpDue, false, "no email while it's a call");
  const r = await planBumps(d);
  assert.ok(!r.planned.some((p) => p.leadId === crest.leadId), "not emailed the day they click");
});

test("nobody goes 3 business days without a touch (10/12): quiet accounts with no email due are on the call list, in priority order, no cap", async () => {
  const { d } = setup("user_touch");
  const board = await accountsBoard(d, { fresh: true });
  const calls = board.accounts.filter((a) => a.next.kind === "bump" && a.next.tag === "Call");
  for (const a of calls) {
    assert.ok(a.callAsk, `${a.company} has the reason it's a call`);
    if (a.callAsk!.kind === "touch") {
      assert.equal(a.bumpDue, false, "a touch call only when no email is due today");
      assert.match(a.next.label, /business days quiet/);
    }
  }
  const ranks = calls.map((a) => a.callAsk!.rank).sort((x, y) => x - y);
  assert.deepEqual(ranks, ranks.map((_, i) => i), "every call is ranked, none dropped");
});

test("next email in N days (10/12): nothing goes before that morning, and anything already queued sooner is pulled back", async () => {
  const { setNextEmail } = await import("../src/automations.js");
  const { close, d } = setup("user_nextmail");
  await setAutomations(d, true);
  const [first] = (await planBumps(d)).planned;
  assert.ok(first, "something was planned");
  const r = await setNextEmail(d, first.leadId, 7);
  assert.ok(r.nextEmailAt > new Date(Date.now() + 6 * 86400e3).toISOString());
  assert.ok(close.writes.some((w) => w.op === "unschedule" && (w.body as { id: string }).id === first.id), "the queued one is pulled back");
  const a = (await accountsBoard(d, { fresh: true })).accounts.find((x) => x.leadId === first.leadId)!;
  assert.equal(a.bumpDue, false);
  assert.equal(a.cadence.nextEmailAt, r.nextEmailAt);
});

test("at most 80 emails a day (10/12): the forecast slides the overflow to the next morning", async () => {
  const { DAILY_CAP, forecast } = await import("../src/automations.js");
  assert.equal(DAILY_CAP, 80);
  const { d } = setup("user_cap80");
  const f = await forecast(d);
  const perDay = new Map<string, number>();
  for (const x of f) perDay.set(x.sendOn.slice(0, 10), (perDay.get(x.sendOn.slice(0, 10)) ?? 0) + 1);
  for (const [day, n] of perDay) assert.ok(n <= DAILY_CAP, `${day}: ${n}`);
});

test("Hijack (10/28): the account leaves a teammate's automatic emails and its Lead owner becomes you", async () => {
  const { hijackAccount, sequencesWith, forecast } = await import("../src/automations.js");
  const { close, d: walt } = setup("user_hj_walt");
  walt.rep = { ...walt.rep, name: "Walt Boxwell", email: "walt@westgatesupply.com" };
  const chase: Deps = { close: new FakeClose(), llm: demoLlm, rep: { ...rep, closeUserId: "user_hj_chase", name: "Chase Bent", email: "chase@westgatesupply.com" } };
  const crest = (await accountsBoard(walt, { fresh: true })).accounts.find((a) => a.company === "Crest Mechanical")!;
  await store.putAutomation({ id: "acti_hj_bump", repId: walt.rep.closeUserId, leadId: crest.leadId, company: crest.company, to: crest.contact.email!, subject: "Re: x", kind: "bump", label: "", reason: "", scheduledFor: new Date(Date.now() + 3600e3).toISOString(), createdAt: new Date().toISOString(), status: "scheduled", statusAt: null, note: null, checkedAt: null });

  await store.putSetting(walt.rep.closeUserId, "cooling", {}); // the store outlives a test run
  await store.putSetting("team", "leadOwnerFieldId", "cf_hj_owner"); // the Lead owner field, whatever other tests left
  assert.deepEqual((await sequencesWith([walt], crest.leadId)).map((x) => x.name), ["Walt Boxwell"], "Crest is in Walt's emails");
  const r = await hijackAccount([walt], chase, crest.leadId);
  assert.deepEqual(r.from.map((x) => x.name), ["Walt Boxwell"]);
  assert.equal((await forecast(walt)).find((x) => x.leadId === crest.leadId)?.held, true, "out of Walt's emails for good");
  assert.equal((await store.listAutomations(walt.rep.closeUserId, new Date(Date.now() - 86400e3).toISOString())).find((a) => a.id === "acti_hj_bump")?.status, "stopped", "the scheduled bump is pulled back");
  assert.deepEqual(await sequencesWith([walt], crest.leadId), [], "nobody's sequence has it now");
  assert.equal((chase.close as FakeClose).leadFields_[crest.leadId]?.["custom.cf_hj_owner"], "user_hj_chase", "Lead owner in Close is Chase");
  assert.ok(close.writes.some((w) => w.op === "note" && /\[Cooling\].*Chase took this account over/.test(String((w.body as { note: string }).note))), "Walt's lead says why");
});
