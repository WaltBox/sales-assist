import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps, Llm } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_USER_ID } from "../src/fixtures.js";
import { askedForLineCard, callUsWhen, composeLineCardEmail, detectLineCardRequest, draftLineCardEmail, familiesFromText, filingMethodFromText, lineCardSubject, LineCardRequestSchema, OpenerSchema, recommendFormat, SUBJECT_MAX, validateLineCardEmail, type LineCardRequest } from "../src/linecardflow.js";
import { FAMILIES, SIGNATURE_LINE, wordCount } from "../src/content/lineCard.js";

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles" };
const DASH = /[–—]/;

/** Key West Metal (the live call that started this): she keeps a contact per vendor and searches her email. */
const KEY_WEST = [
  "Rep (Walt Boxwell) @ 0:00: Hi, this is Walt with Westgate Supply. We supply pipe, fittings, flanges, gaskets and bolting for fab shops. Who handles your purchasing?",
  "Prospect (Dana) @ 0:09: That's me. We're a small shop, we do a lot of stainless work, 304 and 316 plate and some duplex.",
  "Rep (Walt Boxwell) @ 0:20: Great. Anything out for pricing right now?",
  "Prospect (Dana) @ 0:25: Not at the moment. Go ahead and send me your line card and I'll keep it on file.",
  "Rep (Walt Boxwell) @ 0:31: Will do. How do you keep track of vendors, so I send it the right way?",
  "Prospect (Dana) @ 0:36: I create a contact for each vendor and write what they offer line by line, then search my email when I need something.",
  "Rep (Walt Boxwell) @ 0:45: Perfect, I'll write it out in the email. What's the best address?",
  "Prospect (Dana) @ 0:49: dana@keywestmetal.com.",
].join("\n");

function fakeLlm(answers: { request?: Record<string, unknown>; opener?: Record<string, unknown> }): Llm {
  return (async (opts: Parameters<Llm>[0]) => {
    if (opts.schema === LineCardRequestSchema && answers.request) return { data: opts.schema.parse(answers.request), usage: {} };
    if (opts.schema === OpenerSchema && answers.opener) return { data: opts.schema.parse(answers.opener), usage: {} };
    return demoLlm(opts as never);
  }) as Llm;
}
const deps = (llm: Llm): Deps => ({ close: new FakeClose(), llm, rep });

const baseReq = (over: Partial<LineCardRequest> = {}): LineCardRequest => ({
  requested: true, requester: { name: "Dana", email: "dana@keywestmetal.com", title: "Purchasing", isGatekeeper: false }, forwardTo: null,
  filingMethod: "unknown", filingEvidence: null, relevantFamilies: ["plate_bar", "bolts", "nuts", "gaskets"], specificItems: [], openNeed: null, pastBenchmark: false,
  wants: { fullText: false, pdfOnly: false, setupPacket: false }, warehouseNearest: "Houston, TX", driveTimeMinutes: null, format: "standard", reason: "", confidence: 0.9, ...over,
});

test("the rules hear how they file vendors, and whether they asked at all", () => {
  assert.equal(filingMethodFromText(KEY_WEST), "contact_card");
  assert.equal(filingMethodFromText("I'll put you in our vendor list in Epicor"), "erp_vendor_list");
  assert.equal(filingMethodFromText("we keep a spreadsheet of suppliers"), "spreadsheet");
  assert.equal(filingMethodFromText("I'll print it and put it in the binder"), "print");
  assert.equal(filingMethodFromText("I just search my email when I need something"), "inbox_search");
  assert.equal(filingMethodFromText("sure, send it over"), null);
  assert.ok(askedForLineCard("go ahead and send me your line card"));
  assert.ok(askedForLineCard("shoot me an email with what you have"));
  assert.ok(!askedForLineCard("we're all set, thanks"));
});

test("detection: Key West Metal comes back as a contact-card filer, to her address, with the families she named", async () => {
  const d = deps(fakeLlm({ request: {
    requested: true, requester: { name: "Dana", email: "dana@keywestmetal.com", title: "purchasing", isGatekeeper: false }, forwardTo: null,
    filingMethod: "unknown", filingEvidence: "I create a contact for each vendor and write what they offer line by line", productTerms: ["stainless plate", "duplex"], specificItems: ["304 plate", "316 plate"],
    openNeed: null, pastBenchmark: false, wantsFullText: false, wantsPdfOnly: false, wantsSetupPacket: false, confidence: 0.95,
  } }));
  const req = (await detectLineCardRequest(d, { company: "Key West Metal", transcript: KEY_WEST, description: "fab shop", state: "FL" }))!;
  assert.ok(req);
  assert.equal(req.filingMethod, "contact_card", "the rules override the model's 'unknown'");
  assert.equal(req.requester.email, "dana@keywestmetal.com");
  assert.ok(req.relevantFamilies.includes("plate_bar"));
  assert.equal(req.warehouseNearest, "Houston, TX");
  assert.equal(req.format, "full_text", "no .vcf on the template yet, so the whole card is written out");
  assert.equal(recommendFormat(req, { hasVcf: true }).format, "contact_card");
  // No request in the words: the model isn't even asked.
  let asked = false;
  const quiet = deps((async () => { asked = true; throw new Error("no"); }) as unknown as Llm);
  assert.equal(await detectLineCardRequest(quiet, { company: "X", transcript: "Rep @ 0:00: Hi there, is purchasing in? Prospect @ 0:05: No, call back tomorrow, thanks, bye. ".repeat(6) }), null);
  assert.ok(!asked);
});

