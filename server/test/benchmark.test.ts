import assert from "node:assert/strict";
import { test } from "node:test";
import { afterCall, afterCallExtras, RFQ_ASKED_TAG, RFQ_TAG, type Deps, type Llm } from "../src/assistant.js";
import { applyBenchmarkTask, benchmarkDecision, enforceBenchmark, OFFERS, stripDashes, type BenchmarkSignals } from "../src/benchmark.js";
import type { CloseClient } from "../src/close.js";
import { loadLeadContext } from "../src/context.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_LEAD_ID, DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import type { AfterCall, Proposals } from "../src/schemas.js";
import { dayStats, resetStatsCache } from "../src/stats.js";

const NOW = new Date("2026-09-23T21:31:00Z"); // Wed 2:31 PM Pacific
const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles" };
const deps = (close: FakeClose, llm: Llm = demoLlm): Deps => ({ close, llm, rep, now: () => NOW });
const ctx = (close = new FakeClose({ calls: [roddaCall()] })) => loadLeadContext(close as unknown as CloseClient, DEMO_LEAD_ID, NOW);
const none: BenchmarkSignals = { no_current_rfq: false, rfq_promised: false, benchmark_agreed: false, asked_specific_callback: false, soft_yes: false };

const email = (body: string): NonNullable<Proposals["email"]> => ({ to: [{ name: "Renee", email: "renee@roddaelectric.com" }], subject: "s", body, attach_line_card: true, address_as_heard: null });
const BODY = ["Hi Renee,", "Thanks for taking my call this afternoon!", "For Rodda we cover threaded rod, anchors, and beam clamps.", "Have a great rest of your day.", "Walt Boxwell"].join("\n\n");

test("past-RFQ offer: when there's nothing open, and when it stays out", async () => {
  const c = await ctx();
  assert.equal(benchmarkDecision({ ...none, no_current_rfq: true }, c, null), true);
  assert.equal(benchmarkDecision(none, c, "Yeah, we don't have anything, maybe in a couple months."), true); // phrase list catches it
  assert.equal(benchmarkDecision(none, c, "We're swamped, send me your info."), false);
  assert.equal(benchmarkDecision({ ...none, no_current_rfq: true, soft_yes: true }, c, null), false); // "send your info and we'll consider you"
  assert.equal(benchmarkDecision({ ...none, no_current_rfq: true, rfq_promised: true }, c, null), false);
  assert.equal(benchmarkDecision({ ...none, no_current_rfq: true, benchmark_agreed: true }, c, null), false);
  assert.equal(benchmarkDecision({ ...none, no_current_rfq: true, asked_specific_callback: true }, c, null), false);
  c.facts.vendor = true;
  assert.equal(benchmarkDecision({ ...none, no_current_rfq: true }, c, null), false);
  c.facts.vendor = false;
  c.facts.competitorHits = ["DNOW"];
  assert.equal(benchmarkDecision({ ...none, no_current_rfq: true }, c, null), false);
});

const paras = (e: Proposals["email"]) => e!.body.split("\n\n");

test("the ask is one plain line after what we'd supply, before the closer", () => {
  const w: string[] = [];
  const out = paras(enforceBenchmark(email(BODY), true, w));
  assert.ok(OFFERS.includes(out[3]));
  assert.equal(out[4], "Have a great rest of your day.");
  assert.equal(out.length, 6);
  assert.match(w[0], /Added the one-line past-RFQ offer/);
  // The model's own plain line stays as written.
  const own = BODY.replace("Have a great", "If you've got an old PO handy, send it over and I'll price it.\n\nHave a great");
  assert.equal(enforceBenchmark(email(own), true, [])!.body, own);
  // Walt 9/28: a hedged one ("no pressure", "see how our numbers compare") is swapped for a plain ask.
  const hedged = BODY.replace("Have a great", "If you're curious how our numbers compare, send me an old PO and I'll price it. No pressure either way.\n\nHave a great");
  const h = paras(enforceBenchmark(email(hedged), true, []));
  assert.ok(OFFERS.includes(h[3]), h[3]);
  assert.doesNotMatch(h.join(" "), /no pressure|numbers compare/i);
});

