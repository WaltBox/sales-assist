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

const PROBST = "Hi Tracy,\n\nI called in this afternoon and spoke with Hannah. She mentioned you're helping the project teams with vendors and pricing right now, so she pointed me your way.\n\nI'm Walt with Westgate Supply. We're a national industrial supplier of pipe, fittings, flanges, gaskets and bolting, and we do a lot of work with teams building and operating treatment plants. I've attached our line card so you can see the full range.\n\nIf any of your projects have an open RFQ or a materials list out for pricing, I'd be glad to put a quick quote together so you can see how we compare. Otherwise no rush at all.\n\nHannah said you're back next week, so I'll give you a call then to introduce myself.\n\nHave a great rest of your day!\n\nWalt Boxwell";
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
    [PROBST.replace("Otherwise no rush at all.", "Otherwise no rush at all. Whenever you've got an RFQ, reply here."), /already spoke with Walt/],
    [PROBST.replace("Otherwise no rush at all.", "Otherwise no rush at all. If you ever want to see how we stack up, send over a recent RFQ or PO and I'll price it, no strings."), /past RFQ/],
    [PROBST.replace("You mentioned", "x").replace("She mentioned you're", "You mentioned you're"), /already spoke with Walt/],
    [PROBST.replace(" I've attached our line card so you can see the full range.", ""), /line card so you can see the full range/],
    [PROBST.replace("Otherwise no rush at all.", ""), /soft offer/],
    [PROBST.replace("Hannah said you're back next week, so I'll give you a call then to introduce myself.", "Talk soon."), /next touch/],
    [PROBST.replace("Hannah said you're back next week, so I'll give you a call then", "I'll give you a call in the next few days"), /back next week/],
    [PROBST.replace("I called in this afternoon and spoke with Hannah. She mentioned", "I heard"), /Doesn't open with who Walt spoke to/],
    [PROBST.replace("Otherwise no rush at all.", "Otherwise no rush at all. We stock a deep range of grades and finishes and ship fast from several locations nationwide.".repeat(2)), /under 130/],
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