test("the recommended format follows what they said", () => {
  assert.equal(recommendFormat(baseReq({ wants: { fullText: false, pdfOnly: true, setupPacket: false } }), { hasVcf: false }).format, "pdf_only");
  assert.equal(recommendFormat(baseReq({ wants: { fullText: false, pdfOnly: false, setupPacket: true } }), { hasVcf: false }).format, "setup_packet");
  assert.equal(recommendFormat(baseReq({ requester: { name: "Front Desk", email: "info@x.com", title: null, isGatekeeper: true } }), { hasVcf: false }).format, "gatekeeper");
  assert.equal(recommendFormat(baseReq({ filingMethod: "spreadsheet" }), { hasVcf: false }).format, "vendor_row");
  assert.equal(recommendFormat(baseReq({ relevantFamilies: ["u_bolts", "flanges"], specificItems: ["2 inch U-bolts", "150# flanges"] }), { hasVcf: false }).format, "niche");
  assert.equal(recommendFormat(baseReq(), { hasVcf: false }).format, "standard");
});

test("subjects: product words first, two rotating fixed words, never over 70 characters, no dashes", () => {
  assert.equal(lineCardSubject({ words: ["B7 studs", "2H nuts"], seed: "lead_1" }).replace(/, [a-z]+, [a-z]+$/, ""), "Westgate Supply: B7 studs, 2H nuts");
  assert.ok(/^Westgate Supply: pipe supports, U-bolts, [a-z]+, [a-z]+$/.test(lineCardSubject({ words: ["pipe supports", "u bolts"], seed: "lead_2" })));
  assert.equal(lineCardSubject({ seed: "lead_3", gatekeeper: { company: "Acme Fab" } }), "Westgate Supply line card for Acme Fab: fasteners, gaskets, flanges");
  assert.equal(lineCardSubject({ seed: "lead_3", gatekeeper: { company: "Acme Fabrication" } }), "Westgate Supply line card for Acme Fabrication: fasteners, gaskets");
  const long = lineCardSubject({ seed: "x", gatekeeper: { company: "Southeastern Industrial Inc / National Machinery & Fabrication of the Carolinas" } });
  assert.ok(long.length <= SUBJECT_MAX && long.endsWith(": fasteners"), long);
  // 50 leads with random words: a long one is trimmed to fit, and the two fixed words rotate.
  const pool = ["stainless steel plate and sheet", "B7", "spiral wound gaskets", "weld neck flanges", "heavy hex nuts", "anchor bolts to a drawing", "Inconel 625 bar", "U-bolts", "expansion joints", "threaded rod"];
  const fixed = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const words = [pool[i % pool.length], pool[(i * 3) % pool.length], pool[(i * 7) % pool.length]];
    const s = lineCardSubject({ words, families: ["flanges", "gaskets"], seed: `lead_${i}` });
    assert.ok(s.length <= SUBJECT_MAX, `${s} (${s.length})`);
    assert.ok(s.startsWith("Westgate Supply: ") && !DASH.test(s), s);
    fixed.add(s.split(", ").slice(-2).join(", "));
  }
  assert.ok(fixed.size >= 4, `fixed words rotate: ${[...fixed].join(" | ")}`);
});

test("families from the call: U-bolts aren't bolts, beam clamps aren't beams, and there are always at least two", () => {
  assert.deepEqual(familiesFromText("they buy U-bolts and beam clamps", null), ["u_bolts"].concat(familiesFromText("they buy U-bolts and beam clamps", null).slice(1)));
  assert.ok(!familiesFromText("they buy U-bolts and beam clamps", null).includes("bolts"));
  assert.ok(!familiesFromText("they buy U-bolts and beam clamps", null).includes("plate_bar"));
  assert.ok(familiesFromText("", "HVAC contractor").length >= 2);
  assert.match(callUsWhen(["studs", "flanges", "gaskets"]), /^Call us when you need flange bolt-up, flanges in a hurry, spiral wound gaskets for a turnaround, sour service fasteners\.$/);
});

