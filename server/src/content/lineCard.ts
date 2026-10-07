/**
 * The line card, as data (Walt 10/7). Every product family, grade, coating, warehouse and keyword from the printed
 * PDF lives here and nowhere else: the emails, the vCard and the vendor-list row are all rendered from this object,
 * so the text a buyer searches for later can't drift from the card.
 *
 * Why text at all: buyers find a vendor months later by typing a product word into their inbox, their contacts, or
 * a vendor spreadsheet. A PDF attachment is searchable in none of those reliably. Plain words in the subject and
 * body are.
 *
 * Plain hyphens (17-4 PH, A516-70) are fine; no em or en dashes anywhere in here, they're banned in every email.
 */

export type ProductFamilyId =
  | "studs" | "nuts" | "washers" | "bolts" | "threaded_rod" | "u_bolts"
  | "gaskets" | "flanges" | "pipe_fittings" | "plate_bar" | "expansion" | "specialty";

export type ProductFamily = {
  id: ProductFamilyId;
  /** The family name as printed, e.g. "Studs and stud bolts". */
  name: string;
  /** Every item under it on the card, in print order. */
  items: string[];
  /** The 3 to 5 that go in the short version. */
  key: string[];
};

export const COMPANY = {
  name: "Westgate Supply",
  tagline: "national supplier of fasteners, PVF (pipe, valves, fittings), gaskets, flanges and metals",
  /** What we supply, for the email header: no "national", no locations (Walt 10/7: nothing about where we are, ever). */
  lines: "fasteners, PVF (pipe, valves, fittings), gaskets, flanges and metals",
  website: "westgatesupply.com",
  lineCardPage: "westgatesupply.com/linecard",
  lineCardPdf: "https://westgatesupply.com/brand/westgate-line-card.pdf",
  quotes: "sales@westgatesupply.com",
  hq: { street: "580 Howard Street", city: "San Francisco", state: "CA", zip: "94105", country: "USA" },
  warehouses: ["Oakland, CA", "Houston, TX", "Burbank, IL"] as const,
  terms: ["No minimum order", "Full traceability", "Certified test reports (MTRs) to ASTM, ASME, ANSI, ISO, DIN, NACE and PED"],
  quoteLine: "We quote RFQs, line lists and fabrication drawings, any quantity, certs attached.",
};

