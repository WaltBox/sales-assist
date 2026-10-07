import assert from "node:assert/strict";
import { test } from "node:test";
import { COATINGS, FAMILIES, familiesForIndustry, KEYWORDS, MATERIALS, renderHtml, renderNiche, renderPlainText, renderShort, renderVcf, renderVendorRow, signatureLine, SIGNATURE_TEXT, wordCount } from "../src/content/lineCard.js";

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com" };
const DASH = /[–—]/;

test("the full text carries every family, item, grade, coating and keyword from the printed card", () => {
  const text = renderPlainText();
  for (const f of FAMILIES) {
    assert.ok(text.includes(`${f.name}:`), f.name);
    for (const i of f.items) assert.ok(text.includes(i), `${f.name}: ${i}`);
  }
  for (const m of MATERIALS) for (const g of m.grades) assert.ok(text.includes(g), `${m.name}: ${g}`);
  for (const c of COATINGS) assert.ok(text.includes(c), c);
  for (const k of KEYWORDS) assert.ok(text.includes(k), k);
  for (const s of ["A193 B7", "A194 2H", "17-4 PH", "Hastelloy C-276", "Xylan 1424", "Zeron 100", "Inconel 625", "spiral wound", "ring joint (RTJ)", "Class 150 to 2500", "3000# and 6000#", "No minimum order", "NACE", "A453 660"]) {
    assert.ok(text.includes(s), s);
  }
  assert.equal(FAMILIES.length, 12);
  assert.ok(!DASH.test(text), "no em or en dashes");
  assert.ok(!/\t|^\s*[-*•]/m.test(text), "no tabs or bullets");
});

test("the email block never says where we are, and carries a phone only when one is passed in", () => {
  const text = renderPlainText();
  assert.ok(!/warehouse|Oakland|Houston|Burbank|San Francisco|Howard Street|national supplier|HQ/i.test(text), text.split("\n").slice(0, 5).join(" | "));
  assert.ok(text.startsWith("Westgate Supply: fasteners, PVF (pipe, valves, fittings), gaskets, flanges and metals.\nWebsite: westgatesupply.com. Quotes: sales@westgatesupply.com.\nNo minimum order. Full traceability. Certified test reports (MTRs) to ASTM, ASME, ANSI, ISO, DIN, NACE and PED.\nWe quote RFQs, line lists and fabrication drawings, any quantity, certs attached.\n"));
  assert.ok(!/\d{3}\D?\d{3}\D?\d{4}/.test(text), "no phone number unless configured");
  assert.ok(renderPlainText({ phone: "(832) 957-1722" }).includes("Quotes: sales@westgatesupply.com. Phone: (832) 957-1722."));
  assert.ok(!/warehouse|Oakland|Houston|Burbank/i.test(renderShort()));
});

test("the short version names all 12 families, says who to call, and stays under 300 words", () => {
  const short = renderShort(rep);
  assert.ok(wordCount(short) < 300, `${wordCount(short)} words`);
  for (const f of FAMILIES) assert.ok(short.includes(`${f.name}:`), f.name);
  assert.ok(short.includes("Rep: Walt Boxwell, walt@westgatesupply.com. Website: westgatesupply.com. Quotes: sales@westgatesupply.com."));
  assert.ok(short.includes("Keywords:"));
  assert.ok(!DASH.test(short));
});

test("the niche version lists the picked families in full and names the rest", () => {
  const n = renderNiche(["u_bolts", "gaskets"]);
  assert.ok(n.includes("U-bolts rolled to pipe size") && n.includes("slide plates"));
  assert.ok(n.includes("spiral wound") && n.includes("ASME B16.20"));
  assert.ok(!n.includes("A193 B7"), "studs aren't listed in full");
  assert.ok(/We also carry: studs and stud bolts; nuts;/.test(n));
});

test("HTML is one unstyled paragraph per line, escaped", () => {
  const h = renderHtml();
  assert.ok(h.startsWith("<p>Westgate Supply:"));
  assert.ok(h.includes("<p>Studs and stud bolts: A193 B7"));
  assert.ok(!/<p><\/p>/.test(h));
  assert.ok(h.includes("3000# and 6000#"));
});

test("the vendor row is one pipe-separated line, phone only when set, no tabs, no locations", () => {
  const row = renderVendorRow(rep);
  assert.equal(row.split(" | ").length, 5);
  assert.ok(row.startsWith("Westgate Supply | Walt Boxwell | walt@westgatesupply.com | stud bolts,"));
  assert.ok(renderVendorRow({ ...rep, phone: "(832) 957-1722" }).includes(" | (832) 957-1722 | "));
  assert.ok(!/\t|\n|Oakland|Houston|Burbank/.test(row));
});

/** A strict vCard 3.0 reader: unfold, split name;params:value, unescape. */
function parseVcf(text: string) {
  assert.ok(text.endsWith("\r\n"), "CRLF line ends");
  const physical = text.split("\r\n").slice(0, -1);
  for (const l of physical) assert.ok(Buffer.byteLength(l, "utf8") <= 75, `line over 75 octets: ${l.length}`);
  const logical: string[] = [];
  for (const l of physical) {
    if (l.startsWith(" ") && logical.length) logical[logical.length - 1] += l.slice(1);
    else logical.push(l);
  }
  const props: Record<string, { params: string[]; value: string }> = {};
  for (const l of logical) {
    const m = /^([A-Z]+)((?:;[^:]+)*):(.*)$/.exec(l);
    assert.ok(m, `bad line: ${l}`);
    props[m[1]] = { params: m[2] ? m[2].slice(1).split(";") : [], value: m[3].replace(/\\n/g, "\n").replace(/\\([,;\\])/g, "$1") };
  }
  return { logical, props };
}

test("the vCard parses, carries the whole card in NOTE, folds at 75 octets, and has a TEL only with a phone", () => {
  const vcf = renderVcf({ ...rep, phone: "(832) 957-1722" });
  const { logical, props } = parseVcf(vcf);
  assert.equal(logical[0], "BEGIN:VCARD");
  assert.equal(logical[logical.length - 1], "END:VCARD");
  assert.equal(props.VERSION.value, "3.0");
  assert.equal(props.FN.value, "Walt Boxwell");
  assert.equal(props.N.value, "Boxwell;Walt;;;");
  assert.equal(props.ORG.value, "Westgate Supply");
  assert.equal(props.EMAIL.value, "walt@westgatesupply.com");
  assert.equal(props.TEL.value, "(832) 957-1722");
  assert.ok(!props.ADR, "no address: nothing about where we are");
  assert.equal(props.NOTE.value, renderPlainText({ phone: "(832) 957-1722" }), "NOTE is the full text card, newlines escaped");
  assert.ok(!parseVcf(renderVcf(rep)).props.TEL);
});

test("the signature line, and the industry defaults", () => {
  assert.equal(signatureLine(), SIGNATURE_TEXT);
  assert.equal(SIGNATURE_TEXT, "Westgate Supply supplies fasteners, studs, nuts, gaskets, flanges, pipe, fittings, plate, bar and structural steel in carbon, stainless, alloy, duplex, nickel alloys and titanium.");
  assert.equal(signatureLine(true), `${SIGNATURE_TEXT} westgatesupply.com/linecard`);
  assert.ok(!DASH.test(SIGNATURE_TEXT) && !/warehouse|Oakland/i.test(SIGNATURE_TEXT));
  assert.deepEqual(familiesForIndustry("Mechanical contractor (HVAC)"), ["u_bolts", "threaded_rod", "flanges", "pipe_fittings", "gaskets"]);
  assert.ok(familiesForIndustry(null).length >= 2);
});
