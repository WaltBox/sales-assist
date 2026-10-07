import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHtml, renderNiche, renderPlainText, renderShort, renderVcf, renderVendorRow, wordCount, FAMILIES, MATERIALS, SIGNATURE_TEXT } from "../src/content/lineCard.js";
import { closingFor, composeLineCardEmail, FALLBACK_SECOND, LOCATION_WORDS, validateLineCardEmail, type LineCardRequest } from "../src/linecardflow.js";

// The printed line card, item by item (Walt 10/7): every one of these must come through the full text verbatim,
// because buyers search their inbox and contacts for the exact grade string.
const EXPECTED = [
  "Westgate Supply", "fasteners, PVF (pipe, valves, fittings), gaskets, flanges and metals", "Website: westgatesupply.com", "sales@westgatesupply.com", "No minimum order", "Full traceability",
  "Certified test reports (MTRs) to ASTM, ASME, ANSI, ISO, DIN, NACE and PED", "We quote RFQs, line lists and fabrication drawings, any quantity, certs attached.",
  "Studs and stud bolts:", "A193 B7", "B7M", "B16", "A320 L7", "L7M", "L43", "B8", "B8M", "A453 660", "NACE MR0175 sour service grades", "double end", "tap end", "continuous thread", "flange bolt-up",
  "Nuts:", "A194 2H", "2HM", "duplex 2205", "heavy hex", "finished hex", "jam", "lock", "stover", "nylon insert",
  "Washers and Belleville springs:", "F436", "flat", "heavy", "structural", "custom OD", "Belleville spring washers", "flange washers",
  "Bolts and screws:", "12 point", "flange bolts", "A193", "A320", "A325", "A490", "F3125", "socket head cap screws", "machine screws", "set screws",
  "Threaded rod and custom machining:", "continuous thread rod", "cut lengths", "metric", "8UN", "UNC", "UNF", "ACME", "spindles", "shafts", "machined parts to drawing",
  "Bent bolts, U-bolts and pipe supports:", "U-bolts rolled to pipe size", "L bolts", "J bolts", "anchor bolts", "pipe clamps", "beam clamps", "hangers", "saddles", "slide plates",
  "Gaskets and sealing:", "spiral wound", "ring joint (RTJ)", "CG", "CGI", "kammprofile", "sheet gaskets", "flange insulation kits", "ASME B16.20",
  "Flanges and blinds:", "weld neck (RFWN)", "slip on (RFSO)", "blind", "orifice", "spectacle blinds", "Class 150 to 2500", "A105", "LF2", "F304", "F316", "F51", "nickel alloys",
  "Pipe, tube and fittings:", "butt weld fittings ASME B16.9", "forged fittings 3000# and 6000#", "olets", "pipe and tube", "carbon through duplex", "MTRs included",
  "Plate, bar and structural:", "round bar", "flat bar", "hex bar", "plate", "sheet", "angle", "channel", "beam", "HSS tube", "skid frames",
  "Expansion joints and protection:", "rubber", "EPDM", "PTFE", "metallic expansion joints", "flange protectors", "pipe caps", "thread protectors",
  "Specialty hardware:", "orifice plates", "threaded inserts", "helicoils", "pins", "rivets", "stainless nameplates and tags",
  "Carbon steel:", "A307 Gr A", "Gr B", "SAE J429 Gr 2", "A449", "A36", "A516-70", "AR400", "A105N", "A350 LF2", "1018", "1045", "1144", "Class 8.8", "10.9", "12.9",
  "Alloy steel:", "4140", "4340", "8620", "A354 Gr BD", "A694 F65", "chrome moly F11", "F22", "P11", "P22",
  "Stainless steel:", "303", "304", "304L", "309", "310", "316", "316L", "317L", "321", "347", "410", "416", "17-4 PH", "17-7 PH", "904L", "Alloy 20", "A286", "XM-19", "254 SMO", "AL-6XN", "Nitronic 50", "Nitronic 60",
  "Stainless fastener grades:", "A193 B8", "B8M (Class 1 and 2)", "B8C", "B8T", "B8R", "B8S", "A320 B8", "A453 Gr 660 (A, B, D)",
  "Duplex and super duplex:", "2205 (S31803, S32205 dual cert)", "2507 (S32750, S32760)", "Zeron 100", "F53", "F55",
  "Nickel alloys:", "Nickel 200", "Monel 400", "Monel K-500", "Inconel 600", "601", "625", "718", "X-750", "925", "Incoloy 800H", "825", "Hastelloy C-22", "C-276",
  "Copper alloys:", "copper", "brass", "naval brass", "silicon bronze", "aluminum bronze", "phosphor bronze", "cupro-nickel",
  "Titanium, iron and non-metallics:", "titanium Gr 2", "Gr 5 (B348, B381)", "ductile iron", "malleable iron", "soft iron", "F5 ring gaskets", "PTFE bar", "neoprene", "Viton", "aluminum 6061", "5052", "specialty alloys on request",
  "Hot dip galvanized", "mechanical galvanizing", "zinc plating", "yellow zinc dichromate", "Xylan 1424", "1014", "1070", "1052", "Xylar 2", "fluoropolymer", "Teflon blue",
  "phosphate (zinc and manganese)", "black oxide", "cadmium (ASTM B766)", "Armoloy", "Sermagard", "MoS2", "nickel", "chrome", "silver", "gold", "electropolishing", "passivation",
  "anodizing", "O2 cleaning", "FBE fusion bond epoxy", "and more",
  "Operator coating specs: Chevron, ExxonMobil, BP, Baker Hughes, Schlumberger, NOV, Aker Solutions and more. Tell us the spec and we ship to it.",
  "fasteners, bolts, nuts, studs, stud bolts, washers, threaded rod, all thread, U-bolts, anchor bolts, gaskets, flanges, pipe, tube, fittings, elbows, tees, reducers, olets, valves, PVF, plate, bar, structural steel, beams, angle, channel, expansion joints, stainless, carbon steel, alloy, duplex, Inconel, Monel, Hastelloy, titanium, Xylan, galvanized, MRO, plant maintenance, industrial supply, hardware",
];
const DASH = /[–—]/;
const PHONE = /(?<!\d)\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com" };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/** The test lead: an Amarillo, TX fabricator, 304 and 316 plate, duplex sometimes, nothing said about how they file vendors. */
const TEST_LEAD = (over: Partial<LineCardRequest> = {}): LineCardRequest => ({
  requested: true, requester: { name: "Walt", email: "waltboxwell@gmail.com", title: null, isGatekeeper: false }, forwardTo: null, filingMethod: "unknown", filingEvidence: null,
  relevantFamilies: ["plate_bar", "bolts", "nuts", "gaskets"], specificItems: ["304 plate", "316 plate"], transcriptFacts: ["they are a fab shop in Amarillo", "they do a lot of stainless work, 304 and 316 plate", "duplex sometimes"],
  openNeed: null, pastBenchmark: false, wants: { fullText: false, pdfOnly: false, setupPacket: false }, format: "full_text", reason: "", confidence: 1, ...over,
});
const TEST_OPENER = { opener: "Thanks for taking my call this morning. You said the shop does a lot of stainless work, mostly 304 and 316 plate, with some duplex from time to time." };
const TEST_TRANSCRIPT = "Prospect @ 0:10: We're a fab shop here in Amarillo. We do a lot of stainless work, 304 and 316 plate, duplex sometimes. Prospect @ 0:30: Sure, send me your line card.";