export const FAMILIES: ProductFamily[] = [
  {
    id: "studs", name: "Studs and stud bolts",
    items: ["A193 B7", "A193 B7M", "A193 B16", "A320 L7", "A320 L7M", "A320 L43", "A193 B8", "A193 B8M", "A453 660", "NACE MR0175 sour service grades", "double end", "tap end", "continuous thread", "flange bolt-up"],
    key: ["A193 B7", "B7M", "A320 L7", "B8M", "NACE sour service"],
  },
  {
    id: "nuts", name: "Nuts",
    items: ["A194 2H", "A194 2HM", "A194 4", "A194 7", "A194 7M", "A194 8", "A194 8M", "duplex 2205", "heavy hex", "finished hex", "jam", "lock", "stover", "nylon insert"],
    key: ["A194 2H", "2HM", "8M", "heavy hex", "lock nuts"],
  },
  {
    id: "washers", name: "Washers and Belleville springs",
    items: ["F436", "flat", "heavy", "structural", "custom OD", "Belleville spring washers", "flange washers"],
    key: ["F436", "structural", "Belleville spring washers"],
  },
  {
    id: "bolts", name: "Bolts and screws",
    items: ["heavy hex", "12 point", "flange bolts", "A193", "A320", "A325", "A490", "F3125", "B7", "B7M", "B16", "B8", "B8M", "socket head cap screws", "machine screws", "set screws"],
    key: ["heavy hex", "A325", "A490", "F3125", "socket head cap screws"],
  },
  {
    id: "threaded_rod", name: "Threaded rod and custom machining",
    items: ["continuous thread rod", "cut lengths", "metric", "8UN", "UNC", "UNF", "ACME", "spindles", "shafts", "machined parts to drawing"],
    key: ["continuous thread rod", "cut lengths", "metric", "machined parts to drawing"],
  },
  {
    id: "u_bolts", name: "Bent bolts, U-bolts and pipe supports",
    items: ["U-bolts rolled to pipe size", "L bolts", "J bolts", "anchor bolts", "pipe clamps", "beam clamps", "hangers", "saddles", "slide plates"],
    key: ["U-bolts to pipe size", "anchor bolts", "pipe clamps", "beam clamps", "hangers"],
  },
  {
    id: "gaskets", name: "Gaskets and sealing",
    items: ["spiral wound", "ring joint (RTJ)", "CG", "CGI", "kammprofile", "sheet gaskets", "flange insulation kits", "ASME B16.20"],
    key: ["spiral wound", "ring joint (RTJ)", "kammprofile", "sheet gaskets", "flange insulation kits"],
  },
  {
    id: "flanges", name: "Flanges and blinds",
    items: ["weld neck (RFWN)", "slip on (RFSO)", "blind", "orifice", "spectacle blinds", "Class 150 to 2500", "A105", "LF2", "F304", "F316", "F51", "nickel alloys"],
    key: ["weld neck", "slip on", "blind", "Class 150 to 2500", "A105 and stainless"],
  },
  {
    id: "pipe_fittings", name: "Pipe, tube and fittings",
    items: ["butt weld fittings ASME B16.9", "forged fittings 3000# and 6000#", "olets", "pipe and tube", "carbon through duplex", "MTRs included"],
    key: ["butt weld fittings", "forged fittings 3000# and 6000#", "olets", "pipe and tube", "carbon through duplex"],
  },
  {
    id: "plate_bar", name: "Plate, bar and structural",
    items: ["round bar", "flat bar", "hex bar", "plate", "sheet", "angle", "channel", "beam", "HSS tube", "skid frames"],
    key: ["plate", "round and flat bar", "angle", "channel", "beam", "HSS tube"],
  },
  {
    id: "expansion", name: "Expansion joints and protection",
    items: ["rubber", "EPDM", "PTFE", "metallic expansion joints", "flange protectors", "pipe caps", "thread protectors"],
    key: ["rubber and PTFE expansion joints", "metallic expansion joints", "flange protectors", "pipe caps"],
  },
  {
    id: "specialty", name: "Specialty hardware",
    items: ["orifice plates", "threaded inserts", "helicoils", "pins", "rivets", "stainless nameplates and tags"],
    key: ["orifice plates", "threaded inserts", "helicoils", "nameplates and tags"],
  },
];

export const MATERIALS: Array<{ name: string; grades: string[] }> = [
  { name: "Carbon steel", grades: ["A307 Gr A", "A307 Gr B", "SAE J429 Gr 2", "Gr 5", "Gr 8", "A449", "A325", "A490", "A36", "A516-70", "AR400", "A105", "A105N", "A350 LF2", "1018", "1045", "1144", "Class 8.8", "Class 10.9", "Class 12.9"] },
  { name: "Alloy steel", grades: ["4140", "4340", "8620", "A193 B7", "A193 B7M", "A193 B16", "A320 L7", "A320 L7M", "A320 L43", "A354 Gr BD", "A694 F65", "chrome moly F11", "F22", "P11", "P22"] },
  { name: "Stainless steel", grades: ["303", "304", "304L", "309", "310", "316", "316L", "317L", "321", "347", "410", "416", "17-4 PH", "17-7 PH", "904L", "Alloy 20", "A286", "XM-19", "254 SMO", "AL-6XN", "Nitronic 50", "Nitronic 60"] },
  { name: "Stainless fastener grades", grades: ["A193 B8", "A193 B8M (Class 1 and 2)", "A193 B8C", "A193 B8T", "A193 B8R", "A193 B8S", "A320 B8", "A320 B8M", "A453 Gr 660 (A, B, D)"] },
  { name: "Duplex and super duplex", grades: ["2205 (S31803, S32205 dual cert)", "2507 (S32750, S32760)", "Zeron 100", "F51", "F53", "F55", "fasteners", "bar", "plate", "fittings"] },
  { name: "Nickel alloys", grades: ["Nickel 200", "Monel 400", "Monel K-500", "Inconel 600", "Inconel 601", "Inconel 625", "Inconel 718", "Inconel X-750", "Inconel 925", "Incoloy 800H", "Incoloy 825", "Hastelloy C-22", "Hastelloy C-276"] },
  { name: "Copper alloys", grades: ["copper", "brass", "naval brass", "silicon bronze", "aluminum bronze", "phosphor bronze", "cupro-nickel"] },
  { name: "Titanium, iron and non-metallics", grades: ["titanium Gr 2", "titanium Gr 5 (B348, B381)", "ductile iron", "malleable iron", "soft iron", "F5 ring gaskets", "PTFE bar", "EPDM", "neoprene", "Viton", "aluminum 6061", "aluminum 5052", "specialty alloys on request"] },
];

