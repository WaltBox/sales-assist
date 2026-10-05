import assert from "node:assert/strict";
import { enforceGotIt } from "../src/benchmark.js";
import { test } from "node:test";
import { afterCallExtras, applyProposals, leadChat, type Deps, type Llm } from "../src/assistant.js";
import type { CloseClient } from "../src/close.js";
import { loadLeadContext } from "../src/context.js";
import { demoLlm, demoProposals, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import { AfterCallExtrasSchema, ChatSchema, type Proposals } from "../src/schemas.js";
import { EmailReviewSchema, rejections, resetRejections, ruleChecks, type Referral } from "../src/validate.js";

const NOW = new Date("2026-09-23T21:31:00Z");
const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles", sender: '"Walt Boxwell" <walt@westgatesupply.com>', emailAccountId: "emailacct_demo" };
const deps = (close: FakeClose, llm: Llm = demoLlm): Deps => ({ close, llm, rep, now: () => NOW });
const ctx = () => loadLeadContext(new FakeClose({ calls: [roddaCall()] }) as unknown as CloseClient, DEMO_LEAD_ID, NOW);
const TRANSCRIPT = "Renee here, Rob's out until the 12th.";

type Email = NonNullable<Proposals["email"]>;
const good = (): Email => demoProposals().email!;
const withBody = (body: string, to = good().to): Email => ({ ...good(), to, body });
const rules = async (e: Email) => ruleChecks(e, await ctx(), TRANSCRIPT, "Walt Boxwell").map((f) => f.rule);

test("identity: Westgate is never the company Walt called", async () => {
  for (const bad of [
    "I called Westgate this morning about your order.",
    "I just spoke with Westgate and they can help.",
    "I reached out to Westgate Supply on your behalf.",
    "I've contacted the team at Westgate.",
    "At Westgate I can get you pricing fast.",
    "I'm a customer of Westgate Supply.",
  ]) assert.deepEqual(await rules(withBody(`Hi Rob,\n\n${bad}\n\nWalt Boxwell`)), ["identity"], bad);
  for (const ok of ["I'm Walt with Westgate Supply.", "Walt with Westgate Supply here.", "I was calling from Westgate Supply today."]) {
    assert.deepEqual(await rules(withBody(`Hi Rob,\n\n${ok}\n\nWalt Boxwell`)), [], ok);
  }
});

test("names: greeting, recipient, and the person Walt spoke with match the record and aren't swapped", async () => {
  assert.deepEqual(await rules(good()), []);
  // Addressed to Rob but greets Renee (the gatekeeper).
  assert.deepEqual(await rules(withBody("Hi Renee,\n\nThanks for the call.\n\nWalt Boxwell")), ["names"]);
  // Greets Rob and says Walt spoke with Rob, when Renee was on the call.
  assert.ok((await rules(withBody("Hi Rob,\n\nI spoke with Rob this afternoon.\n\nWalt Boxwell"))).includes("names"));
  // A name that's nowhere on the lead or the call.
  assert.ok((await rules(withBody("Hi Rob,\n\nI spoke with Karen this afternoon.\n\nWalt Boxwell"))).includes("names"));
  assert.ok((await rules(withBody("Hi Karen,\n\nThanks.\n\nWalt Boxwell", [{ name: "Karen", email: "k@x.com" }]))).includes("names"));
});

test("dashes fail the checks", async () => {
  assert.deepEqual(await rules(withBody("Hi Rob,\n\nWe cover bolting — and more.\n\nWalt Boxwell")), ["dashes"]);
});

/** An LLM stub: emails come from `drafts` in order; the reviewer's verdicts from `reviews`. */
function scripted(drafts: Email[], reviews: Array<Array<{ rule: string; sentence: string | null; problem: string }>> = []) {
  const tasks: string[] = [];
  let e = 0, r = 0;
  const llm = (async (opts: { schema: unknown; task: string }) => {
    tasks.push(opts.task);
    if (opts.schema === AfterCallExtrasSchema) return { data: { email: drafts[Math.min(e++, drafts.length - 1)], coaching: { nice: null, next: null } }, usage: {} };
    if (opts.schema === EmailReviewSchema) return { data: { failures: reviews[r++] ?? [] }, usage: {} };
    if (opts.schema === ChatSchema) return { data: { reply: "ok", proposals: { ...demoProposals(), email: drafts[Math.min(e++, drafts.length - 1)] } }, usage: {} };
    return demoLlm(opts as never);
  }) as Llm;
  return { llm, tasks };
}

test("a failing draft is regenerated with the reasons, and the rejection is logged", async () => {
  resetRejections();
  const bad = withBody("Hi Rob,\n\nI called Westgate this afternoon and Renee said to reach out.\n\nWalt Boxwell");
  const { llm, tasks } = scripted([bad, good()]);
  const x = await afterCallExtras(deps(new FakeClose({ calls: [roddaCall()] }), llm), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001", force: true });
  assert.equal(x.email!.body, enforceGotIt(good()).body);
  const retry = tasks.filter((t) => t.includes("rejected by the pre-save checks"));
  assert.equal(retry.length, 1);
  assert.match(retry[0], /\[identity\]/);
  const log = (await rejections()).items;
  assert.equal(log.length, 1);
  assert.equal(log[0].failures[0].rule, "identity");
  assert.equal(log[0].attempt, 1);
});

test("the reviewing model's who-said-what and read-back findings also force a rewrite", async () => {
  resetRejections();
  const { llm } = scripted([good(), good()], [[{ rule: "who_said_what", sentence: "They buy daily.", problem: "Not in the transcript." }], []]);
  const x = await afterCallExtras(deps(new FakeClose({ calls: [roddaCall()] }), llm), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001", force: true });
  assert.ok(x.email);
  assert.deepEqual((await rejections()).byRule, { who_said_what: 1 });
});

test("after 3 failures no draft is saved", async () => {
  resetRejections();
  const bad = withBody("Hi Renee,\n\nThanks.\n\nWalt Boxwell");
  const { llm } = scripted([bad]);
  const x = await afterCallExtras(deps(new FakeClose({ calls: [roddaCall()] }), llm), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001", force: true });
  assert.equal(x.email, null);
  assert.match(x.warnings[0], /No email draft saved: it failed the pre-save checks 3 times \(names\)/);
  const log = (await rejections()).items;
  assert.deepEqual(log.map((l) => [l.attempt, l.final]), [[3, true], [2, false], [1, false]]);
});

test("the save step refuses a failing draft, however it got there", async () => {
  resetRejections();
  const close = new FakeClose({ calls: [roddaCall()] });
  const p: Proposals = { note: null, contacts: [], contact_updates: [], tasks: [], status: null, email: withBody("Hi Rob,\n\nI spoke with Westgate today.\n\nWalt Boxwell") };
  const r = await applyProposals(deps(close), DEMO_LEAD_ID, p, "B");
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error!, /Not saved, it failed the pre-save checks/);
  assert.equal(close.writes.filter((w) => w.op === "email").length, 0);
  assert.equal((await rejections()).items.length, 1);
});

test("chat: a failing rewrite is retried once, then the previous draft is kept", async () => {
  resetRejections();
  const bad = withBody("Hi Renee,\n\nThanks.\n\nWalt Boxwell");
  const { llm } = scripted([bad]);
  const current = { ...demoProposals(), email: good() };
  const r = await leadChat(deps(new FakeClose({ calls: [roddaCall()] }), llm), DEMO_LEAD_ID, { message: "make it warmer", history: [], proposals: current });
  assert.equal(r.proposals.email!.body, good().body);
  assert.match(r.warnings.join(" "), /Kept the previous email draft/);
  assert.equal((await rejections()).items.length, 2);
});

// ---------- cold intro via gatekeeper ----------

const PROBST = "Hi Tracy,\n\nI called in this afternoon and spoke with Hannah. She mentioned you're helping the project teams with vendors and pricing right now, so she pointed me your way.\n\nI'm Walt with Westgate Supply. We're a national industrial supplier of pipe, fittings, flanges, gaskets and bolting, and we do a lot of work with teams building and operating treatment plants. I've attached our line card so you can see the full range.\n\nIf any of your projects have an open RFQ or a materials list out for pricing, send it over and I'll quote it.\n\nHannah said you're back next week, so I'll give you a call then to introduce myself.\n\nHave a great rest of your day!\n\nWalt Boxwell";
const referral: Referral = { gatekeeper: "Hannah", recipient: "Tracy Reading", said_about_recipient: "helping the project teams with vendors and pricing", back_when: "next week" };
const HANNAH = "Hannah: Tracy Reading handles vendors, she's out until next week. tracy.reading@probstgroup.com";
const tracy = (body: string): Email => ({ to: [{ name: "Tracy Reading", email: "tracy.reading@probstgroup.com" }], subject: "Westgate Supply – line card", body, attach_line_card: true, address_as_heard: null });
const introRules = async (body: string, r = referral) => ruleChecks(tracy(body), await ctx(), HANNAH, "Walt Boxwell", { intro: r }).map((f) => f.problem);

test("cold intro: Walt's Probst example passes every check", async () => {
  assert.deepEqual(await introRules(PROBST), []);
  assert.deepEqual(await introRules(PROBST.replace("Hannah said you're back next week, so I'll give you a call then", "I'll give you a call in the next few days"), { ...referral, back_when: null }), []);
});

test("cold intro: implied history, RFQ pushes, the benchmark ask, missing parts, and length all fail", async () => {
  for (const [bad, why] of [
    [PROBST.replace("I called in this afternoon", "As we discussed, I called in this afternoon"), /already spoke with Walt/],
    [PROBST.replace("send it over and I'll quote it.", "send it over and I'll quote it. Whenever you've got an RFQ, reply here."), /already spoke with Walt/],
    [PROBST.replace("send it over and I'll quote it.", "send it over and I'll quote it. If you ever want to see how we stack up, send over a recent RFQ or PO and I'll price it, no strings."), /past RFQ/],
    [PROBST.replace("You mentioned", "x").replace("She mentioned you're", "You mentioned you're"), /already spoke with Walt/],
    [PROBST.replace(" I've attached our line card so you can see the full range.", ""), /line card so you can see the full range/],
    [PROBST.replace(" send it over and I'll quote it.", ""), /Missing the offer/],
    [PROBST.replace("Hannah said you're back next week, so I'll give you a call then to introduce myself.", "Talk soon."), /next touch/],
    [PROBST.replace("Hannah said you're back next week, so I'll give you a call then", "I'll give you a call in the next few days"), /back next week/],
    [PROBST.replace("I called in this afternoon and spoke with Hannah. She mentioned", "I heard"), /Doesn't open with who Walt spoke to/],
    [PROBST.replace("send it over and I'll quote it.", "send it over and I'll quote it. We stock a deep range of grades and finishes and ship fast from several locations nationwide.".repeat(2)), /under 130/],
  ] as Array<[string, RegExp]>) {
    assert.ok((await introRules(bad)).some((p) => why.test(p)), `${why}: ${await introRules(bad)}`);
  }
});

test("cold intro: the email step gets the standard, and the subject and line card are forced", async () => {
  const tasks: string[] = [];
  const llm = (async (opts: { schema: unknown; task: string }) => {
    tasks.push(opts.task);
    if (opts.schema === AfterCallExtrasSchema) return { data: { email: { ...tracy(PROBST), subject: "Hello", attach_line_card: false }, coaching: { nice: null, next: null } }, usage: {} };
    return demoLlm(opts as never);
  }) as Llm;
  const close = new FakeClose({ calls: [roddaCall({ recording_transcript: { utterances: [{ speaker_label: "Main Office", speaker_side: "contact", start: 0, text: HANNAH }] } as never })] });
  const x = await afterCallExtras(deps(close, llm), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001", force: true, referral });
  assert.equal(x.email!.subject, "Westgate Supply – line card");
  assert.equal(x.email!.attach_line_card, true);
  assert.equal(x.email!.body, PROBST);
  assert.match(tasks[0], /COLD INTRO VIA GATEKEEPER: Walt did not speak to Tracy Reading; Hannah gave/);
  assert.match(tasks[0], /Hannah said they're back next week/);
});

test("every email: hedging the ask fails and gets rewritten (Walt 9/28)", async () => {
  const c = await ctx();
  const hedging = async (line: string) =>
    ruleChecks(tracy(`Hi Tracy,\n\nI've attached our line card.\n\n${line}\n\nWalt Boxwell`), c, HANNAH, "Walt Boxwell").filter((f) => f.rule === "hedging");
  for (const line of [
    "If you ever want to see how we stack up, send over a recent RFQ or PO and I'll price it, no strings.",
    "No strings. When something comes up, send it over and I'll get quotes back to you fast.",
    "Totally optional, but send an old RFQ so you have a comparison on hand.",
    "If you're curious how our numbers compare, send a past PO. No pressure either way.",
    "Whenever anything comes up, just reply here.",
  ]) assert.equal((await hedging(line)).length > 0, true, line);
  // A plain ask is fine.
  for (const line of ["Send over a recent RFQ or PO and I'll price it.", "Reply here with your RFQ or list and I'll price it."]) {
    assert.deepEqual(await hedging(line), [], line);
  }
});

test("one-block emails get paragraphs: greeting, pitch, line card, got-it ask, call line, thanks, name (Anthony Labetti draft, 9/29)", async () => {
  const { formatParagraphs } = await import("../src/benchmark.js");
  const block = "Hi Anthony, I spoke with your office this afternoon and they suggested I reach out to you directly. I'm Walt with Westgate Supply. For facility maintenance work like yours we supply threaded rod, wedge anchors, self drilling screws, hot dip galvanized hardware, and pipe and beam clamps for your HVAC, plumbing, and structural crews. I've attached our line card so you can see the full range. If you've got a list or open RFQ for any upcoming work, just reply to this email with it and I'll get pricing turned around. Mind replying \"got it\" when this comes through? Just want to make sure it didn't land in junk. I'll give you a call soon to introduce myself. Thanks, Anthony.\n\nWalt Boxwell";
  const out = formatParagraphs(block);
  const paras = out.split("\n\n");
  assert.equal(paras[0], "Hi Anthony,");
  assert.match(paras[1], /^I spoke with your office.*structural crews\.$/);
  assert.match(paras[2], /^I've attached our line card.*turned around\.$/);
  assert.match(paras[3], /^Mind replying "got it".*land in junk\.$/);
  assert.equal(paras[4], "I'll give you a call soon to introduce myself.");
  assert.equal(paras[5], "Thanks, Anthony.");
  assert.equal(paras[6], "Walt Boxwell");
  assert.equal(formatParagraphs(block, "Walt Boxwell"), out);
  // Already in paragraphs: left alone.
  const good = "Hi Rob,\n\nHere's our line card.\n\nSend over an RFQ and I'll price it.\n\nWalt Boxwell";
  assert.equal(formatParagraphs(good, "Walt Boxwell"), good);
});

test("names come from the call, not the email domain: jacob@mcturk.net is Jacob, not Jacob McTurk (9/29)", async () => {
  const { unguessedName } = await import("../src/assistant.js");
  assert.equal(unguessedName("Jacob McTurk", "jacob@mcturk.net"), "Jacob");
  assert.equal(unguessedName("Jacob McTurk", "jacob@mcturkconstruction.com"), "Jacob");
  assert.equal(unguessedName("Renee Smith", "renee@roddaelectric.com"), "Renee Smith", "a real last name stays");
  assert.equal(unguessedName("Mykala", "mykala@threepeaksdrilling.com"), "Mykala");
});

test("the call screen's Say text is saved once per call, and kept out of what the AI reads (10/1)", async () => {
  const { saveSaid } = await import("../src/assistant.js");
  const writes: string[] = [];
  const d = { close: { createNote: async (_l: string, note: string) => { writes.push(note); return { id: "n" }; } } } as never;
  assert.deepEqual(await saveSaid(d, "lead_x", "Hi, this is Walt with Westgate Supply. We supply A325 bolts.", "acti_1"), { saved: true });
  assert.deepEqual(await saveSaid(d, "lead_x", "Hi, this is Walt with Westgate Supply. We supply A325 bolts.", "acti_1"), { saved: false });
  assert.deepEqual(writes, ["Opener: Hi, this is Walt with Westgate Supply. We supply A325 bolts."]);
});