/** Key West Metal: she keeps a contact per vendor, in her own words. */
const KEY_WEST = (over: Partial<LineCardRequest> = {}): LineCardRequest => TEST_LEAD({
  requester: { name: "Dana", email: "dana@keywestmetal.com", title: "Purchasing", isGatekeeper: false }, filingMethod: "contact_card",
  filingEvidence: "I create a contact for each vendor and write what they offer line by line, then search my email when I need something.",
  transcriptFacts: ["small shop, a lot of stainless work, 304 and 316 plate and some duplex"], ...over,
});

test("the full text carries every item on the printed card, verbatim, and nothing about where we are", () => {
  const full = renderPlainText();
  const missing = EXPECTED.filter((s) => !full.includes(s));
  assert.deepEqual(missing, [], `missing from the full text: ${missing.join(" | ")}`);
  assert.equal(full.split("\n").filter((l) => FAMILIES.some((f) => l.startsWith(`${f.name}:`))).length, 12);
  assert.equal(full.split("\n").filter((l) => MATERIALS.some((m) => l.startsWith(`${m.name}:`))).length, 8);
  assert.ok(wordCount(full) > 600, `${wordCount(full)} words`);
  assert.ok(!LOCATION_WORDS.test(full) && !/\bHQ\b/.test(full));
  assert.ok(!/\t|^\s*[-*•]/m.test(full), "no tabs or bullets");
});