export const COATINGS: string[] = [
  "Hot dip galvanized", "mechanical galvanizing", "zinc plating", "yellow zinc dichromate", "Xylan 1424", "Xylan 1014", "Xylan 1070", "Xylan 1052", "Xylar 2", "PTFE", "fluoropolymer",
  "Teflon blue", "phosphate (zinc and manganese)", "black oxide", "cadmium (ASTM B766)", "Armoloy", "Sermagard", "MoS2", "nickel", "copper", "chrome", "silver", "gold",
  "electropolishing", "passivation", "anodizing", "O2 cleaning", "FBE fusion bond epoxy", "and more",
];
export const OPERATOR_SPECS = ["Chevron", "ExxonMobil", "BP", "Baker Hughes", "Schlumberger", "NOV", "Aker Solutions"];
export const OPERATOR_LINE = `Operator coating specs: ${OPERATOR_SPECS.join(", ")} and more. Tell us the spec and we ship to it.`;

export const KEYWORDS: string[] = [
  "fasteners", "bolts", "nuts", "studs", "stud bolts", "washers", "threaded rod", "all thread", "U-bolts", "anchor bolts", "gaskets", "flanges", "pipe", "tube", "fittings",
  "elbows", "tees", "reducers", "olets", "valves", "PVF", "plate", "bar", "structural steel", "beams", "angle", "channel", "expansion joints", "stainless", "carbon steel",
  "alloy", "duplex", "Inconel", "Monel", "Hastelloy", "titanium", "Xylan", "galvanized", "MRO", "plant maintenance", "industrial supply", "hardware",
];

/**
 * The line under the sign-off on every line card email (Walt 10/7): a two-line reply from Walt is still findable by
 * product word. No locations. The page link only once the page is live (config.linecardPageLive).
 */
export const SIGNATURE_TEXT = "Westgate Supply supplies fasteners, studs, nuts, gaskets, flanges, pipe, fittings, plate, bar and structural steel in carbon, stainless, alloy, duplex, nickel alloys and titanium.";
export function signatureLine(pageLive = false): string {
  return pageLive ? `${SIGNATURE_TEXT} ${COMPANY.lineCardPage}` : SIGNATURE_TEXT;
}
export const isSignatureLine = (s: string) => s === SIGNATURE_TEXT || s === `${SIGNATURE_TEXT} ${COMPANY.lineCardPage}`;

/** Short family words for subjects and the vendor row, in print order. */
export const FAMILY_WORDS: Record<ProductFamilyId, string> = {
  studs: "stud bolts", nuts: "nuts", washers: "washers", bolts: "bolts", threaded_rod: "threaded rod", u_bolts: "U-bolts", gaskets: "gaskets", flanges: "flanges",
  pipe_fittings: "pipe and fittings", plate_bar: "plate and structural", expansion: "expansion joints", specialty: "specialty hardware",
};
export const FAMILY_IDS = FAMILIES.map((f) => f.id);
export const familyById = (id: ProductFamilyId) => FAMILIES.find((f) => f.id === id)!;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export type RenderOpts = { phone?: string | null };
/** The 4 header lines of the email block. Phone only from config; never a location (the HQ and warehouses stay in the data for the website). */
function companyLines(opts: RenderOpts = {}): string[] {
  return [
    `${COMPANY.name}: ${COMPANY.lines}.`,
    `Website: ${COMPANY.website}. Quotes: ${COMPANY.quotes}.${opts.phone ? ` Phone: ${opts.phone}.` : ""}`,
    `${COMPANY.terms.join(". ")}.`,
    COMPANY.quoteLine,
  ];
}

