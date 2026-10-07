import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps, Llm } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_USER_ID } from "../src/fixtures.js";
import { askedForLineCard, callUsWhen, composeLineCardEmail, detectLineCardRequest, draftLineCardEmail, evidenceFromText, familiesFromText, filingMethodFromText, lineCardSubject, LineCardRequestSchema, LOCATION_WORDS, OpenerSchema, recommendFormat, SUBJECT_MAX, validateLineCardEmail, type LineCardRequest } from "../src/linecardflow.js";
import { FAMILIES, renderNiche, renderPlainText, renderShort, renderVendorRow, SIGNATURE_TEXT } from "../src/content/lineCard.js";

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
  filingMethod: "unknown", filingEvidence: null, relevantFamilies: ["plate_bar", "bolts", "nuts", "gaskets"], specificItems: [], transcriptFacts: ["a lot of stainless work, 304 and 316 plate"], openNeed: null, pastBenchmark: false,
  wants: { fullText: false, pdfOnly: false, setupPacket: false }, format: "standard", reason: "", confidence: 0.9, ...over,
});
const opener = { opener: "Thanks for taking my call this morning. You mentioned you do a lot of stainless work in 304 and 316 plate, with some duplex now and then." };

test("the rules hear how they file vendors, with their sentence as the evidence, and whether they asked at all", () => {
  assert.equal(filingMethodFromText(KEY_WEST), "contact_card");
  assert.equal(evidenceFromText(KEY_WEST, "contact_card"), "I create a contact for each vendor and write what they offer line by line, then search my email when I need something.");
  assert.equal(filingMethodFromText("I'll put you in our vendor list in Epicor"), "erp_vendor_list");
  assert.equal(filingMethodFromText("we keep a spreadsheet of suppliers"), "spreadsheet");
  assert.equal(filingMethodFromText("I'll print it and put it in the binder"), "print");
  assert.equal(filingMethodFromText("I just search my email when I need something"), "inbox_search");
  assert.equal(filingMethodFromText("sure, send it over"), null);
  assert.ok(askedForLineCard("go ahead and send me your line card"));
  assert.ok(askedForLineCard("shoot me an email with what you have"));
  assert.ok(!askedForLineCard("we're all set, thanks"));
});

test("detection: Key West Metal comes back as a contact-card filer, to her address, with her words on record", async () => {
  const d = deps(fakeLlm({ request: {
    requested: true, requester: { name: "Dana", email: "dana@keywestmetal.com", title: "purchasing", isGatekeeper: false }, forwardTo: null,
    filingMethod: "unknown", filingEvidence: "something she never said", transcriptFacts: ["small shop, a lot of stainless work, 304 and 316 plate and some duplex"], productTerms: ["stainless plate", "duplex"], specificItems: ["304 plate", "316 plate"],
    openNeed: null, pastBenchmark: false, wantsFullText: false, wantsPdfOnly: false, wantsSetupPacket: false, confidence: 0.95,
  } }));
  const req = (await detectLineCardRequest(d, { company: "Key West Metal", transcript: KEY_WEST, description: "fab shop" }))!;
  assert.ok(req);
  assert.equal(req.filingMethod, "contact_card", "the rules override the model's 'unknown'");
  assert.match(req.filingEvidence!, /^I create a contact for each vendor/, "evidence is her sentence from the transcript, not the model's paraphrase");
  assert.equal(req.requester.email, "dana@keywestmetal.com");
  assert.ok(req.relevantFamilies.includes("plate_bar"));
  assert.equal(req.format, "full_text", "no .vcf on the template yet, so the whole card is written out");
  assert.equal(recommendFormat(req, { hasVcf: true }).format, "contact_card");
  // No request in the words: the model isn't even asked.
  let asked = false;
  const quiet = deps((async () => { asked = true; throw new Error("no"); }) as unknown as Llm);
  assert.equal(await detectLineCardRequest(quiet, { company: "X", transcript: "Rep @ 0:00: Hi there, is purchasing in? Prospect @ 0:05: No, call back tomorrow, thanks, bye. ".repeat(6) }), null);
  assert.ok(!asked);
});