test("the short version is short, says who to call, and is the only thing Standard and Gatekeeper carry", () => {
  const short = renderShort(rep);
  assert.ok(wordCount(short) < 300, `${wordCount(short)} words`);
  assert.ok(short.includes("Rep: Walt Boxwell, walt@westgatesupply.com. Website: westgatesupply.com. Quotes: sales@westgatesupply.com."));
  assert.ok(!short.includes("Hastelloy C-276") && !short.includes("Xylan 1424"), "the grade lists live in the full text only");
  assert.ok(!LOCATION_WORDS.test(short));
});

test("full_text for the test lead: the section 8 structure in order, one PDF, one No minimum, no locations, no phone", () => {
  const e = composeLineCardEmail({ req: TEST_LEAD(), format: "full_text", opener: TEST_OPENER, rep, first: "Walt", company: "Test Lead Fabrication, Inc.", seed: "lead_test", attached: { vcf: false, w9: false } });
  const b = e.body;
  assert.ok(!LOCATION_WORDS.test(b) && !LOCATION_WORDS.test(e.subject), "zero location words");
  assert.equal(count(b, /\bPDF\b/g), 1);
  assert.equal(count(b.replace(renderPlainText(), ""), /\battached\b/gi), 1, "attached once outside the block");
  assert.equal(count(b, /\bNo minimum/g), 1);
  assert.ok(count(b, /\bMTR/g) <= 2);
  assert.ok(!PHONE.test(b), "no phone number with the config phone unset");
  assert.ok(b.includes(FALLBACK_SECOND), "nothing said about filing: the fixed second sentence");
  assert.ok(!/you said you file|the way you file|your vendor contact|contact card/i.test(b));
  // The structure, in order.
  const paras = b.split("\n\n");
  assert.equal(paras[0], "Hi Walt,");
  assert.equal(paras[1], `${TEST_OPENER.opener} ${FALLBACK_SECOND}`);
  assert.equal(paras[2], "Call us when you need: 304 plate, 316 plate, plate, bar and structural.");
  // 4 header lines, 12 product lines, 8 material lines, coatings and operator specs, keywords: the block, literally.
  assert.equal(paras.slice(3, 8).join("\n\n"), renderPlainText(), "the block, header through keywords, as one literal piece");
  const lines = paras[3].split("\n");
  assert.deepEqual(lines, [
    "Westgate Supply: fasteners, PVF (pipe, valves, fittings), gaskets, flanges and metals.",
    "Website: westgatesupply.com. Quotes: sales@westgatesupply.com.",
    "No minimum order. Full traceability. Certified test reports (MTRs) to ASTM, ASME, ANSI, ISO, DIN, NACE and PED.",
    "We quote RFQs, line lists and fabrication drawings, any quantity, certs attached.",
  ]);
  assert.equal(paras[4].split("\n").length, 13, "Product lines: label plus 12");
  assert.equal(paras[5].split("\n").length, 9, "Materials and grades: label plus 8");
  assert.ok(paras[6].startsWith("Coatings, platings and finishes:") && paras[6].split("\n")[1].startsWith("Operator coating specs:"));
  assert.ok(paras[7].startsWith("Search keywords: fasteners, bolts,"));
  assert.equal(paras[8], "Send me your next list or RFQ and I will price it.");
  assert.equal(paras[9], "Thanks,\nWalt Boxwell");
  assert.equal(paras[10], SIGNATURE_TEXT, "the signature keyword line is the last line");
  assert.equal(paras.length, 11, "no other paragraphs");
  assert.ok(!DASH.test(b));
  assert.ok(e.subject.startsWith("Westgate Supply: 304 plate, 316 plate, ") && e.subject.length <= 70, e.subject);
  assert.deepEqual(validateLineCardEmail(e, TEST_LEAD(), "full_text", e.personalized, TEST_TRANSCRIPT).filter((p) => p.hard), []);
});

