import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps, Llm } from "../src/assistant.js";
import { transcriptText } from "../src/close.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import { listQueue, quickOutcome, type QueueItem } from "../src/queue.js";
import { EmailReviewSchema, isSelfTest, reviewTask } from "../src/validate.js";

// Walt 9/26: a test call "did nothing". It had written a note and a task, but the email draft was
// blocked and the only trace was a warning nobody saw. The rule now: every call that enters the
// pipeline leaves at least one visible card in the queue, with a result or an error. Never silent.

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles", sender: '"Walt Boxwell" <walt@westgatesupply.com>', emailAccountId: "emailacct_demo" };
const settle = async (d: Deps) => {
  for (let i = 0; i < 200 && (await listQueue(d)).some((x) => x.state === "building"); i++) await new Promise((r) => setTimeout(r, 25));
  return listQueue(d);
};
const visible = (it: QueueItem) => Boolean(it.summary || it.error || it.alerts?.length);

test("every call that enters the pipeline leaves a visible card: a result or an error", async () => {
  const cases: Array<{ name: string; close: FakeClose; llm?: Llm; callId: string; expect: (it: QueueItem, c: FakeClose) => void }> = [];

  // 1. Under 20 seconds: no transcript wait, the dial is logged, nothing is built or written by the pipeline.
  const short = new FakeClose({ calls: [roddaCall({ id: "acti_short12", duration: 12, recording_transcript: null })] });
  cases.push({ name: "12s call", close: short, callId: "acti_short12", expect: (it, c) => {
    assert.equal(it.state, "done");
    assert.equal(it.dialOnly, true);
    assert.match(it.summary!, /^12-second call: too short for a transcript/);
    assert.ok(!c.writes.some((w) => w.op === "note" || w.op === "email"), "no note or email from a 12s call");
  } });

  // 2. A real conversation Close never transcribed: hard stop, a "No transcript" card with Rebuild.
  const noTx = new FakeClose({ calls: [roddaCall({ id: "acti_noTx38", duration: 38, recording_transcript: null })] });
  cases.push({ name: "no transcript", close: noTx, callId: "acti_noTx38", expect: (it) => {
    assert.equal(it.state, "failed");
    assert.match(it.error!, /^No transcript for this call/);
  } });

  // 3. A normal call: saved to Close, with a summary.
  const ok = new FakeClose({ calls: [roddaCall({ id: "acti_ok" })] });
  cases.push({ name: "normal", close: ok, callId: "acti_ok", expect: (it) => {
    assert.equal(it.state, "saved");
    assert.ok(it.summary);
  } });

  // 4. The email draft is blocked by the pre-save checks: the card says so, in an alert.
  const blocked = new FakeClose({ calls: [roddaCall({ id: "acti_blocked" })] });
  const refuse: Llm = (async (opts: Parameters<Llm>[0]) => opts.schema === EmailReviewSchema
    ? { data: { failures: [{ rule: "names", sentence: "Hi Rob,", problem: "Wrong name." }] }, usage: {} }
    : demoLlm(opts as never)) as Llm;
  cases.push({ name: "draft blocked", close: blocked, llm: refuse, callId: "acti_blocked", expect: (it) => {
    assert.ok(it.alerts!.some((a) => a.level === "warn" && /^No email draft saved/.test(a.text)), JSON.stringify(it.alerts));
  } });

  // 5. Close rejects a write: a red alert with Close's error text.
  class FailingClose extends FakeClose {
    override async createNote(): Promise<{ id: string }> { throw new Error("Close 400: note too long"); }
  }
  const failing = new FailingClose({ calls: [roddaCall({ id: "acti_closeErr" })] });
  cases.push({ name: "Close error", close: failing, callId: "acti_closeErr", expect: (it) => {
    assert.ok(it.alerts!.some((a) => a.level === "error" && /Close rejected .*note too long/.test(a.text)), JSON.stringify(it.alerts));
  } });

  for (const [i, c] of cases.entries()) {
    const d: Deps = { close: c.close, llm: c.llm ?? demoLlm, rep: { ...rep, closeUserId: `user_pipe${i}` } };
    await quickOutcome(d, DEMO_LEAD_ID, { outcome: "reached_buyer", call_id: c.callId, rating: "B" });
    const items = await settle(d);
    assert.equal(items.length, 1, `${c.name}: one card`);
    assert.ok(visible(items[0]), `${c.name}: the card shows a result or an error`);
    c.expect(items[0], c.close);
  }
});

