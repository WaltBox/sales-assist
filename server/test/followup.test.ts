import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps, Llm } from "../src/assistant.js";
import type { LeadEmail } from "../src/close.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import { businessDaysBetween, FollowUpError, writeFollowUp } from "../src/followup.js";
import { FollowUpSchema } from "../src/schemas.js";

const NOW = new Date("2026-09-23T21:31:00Z"); // Wed 2:31 PM Pacific
const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles", sender: '"Walt Boxwell" <walt@westgatesupply.com>', emailAccountId: "emailacct_demo" };
const deps = (close: FakeClose, llm: Llm = demoLlm): Deps => ({ close, llm, rep, now: () => NOW });

const lineCard = (over: Partial<LeadEmail> = {}): LeadEmail => ({
  id: "acti_email_linecard", status: "sent", direction: "outgoing",
  subject: "Great talking with you – Westgate Supply line card",
  date_sent: "2026-09-16T17:00:00Z", opens: null, thread_id: "thr_1",
  sender: "Walt Boxwell <walt@westgatesupply.com>", to: ["renee@roddaelectric.com"],
  body_text: "Hi Renee,\n\nThanks for taking my call. I've attached our line card...", ...over,
});
const draftOf = (close: FakeClose) => close.writes.find((w) => w.op === "email")?.body as Record<string, unknown> | undefined;

/** Demo LLM, except the follow-up body comes from `bodies` in order. */
function bodies(...list: string[]): { llm: Llm; calls: () => number } {
  let n = 0;
  const llm = (async (opts: { schema: unknown }) => {
    if (opts.schema !== FollowUpSchema) return demoLlm(opts as never);
    const body = list[Math.min(n++, list.length - 1)];
    return { data: { situation: "line_card_no_reply", last_touch: "tried you this morning", body }, usage: {} };
  }) as Llm;
  return { llm, calls: () => n };
}

test("business days skip weekends", () => {
  assert.equal(businessDaysBetween(new Date("2026-09-18T17:00:00Z"), new Date("2026-09-21T17:00:00Z"), "America/Los_Angeles"), 1); // Fri → Mon
  assert.equal(businessDaysBetween(new Date("2026-09-23T15:00:00Z"), NOW, "America/Los_Angeles"), 0);
});

test("with a prior email, the follow-up is a short reply in that thread, with no attachment", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  close.sentWithOpens = [
    lineCard(),
    lineCard({ id: "acti_old_draft", status: "draft", date_sent: null, date_created: "2026-09-23T20:00:00Z", thread_id: "thr_draft" }),
  ];
  const r = await writeFollowUp(deps(close), DEMO_LEAD_ID);
  assert.equal(r.status, "drafted");
  const d = draftOf(close)!;
  assert.equal(d.inReplyToId, "acti_email_linecard"); // the newest real email, not the unsent draft
  assert.equal(d.threadId, "thr_1");
  assert.equal(d.subject, "Re: Great talking with you – Westgate Supply line card");
  assert.deepEqual(d.to, ["renee@roddaelectric.com"]);
  assert.ok(!(d.attachments as unknown[] | undefined)?.length);
  assert.match(String(d.body), /^Hi Renee!\n\nJust bumping this back to the top of your inbox\.[\s\S]*\n\nWalt Boxwell$/);
  assert.doesNotMatch(String(d.body), /[—–]/);
  assert.equal(close.writes.filter((w) => w.op === "email").length, 1);
});

test("a reply already Re: keeps one Re:, and a prospect's reply is what we answer", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  close.sentWithOpens = [
    lineCard(),
    lineCard({ id: "acti_their_reply", direction: "incoming", subject: "RE: Great talking with you – Westgate Supply line card", date_sent: "2026-09-17T15:00:00Z", sender: "Renee <renee@roddaelectric.com>", to: ["walt@westgatesupply.com"] }),
  ];
  await writeFollowUp(deps(close), DEMO_LEAD_ID);
  const d = draftOf(close)!;
  assert.equal(d.inReplyToId, "acti_their_reply");
  assert.equal(d.subject, "Re: Great talking with you – Westgate Supply line card");
  assert.deepEqual(d.to, ["renee@roddaelectric.com"]);
});

test("emailed under 3 business days ago with no reply or call since: warn first, draft on confirm", async () => {
  const close = new FakeClose({ calls: [] });
  close.sentWithOpens = [lineCard({ date_sent: "2026-09-22T17:00:00Z" })];
  const warn = await writeFollowUp(deps(close), DEMO_LEAD_ID);
  assert.deepEqual(warn, { status: "warn", warning: "You emailed them 1 business day ago with no reply or call since. Send anyway?" });
  assert.equal(draftOf(close), undefined);
  const r = await writeFollowUp(deps(close), DEMO_LEAD_ID, { force: true });
  assert.equal(r.status, "drafted");
});

test("with no prior email, a new thread goes out with the line card attached", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  close.lead_.contacts = [{ id: "cont_robroy", name: "Rob Roy", title: "Purchasing Manager", emails: [{ email: "rob@roddaelectric.com", type: "office" }], phones: [] }];
  const { llm } = bodies("Hi Rob,\n\nI've attached our line card. We cover the threaded rod, anchors and beam clamps your crews use. Whenever you've got something to price, just reply here.\n\nThanks, Rob!\n\nWalt Boxwell");
  const r = await writeFollowUp(deps(close, llm), DEMO_LEAD_ID);
  assert.equal(r.status === "drafted" && r.threaded, false);
  const d = draftOf(close)!;
  assert.ok(!d.inReplyToId);
  assert.ok(!d.threadId);
  assert.equal(d.subject, "Westgate Supply – line card");
  assert.equal((d.attachments as unknown[]).length, 1);
});

test("a follow-up over 4 sentences is rewritten", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  close.sentWithOpens = [lineCard()];
  const long = "Hi Renee,\n\nJust checking in. We supply threaded rod. And anchors. And beam clamps. We ship fast. Reply here.\n\nThanks, Renee!\n\nWalt Boxwell";
  const short = "Hi Renee,\n\nJust floating this back up. Whenever you've got something to price, just reply here.\n\nThanks, Renee!\n\nWalt Boxwell";
  const { llm, calls } = bodies(long, short);
  await writeFollowUp(deps(close, llm), DEMO_LEAD_ID);
  assert.equal(calls(), 2);
  assert.equal(draftOf(close)!.body, short);
});

test("never drafts to a vendor", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  close.lead_.status_label = "Vendor";
  close.sentWithOpens = [lineCard()];
  await assert.rejects(writeFollowUp(deps(close), DEMO_LEAD_ID), FollowUpError);
  assert.equal(draftOf(close), undefined);
});