test("Key West Metal: the opener references the contact card in her words' wake, still zero location words", () => {
  const e = composeLineCardEmail({ req: KEY_WEST(), format: "full_text", opener: TEST_OPENER, rep, first: "Dana", company: "Key West Metal", seed: "lead_kw", attached: { vcf: false, w9: false } });
  assert.ok(e.body.includes("You said you keep a contact for each vendor, so I wrote our line card out below to paste into the notes. It is attached as a PDF too."));
  assert.ok(!LOCATION_WORDS.test(e.body));
  assert.equal(count(e.body, /\bPDF\b/g), 1);
  assert.ok(e.body.includes(renderPlainText()));
  assert.deepEqual(validateLineCardEmail(e, KEY_WEST(), "full_text", e.personalized, "I create a contact for each vendor").filter((p) => p.hard), []);
  // The same words without evidence on record never get written.
  const assumed = composeLineCardEmail({ req: KEY_WEST({ filingMethod: "contact_card", filingEvidence: null }), format: "full_text", opener: TEST_OPENER, rep, first: "Dana", company: "Key West Metal", seed: "lead_kw", attached: { vcf: false, w9: false } });
  assert.ok(assumed.body.includes(FALLBACK_SECOND));
});

test("the closing follows the state; never an old-RFQ ask or 'no pressure'", () => {
  assert.equal(closingFor(TEST_LEAD()), "Send me your next list or RFQ and I will price it.");
  assert.equal(closingFor(TEST_LEAD({ openNeed: "the pump skid" })), "Send over the pump skid list whenever it is ready and I will price it.");
  assert.equal(closingFor(TEST_LEAD({ pastBenchmark: true })), "Send me your next list or RFQ and I will price it.");
  assert.equal(closingFor(TEST_LEAD({ requester: { name: "Front Desk", email: "info@x.com", title: null, isGatekeeper: true } })), "If you can pass this along to whoever buys materials, I would appreciate it.");
});

