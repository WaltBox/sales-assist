import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHtml, renderNiche, renderPlainText, renderShort, renderVcf, renderVendorRow, wordCount, FAMILIES } from "../src/content/lineCard.js";
import { composeLineCardEmail, type LineCardRequest } from "../src/linecardflow.js";

// The printed line card, item by item (Walt 10/7): every one of these must come through the full text verbatim,
// because buyers search their inbox and contacts for the exact grade string.
const EXPECTED = [
  // company
  "Westgate Supply", "national supplier of fasteners, PVF (pipe, valves, fittings), gaskets, flanges and metals", "Website: westgatesupply.com", "sales@westgatesupply.com",
  "580 Howard Street, San Francisco, CA", "Oakland, CA", "Houston, TX", "Burbank, IL", "No minimum order", "Full traceability",
  "Certified test reports (MTRs) to ASTM, ASME, ANSI, ISO, DIN, NACE and PED", "We quote RFQs, line lists and fabrication drawings, any quantity, certs attached.",
  // product lines
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
  // materials
  "Carbon steel:", "A307 Gr A", "Gr B", "SAE J429 Gr 2", "A449", "A36", "A516-70", "AR400", "A105N", "A350 LF2", "1018", "1045", "1144", "Class 8.8", "10.9", "12.9",
  "Alloy steel:", "4140", "4340", "8620", "A354 Gr BD", "A694 F65", "chrome moly F11", "F22", "P11", "P22",
  "Stainless steel:", "303", "304", "304L", "309", "310", "316", "316L", "317L", "321", "347", "410", "416", "17-4 PH", "17-7 PH", "904L", "Alloy 20", "A286", "XM-19", "254 SMO", "AL-6XN", "Nitronic 50", "Nitronic 60",
  "Stainless fastener grades:", "A193 B8", "B8M (Class 1 and 2)", "B8C", "B8T", "B8R", "B8S", "A320 B8", "A453 Gr 660 (A, B, D)",
  "Duplex and super duplex:", "2205 (S31803, S32205 dual cert)", "2507 (S32750, S32760)", "Zeron 100", "F53", "F55",
  "Nickel alloys:", "Nickel 200", "Monel 400", "Monel K-500", "Inconel 600", "601", "625", "718", "X-750", "925", "Incoloy 800H", "825", "Hastelloy C-22", "C-276",
  "Copper alloys:", "copper", "brass", "naval brass", "silicon bronze", "aluminum bronze", "phosphor bronze", "cupro-nickel",
  "Titanium, iron and non-metallics:", "titanium Gr 2", "Gr 5 (B348, B381)", "ductile iron", "malleable iron", "soft iron", "F5 ring gaskets", "PTFE bar", "neoprene", "Viton", "aluminum 6061", "5052", "specialty alloys on request",
  // coatings
  "Hot dip galvanized", "mechanical galvanizing", "zinc plating", "yellow zinc dichromate", "Xylan 1424", "1014", "1070", "1052", "Xylar 2", "fluoropolymer", "Teflon blue",
  "phosphate (zinc and manganese)", "black oxide", "cadmium (ASTM B766)", "Armoloy", "Sermagard", "MoS2", "nickel", "chrome", "silver", "gold", "electropolishing", "passivation",
  "anodizing", "O2 cleaning", "FBE fusion bond epoxy", "and more",
  "Operator coating specs: Chevron, ExxonMobil, BP, Baker Hughes, Schlumberger, NOV, Aker Solutions and more. Tell us the spec and we ship to it.",
  // keywords
  "fasteners, bolts, nuts, studs, stud bolts, washers, threaded rod, all thread, U-bolts, anchor bolts, gaskets, flanges, pipe, tube, fittings, elbows, tees, reducers, olets, valves, PVF, plate, bar, structural steel, beams, angle, channel, expansion joints, stainless, carbon steel, alloy, duplex, Inconel, Monel, Hastelloy, titanium, Xylan, galvanized, MRO, plant maintenance, industrial supply, hardware",
];
const DASH = /[–—]/;
const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com" };
const req = (over: Partial<LineCardRequest> = {}): LineCardRequest => ({
  requested: true, requester: { name: "Dana", email: "dana@keywestmetal.com", title: null, isGatekeeper: false }, forwardTo: null, filingMethod: "contact_card", filingEvidence: null,
  relevantFamilies: ["plate_bar", "bolts", "nuts", "gaskets"], specificItems: ["304 plate", "316 plate"], openNeed: null, pastBenchmark: false,
  wants: { fullText: false, pdfOnly: false, setupPacket: false }, warehouseNearest: "Houston, TX", driveTimeMinutes: null, format: "full_text", reason: "", confidence: 1, ...over,
});
const opener = { opener: "Thanks for taking my call this morning. You mentioned you do a lot of stainless work in 304 and 316 plate, with some duplex now and then, so I wrote our line card out below the way you said you file vendors and attached it as a PDF too.", nextStep: "Send me your next list or RFQ and I'll price it." };