/**
 * The whole card as lines of text: one "Family: items" line per family, materials and coatings one line each, the
 * keywords last. No bullets, no tabs, no em or en dashes, so it pastes clean into a contact note or a spreadsheet cell.
 */
export function plainTextLines(opts: RenderOpts = {}): string[] {
  return [
    ...companyLines(opts),
    "",
    "Product lines:",
    ...FAMILIES.map((f) => `${f.name}: ${f.items.join(", ")}`),
    "",
    "Materials and grades:",
    ...MATERIALS.map((m) => `${m.name}: ${m.grades.join(", ")}`),
    "",
    `Coatings, platings and finishes: ${COATINGS.join(", ")}`,
    OPERATOR_LINE,
    "",
    `Search keywords: ${KEYWORDS.join(", ")}`,
  ];
}
export function renderPlainText(opts: RenderOpts = {}): string {
  return plainTextLines(opts).join("\n");
}

/** The same lines as unstyled paragraphs, for the HTML half of an email. */
export function renderHtml(opts: RenderOpts = {}): string {
  return plainTextLines(opts).filter((l) => l !== "").map((l) => `<p>${esc(l)}</p>`).join("");
}

/**
 * The 12 families with their key specs, materials and coatings one line each, who to call, the keyword line.
 * Under 300 words. Standard and Gatekeeper formats only; everything else carries the full text.
 */
export function renderShort(rep: RepCard = { name: "Walt Boxwell", email: "walt@westgatesupply.com" }): string {
  return [
    "What we carry:",
    ...FAMILIES.map((f) => `${f.name}: ${f.key.join(", ")}`),
    `Materials: carbon, alloy, stainless, duplex and super duplex, nickel alloys (Inconel, Monel, Hastelloy), copper alloys, titanium.`,
    `Coatings: hot dip galvanized, zinc, Xylan, PTFE, phosphate, black oxide, cadmium and more, to operator specs.`,
    `No minimum order. MTRs with every order.`,
    `Rep: ${rep.name}, ${rep.email}. Website: ${COMPANY.website}. Quotes: ${COMPANY.quotes}.`,
    `Keywords: ${KEYWORDS.join(", ")}.`,
  ].join("\n");
}

/** The families they buy, with every item listed, then one line naming the rest. */
export function renderNiche(ids: ProductFamilyId[]): string {
  const picked = FAMILIES.filter((f) => ids.includes(f.id));
  const rest = FAMILIES.filter((f) => !ids.includes(f.id)).map((f) => f.name.toLowerCase());
  return [
    "What we carry for your work:",
    ...picked.map((f) => `${f.name}: ${f.items.join(", ")}`),
    `Materials: carbon, alloy, stainless, duplex and super duplex, nickel alloys, titanium. Coatings: hot dip galvanized, zinc, Xylan, PTFE and more.`,
    `We also carry: ${rest.join("; ")}.`,
  ].join("\n");
}

export type RepCard = { name: string; email: string; phone?: string | null; title?: string | null };

/** One line for a vendor spreadsheet or ERP vendor list: pipes between columns, no tabs. */
export function renderVendorRow(rep: RepCard): string {
  const categories = FAMILY_IDS.map((id) => FAMILY_WORDS[id]).join(", ");
  return [COMPANY.name, rep.name, rep.email, rep.phone ?? null, categories, COMPANY.website].filter((x): x is string => !!x).join(" | ");
}

/** vCard 3.0 for the buyer who keeps a contact per vendor: the whole card in NOTE, lines folded at 75 octets. */
export function renderVcf(rep: RepCard): string {
  const vesc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const [first, ...restName] = rep.name.split(/\s+/);
  const last = restName.join(" ");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${vesc(last)};${vesc(first)};;;`,
    `FN:${vesc(rep.name)}`,
    `ORG:${vesc(COMPANY.name)}`,
    `TITLE:${vesc(rep.title ?? "Sales")}`,
    `EMAIL;TYPE=INTERNET,WORK:${rep.email}`,
    ...(rep.phone ? [`TEL;TYPE=WORK,VOICE:${rep.phone}`] : []),
    `URL:https://${COMPANY.website}`,
    `NOTE:${vesc(renderPlainText({ phone: rep.phone }))}`,
    "END:VCARD",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** RFC 2426 line folding: at most 75 octets per physical line, continuation lines start with one space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    const limit = out.length ? 74 : 75; // continuation lines carry a leading space
    if (bytes + b > limit) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ` ${l}` : l)).join("\r\n");
}