test("Standard and Gatekeeper carry the short block; Contact card carries the full text; all stay inside the rules", () => {
  const std = composeLineCardEmail({ req: TEST_LEAD(), format: "standard", opener: TEST_OPENER, rep, first: "Walt", company: "Test Lead Fabrication, Inc.", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(std.body.includes(renderShort(rep)) && !std.body.includes("Hastelloy C-276"));
  assert.deepEqual(validateLineCardEmail(std, TEST_LEAD(), "standard", std.personalized, TEST_TRANSCRIPT).filter((p) => p.hard), []);
  const gkReq = TEST_LEAD({ requester: { name: "Front Desk", email: "info@acmefab.com", title: "front desk", isGatekeeper: true }, forwardTo: { name: "Mike", role: "purchasing" }, specificItems: [] });
  const gk = composeLineCardEmail({ req: gkReq, format: "gatekeeper", opener: { opener: "Thanks for taking my call this afternoon. You mentioned Mike handles the buying for the shop." }, rep, first: null, company: "Acme Fabrication", seed: "g", attached: { vcf: false, w9: false } });
  assert.ok(gk.body.includes(renderShort(rep)) && gk.body.includes("If you can pass this along to whoever buys materials, I would appreciate it."));
  assert.equal(gk.subject, "Westgate Supply line card for Acme Fabrication: fasteners, gaskets");
  assert.deepEqual(validateLineCardEmail(gk, gkReq, "gatekeeper", gk.personalized, "").filter((p) => p.hard), []);
  const card = composeLineCardEmail({ req: KEY_WEST(), format: "contact_card", opener: TEST_OPENER, rep, first: "Dana", company: "Key West Metal", seed: "c", attached: { vcf: true, w9: false } });
  assert.ok(card.body.includes(renderPlainText()) && card.body.includes("contact card (.vcf)"));
  assert.deepEqual(validateLineCardEmail(card, KEY_WEST(), "contact_card", card.personalized, "").filter((p) => p.hard), []);
  for (const e of [std, gk, card]) assert.ok(!LOCATION_WORDS.test(e.body) && !PHONE.test(e.body) && count(e.body, /\bPDF\b/g) <= 1 && count(e.body, /\bNo minimum/g) <= 1);
});

test("validation: a location word, a stray phone number, a second PDF, or an assumed filing method fails the draft", () => {
  const req = TEST_LEAD();
  const e = composeLineCardEmail({ req, format: "full_text", opener: TEST_OPENER, rep, first: "Walt", company: "X", seed: "v", attached: { vcf: false, w9: false } });
  const rules = (body: string, r = req) => validateLineCardEmail({ ...e, body }, r, "full_text", body.split("\n\n").slice(1, 3).join("\n\n"), TEST_TRANSCRIPT).filter((p) => p.hard).map((p) => p.rule);
  assert.ok(rules(e.body.replace("Thanks for taking", "We ship from Houston. Thanks for taking")).includes("location"));
  assert.ok(rules(e.body.replace("Thanks for taking", "Call me at (415) 555-0100. Thanks for taking")).includes("phone"));
  assert.ok(rules(e.body.replace("Thanks for taking", "The PDF is attached. Thanks for taking")).includes("repeat"));
  assert.ok(rules(e.body.replace("Thanks for taking", "You said you file vendors by contact. Thanks for taking")).includes("assumed"));
  assert.ok(rules(e.body.replace("Thanks for taking", "No minimum order here. Thanks for taking")).includes("repeat"));
  assert.deepEqual(rules(e.body), []);
});

test("no em or en dash in any renderer output; the vCard NOTE has the full text", () => {
  for (const out of [renderPlainText(), renderShort(), renderHtml(), renderNiche(["studs", "gaskets"]), renderVendorRow(rep), renderVcf(rep)]) assert.ok(!DASH.test(out));
  const note = renderVcf(rep).replace(/\r\n /g, "").split("\r\n").find((l) => l.startsWith("NOTE:"))!;
  assert.ok(note.includes("Hastelloy C-276") && note.includes("Xylan 1424") && note.includes("Studs and stud bolts: A193 B7"));
});

test("on the call (10/7): the rep picks how they want it, and the send is built in that shape", async () => {
  const { lineCardFor, mailDns } = await import("../src/linecard.js");
  const { demoLlm, FakeClose } = await import("../src/demo.js");
  const { DEMO_LEAD_ID, DEMO_USER_ID } = await import("../src/fixtures.js");
  mailDns.resolveMx = (async () => [{ exchange: "mx.example.com", priority: 10 }]) as never;
  const d = { close: new FakeClose(), llm: demoLlm, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles" } };
  const get = (format: "standard" | "full_text" | "pdf_only" | "vendor_row") => lineCardFor(d as never, DEMO_LEAD_ID, { to: "renee@roddaelectric.com", name: "Renee", buys: ["Threaded rod", "Beam clamps"], format });
  const pdf = await get("pdf_only");
  assert.ok(pdf.body.includes("Here's our line card. We do threaded rod, beam clamps, plus a lot more.\n\nIt's attached as a PDF.\n\nShoot me a quick"));
  assert.ok(!pdf.body.includes("What we carry:") && !pdf.body.includes("Product lines:"));
  const full = await get("full_text");
  assert.ok(full.body.includes(renderPlainText()) && !full.body.includes("What we carry:"));
  const row = await get("vendor_row");
  assert.ok(row.body.includes(renderVendorRow(rep)) && row.body.includes(renderShort(rep)));
  const std = await get("standard");
  assert.ok(std.body.includes(renderShort(rep)) && !std.body.includes("Product lines:"));
  for (const e of [pdf, full, row, std]) {
    assert.ok(e.body.endsWith(SIGNATURE_TEXT) && e.subject.startsWith("Westgate Supply: threaded rod, beam clamps") && !LOCATION_WORDS.test(e.body) && !PHONE.test(e.body), e.format);
    assert.equal(count(e.body, /\bPDF\b/g), 1, `${e.format}: PDF once`);
  }
});