const opener = { opener: "Thanks for taking my call this morning. You mentioned you do a lot of stainless work in 304 and 316 plate, with some duplex, so I've written our line card out below and attached it as a PDF.", nextStep: "Send me your next list or RFQ and I'll price it." };

test("full text for Key West Metal: the whole card in the body, the keyword subject, the signature line, and it validates", () => {
  const req = baseReq({ filingMethod: "contact_card", specificItems: ["304 plate", "316 plate"] });
  const e = composeLineCardEmail({ req, format: "full_text", opener, rep, first: "Dana", company: "Key West Metal", seed: "lead_kw", attached: { vcf: false, w9: false } });
  assert.ok(e.body.startsWith("Hi Dana,\n\nThanks for taking my call this morning."), e.body.slice(0, 80));
  assert.ok(e.body.includes("Studs and stud bolts: A193 B7, A193 B7M") && e.body.includes("Hastelloy C-276"), "the full card is in the body");
  assert.ok(e.body.includes("We ship from Houston, TX, and also from Oakland, CA and Burbank, IL. No minimum order, and MTRs come with every order."));
  assert.ok(e.body.endsWith(`Walt Boxwell\n\n${SIGNATURE_LINE}`));
  assert.ok(e.subject.startsWith("Westgate Supply: 304 plate, 316 plate, ") && e.subject.length <= 70, e.subject);
  const problems = validateLineCardEmail(e, req, "full_text", e.personalized, KEY_WEST);
  assert.deepEqual(problems.filter((p) => p.hard), []);
  assert.ok(!DASH.test(e.body));
});

test("niche for an HVAC contractor lists their families in full and names the rest", () => {
  const req = baseReq({ requester: { name: "Mike", email: "mike@coolair.com", title: null, isGatekeeper: false }, relevantFamilies: ["u_bolts", "threaded_rod", "flanges"], specificItems: ["2 inch U-bolts", "3/8 threaded rod"], warehouseNearest: "Burbank, IL" });
  const e = composeLineCardEmail({ req, format: "niche", opener, rep, first: "Mike", company: "Cool Air Mechanical", seed: "lead_hvac", attached: { vcf: false, w9: false } });
  assert.ok(e.body.includes("Bent bolts, U-bolts and pipe supports: U-bolts rolled to pipe size") && e.body.includes("Threaded rod and custom machining: continuous thread rod"));
  assert.ok(e.body.includes("We also carry: studs and stud bolts;"));
  assert.ok(!e.body.includes("Gaskets and sealing: spiral wound, ring joint (RTJ), CG"), "gaskets aren't listed in full");
  assert.deepEqual(validateLineCardEmail(e, req, "niche", e.personalized, "U-bolts threaded rod flanges").filter((p) => p.hard), []);
});

test("gatekeeper intro for a fabricator's front desk asks them to forward it, never for their RFQ", () => {
  const req = baseReq({ requester: { name: "Front Desk", email: "info@acmefab.com", title: "front desk", isGatekeeper: true }, forwardTo: { name: "Mike", role: "purchasing" }, relevantFamilies: ["plate_bar", "bolts"] });
  const gk = { opener: "Thanks for taking my call this afternoon. You mentioned Mike handles the buying for the shop and that you'd pass this along to him, so I've put our line card below and attached it as a PDF.", nextStep: "Could you forward this to Mike, or whoever buys materials for the shop? I appreciate it." };
  const e = composeLineCardEmail({ req, format: "gatekeeper", opener: gk, rep, first: null, company: "Acme Fabrication", seed: "lead_gk", attached: { vcf: false, w9: false } });
  assert.ok(e.body.startsWith("Hi there,"));
  assert.equal(e.subject, "Westgate Supply line card for Acme Fabrication: fasteners, gaskets");
  assert.ok(e.body.includes("What we carry:"), "the short card rides along so the forwarded email is searchable for the real buyer");
  assert.deepEqual(validateLineCardEmail(e, req, "gatekeeper", e.personalized, "").filter((p) => p.hard), []);
  const asBuyer = composeLineCardEmail({ req, format: "gatekeeper", opener: { ...gk, nextStep: "Send me your next RFQ and I'll price it." }, rep, first: null, company: "Acme Fabrication", seed: "lead_gk", attached: { vcf: false, w9: false } });
  assert.ok(validateLineCardEmail(asBuyer, req, "gatekeeper", asBuyer.personalized, "").some((p) => p.rule === "gatekeeper"));
});