/**
 * Every product, grade and coating string on the card, normalized (upper case, no spaces or hyphens), for the
 * check that nothing in an email names a spec we don't carry.
 */
export function cardTerms(): Set<string> {
  const norm = (s: string) => s.toUpperCase().replace(/[\s\-_/()]+/g, "");
  const out = new Set<string>();
  const add = (s: string) => {
    out.add(norm(s));
    // "A193 B7" is also searched as "A193" and "B7"; "2205 (S31803, S32205 dual cert)" as each code.
    for (const w of s.split(/[\s,()]+/)) if (/\d/.test(w)) out.add(norm(w));
  };
  for (const f of FAMILIES) for (const i of f.items) add(i);
  for (const m of MATERIALS) for (const g of m.grades) add(g);
  for (const c of COATINGS) add(c);
  for (const k of KEYWORDS) add(k);
  return out;
}

/** Terms a transcript may use for a family, for mapping what a buyer said to the families they'd buy. */
export const FAMILY_HINTS: Record<ProductFamilyId, RegExp> = {
  studs: /\bstuds?\b|stud bolts?|\bb7\b|\bl7\b|sour service|nace|bolt-?up/i,
  nuts: /\bnuts?\b|\b2h\b|heavy hex nut/i,
  washers: /washers?|belleville|f436/i,
  bolts: /\bbolts?\b|a325|a490|f3125|cap screws?|machine screws?|set screws?|12 point|hex head/i,
  threaded_rod: /threaded rod|all ?thread|\brod\b|machin(ed|ing)|spindles?|shafts?|\bacme\b/i,
  u_bolts: /u-?bolts?|anchor bolts?|pipe (supports?|clamps?|hangers?)|beam clamps?|hangers?|saddles?|slide plates?|\bj bolts?\b|\bl bolts?\b|strut/i,
  gaskets: /gaskets?|spiral wound|ring joint|\brtj\b|kammprofile|insulation kits?/i,
  flanges: /flanges?|weld neck|slip on|blind|spectacle|orifice flange/i,
  pipe_fittings: /\bpipe\b|\btube\b|\btubing\b|fittings?|elbows?|\btees?\b|reducers?|olets?|butt weld|forged|\bpvf\b|valves?/i,
  plate_bar: /\bplate\b|\bsheet\b|\bbar\b|\bangle\b|\bchannel\b|\bbeams?\b|\bhss\b|structural|skid/i,
  expansion: /expansion joints?|flange protectors?|pipe caps?|thread protectors?/i,
  specialty: /orifice plates?|helicoils?|threaded inserts?|rivets?|nameplates?|\btags?\b|\bpins?\b/i,
};

/** The families a kind of company buys, when the call didn't say (always at least two). */
export const INDUSTRY_FAMILIES: Array<{ match: RegExp; families: ProductFamilyId[] }> = [
  { match: /hvac|mechanical|plumbing|sheet metal/i, families: ["u_bolts", "threaded_rod", "flanges", "pipe_fittings", "gaskets"] },
  { match: /fab|weld|machine shop|steel|structural|ironwork/i, families: ["plate_bar", "bolts", "nuts", "gaskets", "threaded_rod"] },
  { match: /plant|refiner|chemical|mill|maintenance|mro|power|energy|oil|gas|pipeline|terminal/i, families: ["studs", "nuts", "gaskets", "flanges", "pipe_fittings", "specialty"] },
  { match: /water|wastewater|municipal|utility|district|treatment/i, families: ["flanges", "gaskets", "bolts", "pipe_fittings"] },
  { match: /electric|solar|wind|telecom/i, families: ["threaded_rod", "u_bolts", "bolts", "plate_bar"] },
  { match: /contractor|construction|general/i, families: ["bolts", "threaded_rod", "u_bolts", "plate_bar"] },
];
export function familiesForIndustry(industry: string | null | undefined): ProductFamilyId[] {
  const hit = industry ? INDUSTRY_FAMILIES.find((r) => r.match.test(industry)) : null;
  return hit ? hit.families : ["studs", "flanges", "gaskets", "pipe_fittings"];
}