test("an offer that explains the strategy or pushes is replaced with Walt's wording", () => {
  const pushy = BODY.replace("Have a great", "Even with nothing open, if you've got a recent RFQ or PO handy, shoot it over and I'll price it as if it were live. No obligation, it just gives you a quick side-by-side on what you paid versus what we'd have come in at.\n\nHave a great");
  const w: string[] = [];
  const out = paras(enforceBenchmark(email(pushy), true, w));
  assert.ok(OFFERS.includes(out[3]), out[3]);
  assert.doesNotMatch(out.join(" "), /shoot it over|no obligation|side-by-side|what you paid/i);
  assert.match(w[0], /Rewrote/);
  // Tucked into the supply paragraph: pulled out onto its own line, supply paragraph intact.
  const tucked = BODY.replace("and beam clamps.", "and beam clamps. Send over a recent RFQ and I'll price it.");
  const t = paras(enforceBenchmark(email(tucked), true, []));
  assert.equal(t[2], "For Rodda we cover threaded rod, anchors, and beam clamps.");
  assert.equal(t[3], "Send over a recent RFQ and I'll price it.");
  // The same, hedged ("see how we stack up", "no strings"): pulled out and replaced with a plain ask.
  const tuckedHedge = paras(enforceBenchmark(email(BODY.replace("and beam clamps.", "and beam clamps. If you ever want to see how we stack up, send over a recent RFQ and I'll price it, no strings.")), true, []));
  assert.equal(tuckedHedge[2], "For Rodda we cover threaded rod, anchors, and beam clamps.");
  assert.ok(OFFERS.includes(tuckedHedge[3]), tuckedHedge[3]);
  // An approval process or supplier list the buyer never mentioned.
  const approval = BODY.replace("Have a great", "Send me an old PO and I'll quote it, so you have something to run through your approval process.\n\nHave a great");
  assert.ok(OFFERS.includes(paras(enforceBenchmark(email(approval), true, [], { transcript: "Nothing right now." }))[3]));
  assert.equal(enforceBenchmark(email(approval), true, [], { transcript: "Every vendor goes through our approval process." })!.body, approval);
});

test("the offer comes out when it doesn't belong, but recollections of their words stay", () => {
  const own = BODY.replace("Have a great", "If you ever want to see how we stack up, send over a recent RFQ or PO and I'll price it, no strings.\n\nHave a great");
  assert.equal(enforceBenchmark(email(own), false, [])!.body, BODY);
  assert.equal(enforceBenchmark(email(own), false, [], { agreed: true })!.body, own); // they agreed on the call: keep it
  const said = BODY.replace("Have a great", "You mentioned the last RFQ you sent out, and I'd love to price the next one.\n\nHave a great");
  assert.equal(enforceBenchmark(email(said), false, [])!.body, said);
});

test("'I'll send the next one': offer to price a past one, never ask for something now", async () => {
  const c = await ctx();
  // A promise of the next one still gets the offer (unless it's a callback at a set time, a vendor, or they agreed to a past one).
  assert.equal(benchmarkDecision({ ...none, rfq_promised: true, soft_yes: true, next_one_promised: true }, c, null), true);
  assert.equal(benchmarkDecision({ ...none, next_one_promised: true, asked_specific_callback: true }, c, null), false);
  assert.equal(benchmarkDecision({ ...none, rfq_promised: true }, c, null), false); // sending one that exists now

  const pushy = BODY.replace("Have a great", "Sounds good, send the next one my way whenever it comes up. In the meantime, if you have something small or anything at all, send it over.\n\nHave a great");
  const w: string[] = [];
  const out = paras(enforceBenchmark(email(pushy), true, w, { nextOne: true }));
  assert.equal(out[3], `Sounds good, send the next one my way whenever it comes up. ${OFFERS[0]}`);
  assert.doesNotMatch(out.join(" "), /something small|anything at all/);
  assert.match(w.join(" "), /Took out asking for something now/);
  // The model's own plain ask right after the acknowledgment stays put.
  const good = BODY.replace("Have a great", "Sounds good, send the next one over as soon as you have it. If you have a past PO handy, send it my way and I'll price it.\n\nHave a great");
  assert.equal(enforceBenchmark(email(good), true, [], { nextOne: true })!.body, good);
});

test("no em or en dashes in email bodies", () => {
  assert.equal(stripDashes("No obligation — it just helps."), "No obligation, it just helps.");
  assert.equal(stripDashes("Flanges from 150–2500# and pipe—fittings."), "Flanges from 150-2500# and pipe, fittings.");
  assert.equal(stripDashes("Thanks — "), "Thanks,");
});

test("agreeing to send a past RFQ swaps the 3-week check-in for a 2-business-day confirm", async () => {
  const c = await ctx();
  const p: Proposals = { note: null, contacts: [], contact_updates: [], email: null, status: null, tasks: [
    { due_at: "2026-10-14T10:00:00-07:00", title: "Check in with Renee", ask_for: "Renee (covering purchasing)", phone: "+19252406024", email: null, why: null, deadline: null, pitch: "x", details: null },
    { due_at: "2026-10-12T09:30:00-07:00", title: "Intro call with Rob Roy when he's back", ask_for: "Rob Roy", phone: null, email: null, why: null, deadline: null, pitch: "x", details: null },
  ] };
  applyBenchmarkTask(p, c, "Renee (covering purchasing)", NOW);
  assert.deepEqual(p.tasks.map((t) => t.title), ["Confirm benchmark RFQ from Renee received; nudge if not", "Intro call with Rob Roy when he's back"]);
  assert.equal(p.tasks[0].due_at, "2026-09-25T10:00:00-07:00"); // Wed → Fri, 10 AM their time
  assert.equal(p.tasks[0].phone, "+19252406024");
});