test("vendor row, setup packet, contact card and PDF only each add their piece", () => {
  const req = baseReq({ filingMethod: "spreadsheet" });
  const row = composeLineCardEmail({ req, format: "vendor_row", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(row.body.includes("Westgate Supply | Walt Boxwell | walt@westgatesupply.com | (832) 957-1722 |"));
  const packet = composeLineCardEmail({ req: baseReq({ wants: { fullText: false, pdfOnly: false, setupPacket: true } }), format: "setup_packet", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(packet.body.includes("W-9: available on request"));
  const packetW9 = composeLineCardEmail({ req: baseReq(), format: "setup_packet", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: true } });
  assert.ok(packetW9.body.includes("W-9: attached."));
  const card = composeLineCardEmail({ req: baseReq({ filingMethod: "contact_card" }), format: "contact_card", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: true, w9: false } });
  assert.ok(card.body.includes("contact card (.vcf)"));
  const noVcf = composeLineCardEmail({ req: baseReq({ filingMethod: "contact_card" }), format: "contact_card", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(!noVcf.body.includes(".vcf"), "no .vcf on the template: the sentence is left out, the send isn't blocked");
  const pdf = composeLineCardEmail({ req: baseReq(), format: "pdf_only", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(!pdf.body.includes("What we carry:") && pdf.body.includes(SIGNATURE_LINE) && pdf.subject.startsWith("Westgate Supply:"));
  assert.deepEqual(validateLineCardEmail(pdf, baseReq(), "pdf_only", pdf.personalized, "").filter((p) => p.hard), []);
  for (const e of [row, packet, card, pdf]) assert.ok(!DASH.test(e.body) && e.subject.length <= 70);
});

test("validation catches an invented spec, a dash, hedging, an old-RFQ line, and too few families", () => {
  const req = baseReq();
  const bad = composeLineCardEmail({ req, format: "standard", opener: { opener: "Thanks for the call. You mentioned you run a lot of A193 B7 studs and some Xylan 9999 coated bolts, plus the C-276 bar.", nextStep: "If you have an old RFQ lying around, send it over and I'll price it, no pressure." }, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  const rules = validateLineCardEmail(bad, req, "standard", bad.personalized, "we buy B7 studs").filter((p) => p.hard).map((p) => p.rule);
  assert.ok(rules.includes("invented"), `Xylan 9999 isn't on the card: ${rules}`);
  assert.ok(!bad.personalized.includes("Xylan 9999") || rules.filter((r) => r === "invented").length === 1, "C-276 is on the card, B7 was said");
  assert.ok(rules.includes("hedging") && rules.includes("benchmark"), rules.join());
  const dashed = { ...bad, body: bad.body.replace("Thanks", "Thanks —") };
  assert.ok(validateLineCardEmail(dashed, req, "standard", bad.personalized, "").some((p) => p.rule === "dashes"));
  const thin = { subject: "Westgate Supply: x, fasteners, gaskets", body: "Hi,\n\nStuds and stud bolts and nuts.\n\nWalt" };
  assert.ok(validateLineCardEmail(thin, req, "standard", "short", "").some((p) => p.rule === "families" && /of the 12/.test(p.problem)));
  assert.ok(validateLineCardEmail({ ...thin, subject: "Line card" }, req, "standard", "short", "").some((p) => p.rule === "subject"));
  // Every family name is in the short card, so the standard format always clears the 10-of-12 bar.
  assert.equal(FAMILIES.filter((f) => bad.body.includes(f.name)).length, 12);
  assert.ok(wordCount(bad.personalized) > 0);
});

test("the draft end to end: a cached opener is reused when the format changes, and no address means no draft", async () => {
  let openers = 0;
  const llm = (async (opts: Parameters<Llm>[0]) => {
    if (opts.schema === OpenerSchema) { openers++; return { data: opener, usage: {} }; }
    return demoLlm(opts as never);
  }) as Llm;
  const d = deps(llm);
  const req = baseReq({ filingMethod: "contact_card" });
  const first = await draftLineCardEmail(d, { leadId: "lead_kw", company: "Key West Metal", transcript: KEY_WEST, req });
  assert.ok(first.email && first.email.to[0].email === "dana@keywestmetal.com");
  assert.equal(first.state.format, "full_text");
  assert.equal(openers, 1);
  const again = await draftLineCardEmail(d, { leadId: "lead_kw", company: "Key West Metal", transcript: KEY_WEST, req, format: "vendor_row", opener: first.state.opener });
  assert.equal(openers, 1, "changing the format doesn't re-run the model");
  assert.ok(again.email!.body.includes(" | walt@westgatesupply.com | "));
  assert.match(again.state.reason, /^You picked Vendor list row\. The app suggested Full text/);
  const none = await draftLineCardEmail(d, { leadId: "lead_x", company: "X", transcript: KEY_WEST, req: baseReq({ requester: { name: "Dana", email: null, title: null, isGatekeeper: false } }) });
  assert.equal(none.email, null);
  assert.match(none.warnings[0], /no email address came through/);
});