test("transcripts where both sides have the same name are labeled Rep and Prospect", () => {
  const t = transcriptText({ utterances: [
    { speaker_label: "Walt Boxwell", speaker_side: "close-user", start: 0, text: "Any RFQs I can look at?" },
    { speaker_label: "Walt Boxwell", speaker_side: "contact", start: 16, text: "I don't currently right now." },
  ] })!;
  assert.match(t, /^Rep \(Walt Boxwell\) @ 0:00: Any RFQs/);
  assert.match(t, /\nProspect @ 0:16: I don't currently/);
  // Normal calls keep their names.
  assert.match(transcriptText({ utterances: [{ speaker_label: "Main Office", speaker_side: "contact", start: 0, text: "Hi" }] })!, /^Main Office @/);
});

test("a self-test email (to the rep's own name or a Westgate address) isn't flagged for that", () => {
  const email = { to: [{ name: "Walt Boxwell", email: "waltboxwell@gmail.com" }], subject: "Westgate Supply – line card", body: "Hi Walt,", attach_line_card: true, address_as_heard: null } as never;
  assert.ok(isSelfTest(email, "Walt Boxwell"));
  assert.match(reviewTask(email, "Walt Boxwell"), /This is a TEST/);
  const real = { to: [{ name: "Tammy Kafton", email: "tammy@sbimfg.com" }], subject: "x", body: "Hi Tammy,", attach_line_card: true, address_as_heard: null } as never;
  assert.ok(!isSelfTest(real, "Walt Boxwell"));
  assert.doesNotMatch(reviewTask(real, "Walt Boxwell"), /TEST/);
});

test("a task that lands on a weekend moves to Monday, same time, and says so", async () => {
  const { sanitizeProposals } = await import("../src/assistant.js");
  const { loadLeadContext } = await import("../src/context.js");
  const close = new FakeClose({ calls: [roddaCall()] });
  const ctx = await loadLeadContext(close as never, DEMO_LEAD_ID, new Date("2026-09-26T18:00:00Z"));
  const tz = ctx.facts.prospectTz!;
  const warnings: string[] = [];
  const p = sanitizeProposals({ note: null, contacts: [], contact_updates: [], status: null, email: null, tasks: [{
    due_at: "2026-10-17T10:00:00-07:00", title: "Check in with Walt", ask_for: "Walt Boxwell", phone: null, email: null, why: null, deadline: null, pitch: "", details: "",
  }] } as never, ctx, warnings, new Date("2026-09-26T18:00:00Z"));
  const { localParts } = await import("../src/rules.js");
  assert.equal(localParts(new Date(p.tasks[0].due_at), tz).weekday, 1, "Monday");
  assert.equal(new Date(p.tasks[0].due_at).getTime() - new Date("2026-10-17T10:00:00-07:00").getTime(), 2 * 24 * 3600 * 1000, "Saturday → Monday, same time");
  assert.ok(warnings.some((w) => /^Moved the task for Walt Boxwell .*weekend/.test(w)), JSON.stringify(warnings));
});

test("send line card now: ready on the call screen, sent once to the address you confirm, and the after-call step doesn't draft a second one", async () => {
  const { lineCardFor, sendLineCard } = await import("../src/linecard.js");
  const close = new FakeClose({ calls: [roddaCall({ id: "acti_lcNow" })] });
  const d: Deps = { close, llm: demoLlm, rep: { ...rep, closeUserId: "user_lcNow" } };
  const pre = await lineCardFor(d, DEMO_LEAD_ID, { askFor: "Rob", buys: ["Threaded rod", "Anchors", "Beam clamps"] });
  assert.equal(pre.to, "", "no email on file for Rob yet: you type the one they give you");
  assert.match(pre.body, /^Hi Rob,\n\nGreat talking just now\. Here's our line card \(attached\), as promised\./);
  assert.match(pre.body, /threaded rod, anchors and beam clamps/);
  assert.match(pre.body, /Mind replying "got it"/);
  assert.doesNotMatch(pre.body, /[—–]/);
  assert.equal(pre.subject, "Westgate Supply – line card");

  await assert.rejects(sendLineCard(d, DEMO_LEAD_ID, { to: "not an email" }), /doesn't look like an email/);
  const r = await sendLineCard(d, DEMO_LEAD_ID, { to: "renee@roddaelectric.com", askFor: "Rob" });
  assert.equal(r.to, "renee@roddaelectric.com", "the address given on the call wins");
  const draft = close.writes.filter((w) => w.op === "email").pop()!.body as { to: string[]; attachments: Array<{ filename: string }> };
  assert.deepEqual(draft.to, ["renee@roddaelectric.com"]);
  assert.equal(draft.attachments[0].filename, "Westgate_Supply_Line_Card.pdf");
  assert.equal(close.writes.filter((w) => w.op === "send").length, 1);

  // Already emailed them: the next one is a reply in that thread, says "resending", and flags the earlier send.
  const close2 = new FakeClose({ calls: [roddaCall({ id: "acti_lcAgain" })] });
  close2.sentWithOpens = [{ id: "acti_firstCard", thread_id: "thread_first", status: "sent", direction: "outgoing", subject: "Great talking with you – Westgate Supply line card", date_sent: "2026-09-26T01:34:00Z", to: ["rob.roy@gmail.com"], opens: [{ opened_at: "2026-09-26T01:34:07Z", opened_by: "rob.roy@gmail.com", user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36" }], attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }] } as never];
  const d2: Deps = { ...d, close: close2 };
  const again = await lineCardFor(d2, DEMO_LEAD_ID, { to: "rob.roy@gmail.com" });
  assert.equal(again.subject, "Re: Great talking with you – Westgate Supply line card");
  assert.equal(again.reply!.id, "acti_firstCard");
  assert.deepEqual(again.alreadySent, { at: "2026-09-26T01:34:00Z", opened: false }, "only their spam filter touched it");
  assert.match(again.body, /^Hi Rob!\n\nJust bumping this back to the top of your inbox\. The line card is in my email below\./);
  assert.equal(again.attach, false);
  const sentAgain = await sendLineCard(d2, DEMO_LEAD_ID, { to: "rob.roy@gmail.com" });
  assert.equal(sentAgain.threaded, true);
  const reply = close2.writes.filter((w) => w.op === "email").pop()!.body as { inReplyToId: string; threadId: string; attachments?: unknown[] };
  assert.equal((reply.attachments ?? []).length, 0, "the bump has no attachment");
  assert.equal(reply.inReplyToId, "acti_firstCard");
  assert.equal(reply.threadId, "thread_first");

  // The after-call build sees the line card went out during the call and skips its own draft, visibly.
  close.sentWithOpens = [{ id: r.id, status: "sent", direction: "outgoing", subject: "Westgate Supply – line card", date_sent: new Date().toISOString(), opens: [], to: ["renee@roddaelectric.com"], attachments: [{ filename: "Westgate_Supply_Line_Card.pdf" }] } as never];
  const before = close.writes.filter((w) => w.op === "email").length;
  await quickOutcome(d, DEMO_LEAD_ID, { outcome: "reached_buyer", call_id: "acti_lcNow", rating: "B" });
  const [it] = await settle(d);
  assert.equal(close.writes.filter((w) => w.op === "email").length, before, "no second line card draft");
  assert.ok(it.alerts!.some((a) => /Skipped the email draft: you sent the line card during the call/.test(a.text)), JSON.stringify(it.alerts));
});

test("greeting from an email address only when it's clearly a first name", async () => {
  const { nameFromEmail } = await import("../src/linecard.js");
  assert.equal(nameFromEmail("renee.smith@x.com"), "Renee");
  assert.equal(nameFromEmail("tammy@sbimfg.com"), "Tammy");
  assert.equal(nameFromEmail("waltboxwell@gmail.com"), null);
  assert.equal(nameFromEmail("jkristo@southshorecontrols.com"), null);
  assert.equal(nameFromEmail("cmoreno@titanmf.com"), null);
  assert.equal(nameFromEmail("purchasing@samjackson.com"), null);
});