test("a filing method the model claims without the buyer's words becomes unknown", async () => {
  const d = deps(fakeLlm({ request: {
    requested: true, requester: { name: "Mike", email: "mike@x.com", title: null, isGatekeeper: false }, forwardTo: null,
    filingMethod: "contact_card", filingEvidence: null, transcriptFacts: ["HVAC work"], productTerms: ["U-bolts"], specificItems: [],
    openNeed: null, pastBenchmark: false, wantsFullText: false, wantsPdfOnly: false, wantsSetupPacket: false, confidence: 0.8,
  } }));
  const t = "Prospect (Mike) @ 0:05: We do HVAC work, lots of U-bolts. Sure, send me your line card, mike@x.com. ".repeat(3);
  const req = (await detectLineCardRequest(d, { company: "Cool Air", transcript: t }))!;
  assert.equal(req.filingMethod, "unknown");
  assert.equal(req.filingEvidence, null);
});

test("the recommended format follows what they said", () => {
  assert.equal(recommendFormat(baseReq({ wants: { fullText: false, pdfOnly: true, setupPacket: false } }), { hasVcf: false }).format, "pdf_only");
  assert.equal(recommendFormat(baseReq({ wants: { fullText: false, pdfOnly: false, setupPacket: true } }), { hasVcf: false }).format, "setup_packet");
  assert.equal(recommendFormat(baseReq({ requester: { name: "Front Desk", email: "info@x.com", title: null, isGatekeeper: true } }), { hasVcf: false }).format, "gatekeeper");
  assert.equal(recommendFormat(baseReq({ filingMethod: "spreadsheet", filingEvidence: "our vendor list" }), { hasVcf: false }).format, "vendor_row");
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
  assert.equal(lineCardSubject({ words: ["A36 plate", "A325 bolts"], families: ["plate_bar", "bolts", "gaskets"], seed: "z" }).split(", ").filter((w) => w === "bolts").length, 0, "a family word that repeats a product word is dropped");
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

test("families from the call: U-bolts aren't bolts, beam clamps aren't beams; triggers come from what they named", () => {
  const fams = familiesFromText("they buy U-bolts and beam clamps", null);
  assert.equal(fams[0], "u_bolts");
  assert.ok(!fams.includes("bolts") && !fams.includes("plate_bar"));
  assert.ok(familiesFromText("", "HVAC contractor").length >= 2);
  assert.equal(callUsWhen(["304 plate", "316 plate"], ["plate_bar", "bolts"]), "Call us when you need: 304 plate, 316 plate, plate, bar and structural.");
  assert.equal(callUsWhen([], ["studs", "flanges", "gaskets"]), "Call us when you need: studs and stud bolts, flanges and blinds, gaskets and sealing.");
  assert.equal(callUsWhen(["B7 studs", "2H nuts", "spiral wound", "RTJ gaskets", "weld necks", "olets"], ["studs"]), "Call us when you need: B7 studs, 2H nuts, spiral wound, RTJ gaskets, weld necks.", "at most five");
  assert.ok(!/keg|turnaround|hurry/.test(callUsWhen([], FAMILIES.map((f) => f.id))), "no invented scenarios");
});

test("niche for an HVAC contractor lists their families in full and names the rest", () => {
  const req = baseReq({ requester: { name: "Mike", email: "mike@coolair.com", title: null, isGatekeeper: false }, relevantFamilies: ["u_bolts", "threaded_rod", "flanges"], specificItems: ["2 inch U-bolts", "3/8 threaded rod"] });
  const e = composeLineCardEmail({ req, format: "niche", opener, rep, first: "Mike", company: "Cool Air Mechanical", seed: "lead_hvac", attached: { vcf: false, w9: false } });
  assert.ok(e.body.includes(renderNiche(["u_bolts", "threaded_rod", "flanges"])));
  assert.ok(e.body.includes("We also carry: studs and stud bolts;"));
  assert.ok(!e.body.includes("Gaskets and sealing: spiral wound, ring joint (RTJ), CG"), "gaskets aren't listed in full");
  assert.ok(!LOCATION_WORDS.test(e.body));
  assert.deepEqual(validateLineCardEmail(e, req, "niche", e.personalized, "U-bolts threaded rod flanges").filter((p) => p.hard), []);
});

test("gatekeeper intro asks them to pass it along, never for their RFQ", () => {
  const req = baseReq({ requester: { name: "Front Desk", email: "info@acmefab.com", title: "front desk", isGatekeeper: true }, forwardTo: { name: "Mike", role: "purchasing" }, relevantFamilies: ["plate_bar", "bolts"] });
  const gk = { opener: "Thanks for taking my call this afternoon. You mentioned Mike handles the buying for the shop and that you'd pass this along to him." };
  const e = composeLineCardEmail({ req, format: "gatekeeper", opener: gk, rep, first: null, company: "Acme Fabrication", seed: "lead_gk", attached: { vcf: false, w9: false } });
  assert.ok(e.body.startsWith("Hi there,"));
  assert.ok(e.body.includes(renderShort(rep)), "the short card rides along so the forwarded email is searchable for the real buyer");
  assert.ok(e.body.includes("If you can pass this along to whoever buys materials, I would appreciate it.\n\nThanks,\nWalt Boxwell"));
  assert.deepEqual(validateLineCardEmail(e, req, "gatekeeper", e.personalized, "").filter((p) => p.hard), []);
  const asBuyer = { ...e, personalized: e.personalized.replace("If you can pass this along to whoever buys materials, I would appreciate it.", "Send me your next RFQ and I'll price it.") };
  assert.ok(validateLineCardEmail(asBuyer, req, "gatekeeper", asBuyer.personalized, "").some((p) => p.rule === "gatekeeper"));
});

test("vendor row, setup packet, contact card and PDF only each add their piece, with nothing repeated", () => {
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
  const row = composeLineCardEmail({ req: baseReq({ filingMethod: "spreadsheet", filingEvidence: "our vendor list" }), format: "vendor_row", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(row.body.includes(renderVendorRow(rep)) && row.body.includes("You said you keep a vendor list, so there is one line below to paste into it"));
  const packet = composeLineCardEmail({ req: baseReq({ wants: { fullText: false, pdfOnly: false, setupPacket: true } }), format: "setup_packet", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(packet.body.includes("W-9: available on request"));
  const packetW9 = composeLineCardEmail({ req: baseReq(), format: "setup_packet", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: true } });
  assert.ok(packetW9.body.includes("W-9: included with this email."));
  const card = composeLineCardEmail({ req: baseReq({ filingMethod: "contact_card", filingEvidence: "I create a contact for each vendor" }), format: "contact_card", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: true, w9: false } });
  assert.ok(card.body.includes("contact card (.vcf)") && card.body.includes(renderPlainText()));
  const noVcf = composeLineCardEmail({ req: baseReq({ filingMethod: "contact_card", filingEvidence: "I create a contact for each vendor" }), format: "contact_card", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(!noVcf.body.includes(".vcf"), "no .vcf on the template: the sentence is left out, the send isn't blocked");
  const pdf = composeLineCardEmail({ req: baseReq(), format: "pdf_only", opener, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(!pdf.body.includes("What we carry:") && pdf.body.includes("Our line card is attached as a PDF.") && pdf.body.endsWith(SIGNATURE_TEXT) && pdf.subject.startsWith("Westgate Supply:"));
  for (const [e, f] of [[row, "vendor_row"], [packet, "setup_packet"], [packetW9, "setup_packet"], [card, "contact_card"], [pdf, "pdf_only"]] as const) {
    assert.ok(!DASH.test(e.body) && e.subject.length <= 70 && !LOCATION_WORDS.test(e.body), f);
    assert.equal(count(e.body, /\bPDF\b/g), 1, `${f}: PDF once`);
    assert.ok(count(e.body, /\bNo minimum/g) <= 1, `${f}: No minimum once`);
    assert.deepEqual(validateLineCardEmail(e, baseReq({ filingMethod: f === "vendor_row" ? "spreadsheet" : f === "contact_card" ? "contact_card" : "unknown", filingEvidence: f === "vendor_row" || f === "contact_card" ? "x" : null }), f, e.personalized, "").filter((p) => p.hard), [], f);
  }
});

test("validation catches an invented spec, a dash, hedging, an old-RFQ line, and too few families", () => {
  const req = baseReq();
  const bad = composeLineCardEmail({ req, format: "standard", opener: { opener: "Thanks for the call. You mentioned you run a lot of A193 B7 studs and some Xylan 9999 coated bolts, plus the C-276 bar." }, rep, first: "Dana", company: "Key West Metal", seed: "s", attached: { vcf: false, w9: false } });
  const withBad = { ...bad, personalized: `${bad.personalized}\n\nIf you have an old RFQ lying around, send it over and I'll price it, no pressure.` };
  const rules = validateLineCardEmail(withBad, req, "standard", withBad.personalized, "we buy B7 studs").filter((p) => p.hard).map((p) => p.rule);
  assert.ok(rules.includes("invented"), `Xylan 9999 isn't on the card: ${rules}`);
  assert.equal(rules.filter((r) => r === "invented").length, 1, "C-276 is on the card, B7 was said");
  assert.ok(rules.includes("hedging") && rules.includes("benchmark"), rules.join());
  const dashed = { ...bad, body: bad.body.replace("Thanks", "Thanks —") };
  assert.ok(validateLineCardEmail(dashed, req, "standard", bad.personalized, "").some((p) => p.rule === "dashes"));
  const thin = { subject: "Westgate Supply: x, fasteners, gaskets", body: "Hi,\n\nStuds and stud bolts and nuts.\n\nWalt" };
  assert.ok(validateLineCardEmail(thin, req, "standard", "short", "").some((p) => p.rule === "families" && /of the 12/.test(p.problem)));
  assert.ok(validateLineCardEmail({ ...thin, subject: "Line card" }, req, "standard", "short", "").some((p) => p.rule === "subject"));
  assert.equal(FAMILIES.filter((f) => bad.body.includes(f.name)).length, 12);
});

test("the draft end to end: a cached opener is reused when the format changes, and no address means no draft", async () => {
  let openers = 0;
  const llm = (async (opts: Parameters<Llm>[0]) => {
    if (opts.schema === OpenerSchema) { openers++; return { data: opener, usage: {} }; }
    return demoLlm(opts as never);
  }) as Llm;
  const d = deps(llm);
  const req = baseReq({ filingMethod: "contact_card", filingEvidence: "I create a contact for each vendor" });
  const first = await draftLineCardEmail(d, { leadId: "lead_kw", company: "Key West Metal", transcript: KEY_WEST, req });
  assert.ok(first.email && first.email.to[0].email === "dana@keywestmetal.com");
  assert.equal(first.state.format, "full_text");
  assert.equal(openers, 1);
  assert.ok(first.email!.body.endsWith(SIGNATURE_TEXT));
  const again = await draftLineCardEmail(d, { leadId: "lead_kw", company: "Key West Metal", transcript: KEY_WEST, req, format: "vendor_row", opener: first.state.opener });
  assert.equal(openers, 1, "changing the format doesn't re-run the model");
  assert.ok(again.email!.body.includes(" | walt@westgatesupply.com | "));
  assert.match(again.state.reason, /^You picked Vendor list row\. The app suggested Full text/);
  const none = await draftLineCardEmail(d, { leadId: "lead_x", company: "X", transcript: KEY_WEST, req: baseReq({ requester: { name: "Dana", email: null, title: null, isGatekeeper: false } }) });
  assert.equal(none.email, null);
  assert.match(none.warnings[0], /no email address came through/);
});