function stub(signals: Partial<AfterCall>, extrasEmail: Proposals["email"] = null): Llm {
  return (async (opts: { schema: unknown }) => {
    const base = await demoLlm(opts as never);
    const data = base.data as Record<string, unknown>;
    if ("outcome" in data) return { ...base, data: { ...data, rfq_promised: false, ...signals } };
    if ("coaching" in data) return { ...base, data: { ...data, email: extrasEmail } };
    return base;
  }) as Llm;
}

test("after-call: an agreed benchmark tags the note and sets the confirm task", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  const r = await afterCall(deps(close, stub({ benchmark_agreed: true, no_current_rfq: true })), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001" });
  assert.equal(r.benchmark, false); // they're sending one; the email references it instead
  assert.ok(r.proposals.note!.text.includes(RFQ_ASKED_TAG) && r.proposals.note!.text.includes(RFQ_TAG));
  assert.match(r.proposals.tasks[0].title, /^Confirm benchmark RFQ from Renee received; nudge if not$/);
});

test("after-call → email: nothing open means the email carries the one-line offer", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  const llm = stub({ no_current_rfq: true }, email(BODY));
  const core = await afterCall(deps(close, llm), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001" });
  assert.equal(core.benchmark, true);
  const x = await afterCallExtras(deps(close, llm), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001", benchmark: core.benchmark });
  assert.ok(OFFERS.some((o) => x.email!.body.includes(o)));
  const y = await afterCallExtras(deps(close, llm), DEMO_LEAD_ID, { call_id: "acti_demoRoddaCall0001", benchmark: false });
  assert.ok(!OFFERS.some((o) => y.email!.body.includes(o)));
});

test("stats: RFQ asked today, and promised → received", async () => {
  resetStatsCache();
  const close = new FakeClose({ calls: [roddaCall()] });
  close.clock = () => NOW;
  await close.createNote(DEMO_LEAD_ID, `No RFQs now.\n\n${RFQ_ASKED_TAG}`, false);
  await close.createNote("lead_b", `Sending a list.\n\n${RFQ_TAG}`, false);
  close.olderNotes = [{ id: "n_old", lead_id: "lead_c", user_id: DEMO_USER_ID, note: `x\n\n${RFQ_ASKED_TAG}`, date_created: "2026-09-10T18:00:00Z" }];
  const inbound = (lead: string, attachments: unknown[]) => ({ id: `e_${lead}`, user_id: DEMO_USER_ID, lead_id: lead, direction: "incoming", status: "inbox", date_created: "2026-09-23T19:00:00Z", attachments });
  close.sentEmails = [
    inbound("lead_c", [{ filename: "PO-4471.pdf", content_type: "application/pdf" }]), // asked 2 weeks ago, came in today
    inbound("lead_b", [{ filename: "icon.png", content_type: "image/png" }]), // signature image only
    inbound("lead_z", [{ filename: "RFQ.xlsx", content_type: "application/vnd.ms-excel" }]), // never asked
  ];
  const s = await dayStats(deps(close), { fresh: true });
  assert.equal(s.rfqAsked, 1);
  assert.equal(s.rfqs, 1);
  assert.equal(s.rfqReceived, 1);
});

test("line card emails ask for a 'got it' reply right before the closer, once", async () => {
  const { enforceGotIt, GOT_IT_LINE } = await import("../src/benchmark.js");
  const email = { to: [{ name: "Rob", email: "rob@x.com" }], subject: "Westgate Supply – line card", body: "Hi Rob,\n\nThanks for the time today.\n\nAttached is our line card.\n\nTalk soon,\n\nWalt", attach_line_card: true } as any;
  const out = enforceGotIt(email);
  const paras = out.body.split("\n\n");
  assert.equal(paras[paras.length - 3], GOT_IT_LINE);
  assert.equal(enforceGotIt(out).body, out.body);
  assert.equal(enforceGotIt({ ...email, attach_line_card: false }).body, email.body);
  // 9/26: the ask came after the offer, and the signature wasn't there yet. Still right before the sign-off.
  const late = enforceGotIt({ ...email, body: "Hi Walt,\n\nLine card attached.\n\nIf you ever want to see how we stack up, send a recent RFQ.\n\nWhen the next list comes together, just reply here.\n\nThanks again, talk soon." });
  const lp = late.body.split("\n\n");
  assert.equal(lp[lp.length - 2], GOT_IT_LINE);
  assert.equal(lp[lp.length - 1], "Thanks again, talk soon.");
});