test("the full text carries every item on the printed card, verbatim", () => {
  const full = renderPlainText();
  const missing = EXPECTED.filter((s) => !full.includes(s));
  assert.deepEqual(missing, [], `missing from the full text: ${missing.join(" | ")}`);
  const labelLines = full.split("\n").filter((l) => FAMILIES.some((f) => l.startsWith(`${f.name}:`)));
  assert.equal(labelLines.length, 12);
  assert.ok(wordCount(full) > 600, `${wordCount(full)} words`);
  assert.ok(!/\t|^\s*[-*•]/m.test(full), "no tabs or bullets");
});

test("the short version is short, says who to call, and is the only thing Standard and Gatekeeper carry", () => {
  const short = renderShort();
  assert.ok(wordCount(short) < 300, `${wordCount(short)} words`);
  assert.ok(short.includes("Rep: Walt Boxwell, walt@westgatesupply.com. Website: westgatesupply.com. Quotes: sales@westgatesupply.com."));
  assert.ok(!short.includes("Hastelloy C-276") && !short.includes("Xylan 1424"), "the grade lists live in the full text only");
});

test("Full text and Contact card bodies contain the full text as an exact substring; Standard contains the short version", () => {
  const full = composeLineCardEmail({ req: req(), format: "full_text", opener, rep, first: "Dana", company: "Key West Metal", seed: "lead_kw", attached: { vcf: false, w9: false } });
  assert.ok(full.body.includes(renderPlainText()), "full text is inserted literally, never paraphrased");
  const card = composeLineCardEmail({ req: req(), format: "contact_card", opener, rep, first: "Dana", company: "Key West Metal", seed: "lead_kw", attached: { vcf: true, w9: false } });
  assert.ok(card.body.includes(renderPlainText()));
  const std = composeLineCardEmail({ req: req({ filingMethod: "unknown" }), format: "standard", opener, rep, first: "Dana", company: "Key West Metal", seed: "lead_kw", attached: { vcf: false, w9: false } });
  assert.ok(std.body.includes(renderShort()));
  assert.ok(!std.body.includes("Hastelloy C-276"));
  const gk = composeLineCardEmail({ req: req({ requester: { name: "Front Desk", email: "info@x.com", title: null, isGatekeeper: true } }), format: "gatekeeper", opener, rep, first: null, company: "Acme Fab", seed: "s", attached: { vcf: false, w9: false } });
  assert.ok(gk.body.includes(renderShort()));
});

test("no em or en dash in any renderer output", () => {
  for (const out of [renderPlainText(), renderShort(), renderHtml(), renderNiche(["studs", "gaskets"]), renderVendorRow(rep), renderVcf(rep)]) assert.ok(!DASH.test(out));
});

test("the vCard NOTE carries the full text: Hastelloy C-276 and Xylan 1424 are in it", () => {
  const vcf = renderVcf(rep);
  const unfolded = vcf.replace(/\r\n /g, "");
  const note = unfolded.split("\r\n").find((l) => l.startsWith("NOTE:"))!;
  assert.ok(note.includes("Hastelloy C-276"), "Hastelloy C-276");
  assert.ok(note.includes("Xylan 1424"), "Xylan 1424");
  assert.ok(note.includes("Studs and stud bolts: A193 B7"));
});
