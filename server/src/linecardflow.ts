import { z } from "zod/v4";
import type { Deps } from "./assistant.js";
import { untrusted } from "./claude.js";
import { config } from "./config.js";
import { cardTerms, COMPANY, FAMILIES, FAMILY_HINTS, FAMILY_IDS, FAMILY_WORDS, familyById, familiesForIndustry, KEYWORDS, nearestWarehouse, renderNiche, renderPlainText, renderShort, renderVendorRow, SIGNATURE_LINE, wordCount, type ProductFamilyId, type Warehouse } from "./content/lineCard.js";
import { HEDGE, IDENTITY } from "./validate.js";
import { stripDashes } from "./benchmark.js";

/**
 * "Send us a line card" (Walt 10/7). The most common good outcome of a cold call, and the email has to do one job
 * well: be findable later. Buyers keep vendors in their inbox, their contacts, or a vendor list, and search them
 * by product word. A PDF is searchable in none of those reliably; words in the subject and body are. So every line
 * card email carries the card as text, a keyword subject, and the keyword line under the name, and the body is
 * shaped to how this buyer said they file vendors.
 */

export const SUBJECT_MAX = 70;
/** Two fixed words close every subject; they rotate so a buyer's inbox doesn't show ten identical ones. */
const FIXED_WORDS = ["fasteners", "gaskets", "flanges", "fittings", "pipe", "steel"];
const DASHES = /[–—]/;

export const FILING_METHODS = ["inbox_search", "contact_card", "spreadsheet", "erp_vendor_list", "print", "unknown"] as const;
export type FilingMethod = (typeof FILING_METHODS)[number];
export const FORMATS = ["standard", "full_text", "niche", "contact_card", "vendor_row", "gatekeeper", "setup_packet", "pdf_only"] as const;
export type EmailFormat = (typeof FORMATS)[number];
export const FORMAT_LABEL: Record<EmailFormat, string> = {
  standard: "Standard", full_text: "Full text", niche: "Niche", contact_card: "Contact card", vendor_row: "Vendor list row", gatekeeper: "Gatekeeper intro", setup_packet: "Vendor setup packet", pdf_only: "PDF only",
};
export const FORMAT_HELP: Record<EmailFormat, string> = {
  standard: "The short text line card, every family named.",
  full_text: "The whole card written out line by line, to paste into a contact or search later.",
  niche: "Only the families they buy, every item listed, plus one line naming the rest.",
  contact_card: "Full text plus the attached .vcf contact card.",
  vendor_row: "One line they can paste into their vendor spreadsheet, plus the short card.",
  gatekeeper: "For the person who'll pass it along: asks them to forward it to whoever buys materials.",
  setup_packet: "For 'send your W-9': the short card plus the vendor setup lines.",
  pdf_only: "They asked for just the PDF. Keyword subject and signature line still carry the words.",
};

export type LineCardRequest = {
  requested: boolean;
  requester: { name: string | null; email: string | null; title: string | null; isGatekeeper: boolean };
  forwardTo: { name: string | null; role: string | null } | null;
  filingMethod: FilingMethod;
  filingEvidence: string | null;
  relevantFamilies: ProductFamilyId[];
  specificItems: string[];
  openNeed: string | null;
  pastBenchmark: boolean;
  wants: { fullText: boolean; pdfOnly: boolean; setupPacket: boolean };
  warehouseNearest: Warehouse;
  driveTimeMinutes: number | null;
  format: EmailFormat;
  reason: string;
  confidence: number;
};

export const LineCardRequestSchema = z.object({
  requested: z.boolean().describe("True if they asked for or agreed to receive a line card or our info by email: 'send me/us a line card', 'shoot me an email', 'send over what you have', 'email it to me', 'add us to your list', or a yes when the rep offered to send it."),
  requester: z.object({
    name: z.string().nullable().describe("Who's getting the email, as said on the call. Null if nobody gave a name."),
    email: z.string().nullable().describe("The address they gave on the call, exactly as spelled out. Null if none."),
    title: z.string().nullable().describe("Their role if said: 'purchasing', 'office manager', 'front desk'."),
    isGatekeeper: z.boolean().describe("True for a front desk, receptionist, office manager, or anyone who said they'd pass it along to someone else."),
  }),
  forwardTo: z.object({ name: z.string().nullable(), role: z.string().nullable() }).nullable().describe("Who they said they'd pass it to ('I'll get it to Mike in purchasing'). Null if nobody."),
  filingMethod: z.enum(FILING_METHODS).describe("How they said they keep track of vendors. contact_card: 'I create a contact for each vendor', 'I put it in the notes'. inbox_search: 'I just search my email'. spreadsheet: 'our vendor list', 'spreadsheet'. erp_vendor_list: 'I'll put you in our system', Epicor, NetSuite, SAP, Dynamics, 'vendor master'. print: 'I'll print it for the binder'. unknown if they didn't say."),
  filingEvidence: z.string().nullable().describe("Their exact words that showed the method, one sentence from the transcript. Null if unknown."),
  productTerms: z.array(z.string()).describe("Product words they used for what they buy or build with, as said: 'pipe supports', 'U-bolts', 'B7 studs', 'plate'. Only what was said on the call."),
  specificItems: z.array(z.string()).describe("Exact grades or parts they named: 'B7 studs', '2H nuts', 'spiral wound', '4 inch flanges'. Empty if none."),
  openNeed: z.string().nullable().describe("Anything they said they're buying or pricing right now, in their words. Null if nothing is open."),
  pastBenchmark: z.boolean().describe("True if they hinted at a past RFQ or PO we could re-price."),
  wantsFullText: z.boolean().describe("True if they asked for it written out, line by line, in the email body, or something they can paste."),
  wantsPdfOnly: z.boolean().describe("True if they said just send the PDF and nothing else."),
  wantsSetupPacket: z.boolean().describe("True if they said we'd need to be set up as a vendor, asked for a W-9, COI, or vendor form, or mentioned an approved vendor list we'd need to get on."),
  confidence: z.number().describe("0 to 1: how sure you are they asked for the line card."),
});

/** Said how they file vendors, in words the rules can hear without the model. */
export function filingMethodFromText(text: string): FilingMethod | null {
  const t = text.toLowerCase();
  if (/\b(contact|contacts|address book|contact card)\b.*\b(vendor|supplier|each|every)\b|\b(vendor|supplier)\b.*\bcontact\b|notes? (field|section)|write (it|what they|what you) .{0,30}(line by line|in the notes)/.test(t)) return "contact_card";
  if (/\b(epicor|netsuite|sap|dynamics|quickbooks|oracle|erp|vendor master|approved vendor|avl|in our system|into our system|put you in the system)\b/.test(t)) return "erp_vendor_list";
  if (/\b(spreadsheet|excel|vendor list|supplier list|google sheet|the sheet)\b/.test(t)) return "spreadsheet";
  if (/\bprint (it|that|this)|binder\b/.test(t)) return "print";
  if (/search (my|the|our) (email|inbox|outlook|gmail)|look (it|you) up in (my|the) (email|inbox)/.test(t)) return "inbox_search";
  return null;
}

/** Did they ask for it, in the usual words? Only decides when to bother the model. */
export function askedForLineCard(text: string): boolean {
  return /line ?card|send (me|us|it|that|over|your)|shoot (me|us)|email (it|me|us|that|over)|add us to your list|what you (have|carry|guys do)|send (your|the) (info|information|w-?9|stuff)/i.test(text);
}

/** The product words a call used, as the buyer said them: the lead's own terms for the subject. */
export function productWords(text: string, max = 3): string[] {
  const found: string[] = [];
  for (const k of [...KEYWORDS].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}s?\\b`, "i");
    if (re.test(text) && !found.some((f) => f.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(f.toLowerCase()))) found.push(k);
    if (found.length >= max) break;
  }
  return found;
}

/**
 * Read the call for a line card request and how they file vendors. Null when they didn't ask. The rules decide the
 * filing method when they can hear it; the model fills the rest. Never a product they didn't mention.
 */
export async function detectLineCardRequest(d: Deps, opts: { company: string; transcript: string; description?: string | null; state?: string | null; contacts?: Array<{ name: string; email: string | null }> }): Promise<LineCardRequest | null> {
  const transcript = opts.transcript ?? "";
  if (!transcript || transcript.split(/\s+/).length < 40 || !askedForLineCard(transcript)) return null;
  const { data } = await d.llm({
    schema: LineCardRequestSchema, effort: "low", model: config.briefModel,
    context: untrusted(`CALL TRANSCRIPT with ${opts.company}`, transcript),
    task: `Did anyone on this call ask the rep to send a line card or Westgate's info by email, or agree to receive it? If so, who, at what address, and how do they keep track of vendors? Only what was actually said. Product words only as the buyer said them; never add products they didn't mention.`,
  });
  if (!data.requested) return null;
  const heard = filingMethodFromText(transcript);
  const filingMethod = heard ?? data.filingMethod;
  const terms = [...data.productTerms, ...data.specificItems].join(" ");
  const relevantFamilies = familiesFromText(`${terms} ${transcript}`, opts.description ?? null);
  const email = data.requester.email?.trim().toLowerCase() || null;
  const known = email ? null : opts.contacts?.find((c) => c.email && data.requester.name && c.name.toLowerCase().split(/\s+/)[0] === data.requester.name.toLowerCase().split(/\s+/)[0]);
  const req: LineCardRequest = {
    requested: true,
    requester: { name: data.requester.name, email: email ?? known?.email ?? null, title: data.requester.title, isGatekeeper: data.requester.isGatekeeper },
    forwardTo: data.forwardTo,
    filingMethod, filingEvidence: data.filingEvidence,
    relevantFamilies, specificItems: data.specificItems,
    openNeed: data.openNeed, pastBenchmark: data.pastBenchmark,
    wants: { fullText: data.wantsFullText, pdfOnly: data.wantsPdfOnly, setupPacket: data.wantsSetupPacket },
    warehouseNearest: nearestWarehouse(opts.state), driveTimeMinutes: null,
    format: "standard", reason: "", confidence: data.confidence,
  };
  Object.assign(req, recommendFormat(req, { hasVcf: false }));
  return req;
}

/** Which format fits what they said, and why, in one line for the panel. */
export function recommendFormat(req: LineCardRequest, opts: { hasVcf: boolean }): { format: EmailFormat; reason: string } {
  const who = req.requester.name?.split(/\s+/)[0] ?? "They";
  if (req.wants.pdfOnly) return { format: "pdf_only", reason: `${who} asked for just the PDF.` };
  if (req.wants.setupPacket) return { format: "setup_packet", reason: `${who} said you'd need to be set up as a vendor, so the W-9 and terms lines go in.` };
  if (req.requester.isGatekeeper) return { format: "gatekeeper", reason: `${who} will pass it along, so it asks them to forward it to whoever buys materials.` };
  if (req.filingMethod === "contact_card") return { format: opts.hasVcf ? "contact_card" : "full_text", reason: `${who} keeps a contact per vendor, so the whole card is written out to paste into the notes${opts.hasVcf ? ", and the .vcf is attached" : ""}.` };
  if (req.wants.fullText) return { format: "full_text", reason: `${who} asked for it written out.` };
  if (req.filingMethod === "spreadsheet" || req.filingMethod === "erp_vendor_list") return { format: "vendor_row", reason: `${who} keeps a vendor list, so there's one line to paste into it.` };
  if (req.relevantFamilies.length <= 4 && req.specificItems.length >= 2) return { format: "niche", reason: `${who} named specific items, so their families are listed in full.` };
  return { format: "standard", reason: req.filingMethod === "inbox_search" ? `${who} searches their inbox, so the short text card and a keyword subject.` : "Nothing said about how they file vendors, so the short text card." };
}

// ---------- subject ----------

/** A small stable number from a string, to rotate the fixed words per lead. */
export function seedOf(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** A product word as the lead said it, in the card's own casing when it's a card keyword ("u bolts" → "U-bolts"). */
function cleanWord(w: string): string {
  const t = w.replace(/\s*\(.*?\)\s*/g, " ").replace(/[–—]/g, "-").replace(/[^\w\s#/-]/g, "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
  const canon = KEYWORDS.find((k) => key(k) === key(t));
  if (canon) return canon;
  return t.split(" ").map((x) => (/^[A-Z]{1,3}\d|^\d/.test(x) || /^[A-Z]+$/.test(x) ? x : x.toLowerCase())).join(" ");
}

/**
 * `Westgate Supply: {2 to 3 lead words}, {2 fixed words}`, never over 70 characters. Lead words come from what
 * they said or buy; a lead with nothing specific gets family words for its industry.
 */
export function lineCardSubject(opts: { words?: string[]; families?: ProductFamilyId[]; seed: string; gatekeeper?: { company: string } }): string {
  const fixedStart = seedOf(opts.seed) % FIXED_WORDS.length;
  const fixed = [FIXED_WORDS[fixedStart], FIXED_WORDS[(fixedStart + 1) % FIXED_WORDS.length]];
  if (opts.gatekeeper) {
    const base = `Westgate Supply line card for ${opts.gatekeeper.company.replace(/[–—]/g, "-")}`;
    // The company name stays whole as long as it can: fewer fixed words first, a shorter name only as a last resort.
    for (const tail of [": fasteners, gaskets, flanges", ": fasteners, gaskets", ": fasteners"]) if (`${base}${tail}`.length <= SUBJECT_MAX) return `${base}${tail}`;
    const tail = ": fasteners";
    return `${base.slice(0, SUBJECT_MAX - tail.length).trim()}${tail}`;
  }
  const seen = new Set<string>(fixed);
  const lead: string[] = [];
  const candidates = [...(opts.words ?? []).map(cleanWord), ...(opts.families ?? []).map((f) => FAMILY_WORDS[f])];
  for (const w of candidates) {
    const key = w.toLowerCase();
    // "A325 bolts" already says bolts: the family word adds nothing.
    if (!w || seen.has(key) || w.length > 24 || lead.some((l) => l.toLowerCase().split(/\s+/).includes(key))) continue;
    seen.add(key);
    lead.push(w);
    if (lead.length === 3) break;
  }
  const build = (n: number) => `Westgate Supply: ${[...lead.slice(0, n), ...fixed].join(", ")}`;
  for (let n = Math.min(3, lead.length); n >= 0; n--) {
    const s = build(n);
    if (s.length <= SUBJECT_MAX) return s;
  }
  return build(0).slice(0, SUBJECT_MAX);
}

// ---------- the fixed lines ----------

/** The families a call pointed at: what they said, then what their kind of company buys. Always at least two. */
export function familiesFromText(text: string, industry: string | null | undefined, max = 4): ProductFamilyId[] {
  // "U-bolts" aren't bolts and "beam clamps" aren't beams: fold those before the family hints run.
  const t = text.replace(/\bu-?bolts?\b/gi, "ubolt").replace(/\bbeam clamps?\b/gi, "beamclamp").replace(/\bpipe clamps?\b/gi, "pipeclamp");
  const hints = { ...FAMILY_HINTS, u_bolts: /ubolt|beamclamp|pipeclamp|anchor bolts?|pipe (supports?|hangers?)|hangers?|saddles?|slide plates?|\bj bolts?\b|\bl bolts?\b|strut/i };
  const out = FAMILY_IDS.filter((id) => hints[id].test(t)).slice(0, max);
  for (const f of familiesForIndustry(industry)) {
    if (out.length >= 2) break;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** "Call us when you need flange bolt-up, sour service fasteners, odd size U-bolts." 3 to 4 triggers from the families. */
export function callUsWhen(families: ProductFamilyId[]): string {
  const picked: string[] = [];
  const fams = families.length ? families : (["studs", "flanges", "gaskets"] as ProductFamilyId[]);
  for (let round = 0; round < 2 && picked.length < 4; round++) {
    for (const id of fams) {
      const t = familyById(id).triggers[round];
      if (t && !picked.includes(t) && picked.length < 4) picked.push(t);
    }
  }
  while (picked.length < 3) picked.push("a line list nobody wants to quote");
  return `Call us when you need ${picked.join(", ")}.`;
}

/** The nearest warehouse and the rest, no minimum, MTRs: said once, near the end. */
export function logisticsLine(nearest: string, driveTimeMinutes?: number | null): string {
  const others = COMPANY.warehouses.filter((w) => w !== nearest);
  const near = driveTimeMinutes ? `${nearest}, about ${driveTimeMinutes} minutes from you` : nearest;
  return `We ship from ${near}, and also from ${others.join(" and ")}. No minimum order, and MTRs come with every order.`;
}

/** The keyword line under the sign-off, on line card emails only (Walt 10/7), unless the flag is off. */
export function withSignatureLine(body: string): string {
  if (!config.signatureKeywords || body.includes(SIGNATURE_LINE)) return body;
  return `${body.trimEnd()}\n\n${SIGNATURE_LINE}`;
}

// ---------- the personalized part, written once per call ----------

export const OpenerSchema = z.object({
  opener: z.string().describe("2 to 4 complete sentences in the rep's voice, 50 to 90 words: thanks for the call (only if the recipient was on it), one specific thing they said, and that the line card is below and attached. Plain words, no email lingo, no exclamation marks, no em or en dashes."),
  nextStep: z.string().describe("1 to 2 sentences: the ask. If they have something open now, ask them to reply with that list or RFQ and say you'll price it. Otherwise ask plainly for the next RFQ or list. For a gatekeeper: ask them to forward this to whoever buys materials, nothing else. Never 'no pressure', 'no rush', 'no obligation', 'whenever something comes up', and never a date you'll follow up."),
});
export type Opener = z.infer<typeof OpenerSchema>;

export async function writeOpener(d: Deps, opts: { context: string; transcript: string; req: LineCardRequest; company: string; feedback?: string[] }): Promise<Opener> {
  const r = opts.req;
  const who = r.requester.name?.split(/\s+/)[0] ?? "there";
  const parts = [
    `The rep just finished a call with ${opts.company}. ${who} asked for the line card${r.requester.isGatekeeper ? ` and will pass it to ${r.forwardTo?.name ?? "whoever buys materials"}` : ""}. Write ONLY the personal part of the line card email: the opener and the next step. The app adds the line card itself, the "call us when" line, the warehouse line and the sign-off.`,
    `Address ${who} by first name in the opener's first words only if you're told a name; never a greeting line (the app adds "Hi ${who},").`,
    r.requester.isGatekeeper ? `GATEKEEPER: ${who} isn't the buyer. No assumed relationship, no "your next RFQ". Thank them, say what's in the email, and in the next step ask them to forward it to whoever buys materials (${r.forwardTo?.name ?? "the purchasing person"}).` : "",
    r.openNeed ? `They have something open now: "${r.openNeed}". The next step asks them to reply with that list and says you'll price it.` : "Nothing is open right now. The next step asks plainly for the next RFQ or materials list. No offers to price an old RFQ, no benchmark line.",
    r.specificItems.length ? `Items they named, use their words: ${r.specificItems.join(", ")}. Never name a grade or product they didn't mention.` : "Never name a grade or product they didn't mention on the call.",
    `${d.rep.name.split(" ")[0]} works for Westgate Supply: never phrase Westgate as someone he called or spoke with.`,
    "Complete sentences that read like the rep typed them. No 'bumping', 'circling back', 'quick one', 'hope this finds you well'. No em or en dashes. No exclamation marks.",
    ...(opts.feedback?.length ? [`Your previous draft was rejected. Fix these:\n${opts.feedback.map((f) => `- ${f}`).join("\n")}`] : []),
  ].filter(Boolean);
  const { data } = await d.llm({
    schema: OpenerSchema, effort: config.effortEmail, model: config.emailModel,
    context: `${opts.context}\n\n${untrusted(`CALL TRANSCRIPT with ${opts.company}`, opts.transcript)}`,
    task: parts.join("\n\n"),
  });
  return { opener: stripDashes(data.opener).trim(), nextStep: stripDashes(data.nextStep).trim() };
}

// ---------- compose ----------

export type Attached = { vcf: boolean; w9: boolean };
export type ComposedEmail = { subject: string; body: string; personalized: string; format: EmailFormat; attach_line_card: boolean };

/** The email for a format: opener, "call us when", the line card block, logistics, next step, sign-off, keyword line. */
export function composeLineCardEmail(opts: { req: LineCardRequest; format: EmailFormat; opener: Opener; rep: { name: string; email: string; phone?: string | null }; first: string | null; company: string; seed: string; attached: Attached }): ComposedEmail {
  const { req, format, opener, rep } = opts;
  const fams = req.relevantFamilies;
  const triggers = callUsWhen(fams);
  const logistics = logisticsLine(req.warehouseNearest, req.driveTimeMinutes);
  const block: string[] = [];
  let explain = "";
  if (format === "full_text" || format === "contact_card") {
    explain = "Here's everything we carry, written out so you can paste it into your notes or search it later. It's also attached as a PDF.";
    block.push(renderPlainText());
  } else if (format === "niche") {
    explain = "Here's the part of our line card that fits your work, with every item listed. The full card is attached.";
    block.push(renderNiche(fams));
  } else if (format === "vendor_row") {
    explain = "Here's one line you can paste straight into your vendor list, and the short version of the card under it so it's easy to search later.";
    block.push(renderVendorRow({ name: rep.name, email: rep.email, phone: rep.phone }), renderShort());
  } else if (format === "setup_packet") {
    explain = "Here's the short version of our line card in text, and what you'll need to set us up as a vendor.";
    block.push(renderShort(), [
      "For vendor setup:",
      opts.attached.w9 ? "W-9: attached." : "W-9: available on request, I'll send it the same day.",
      "Certificate of insurance: available on request.",
      "Quality: full traceability, with certified test reports (MTRs) to ASTM, ASME, ANSI, ISO, DIN, NACE and PED on every order.",
      "Tax ID: on the W-9.",
      "Terms: net terms on approved credit; card or prepay to start if that's easier.",
      `Quotes and orders: ${COMPANY.quotes}, ${COMPANY.phone}.`,
    ].join("\n"));
  } else if (format === "pdf_only") {
    explain = "The line card is attached as a PDF.";
  } else {
    // standard, gatekeeper
    explain = format === "gatekeeper"
      ? "The line card is attached as a PDF, and here it is in text so whoever you pass it to can search for it later."
      : "It's all in the attached PDF, and here it is in plain text so it's easy to search for later.";
    block.push(renderShort());
  }
  if (format === "contact_card" && opts.attached.vcf) block.push("I also attached a contact card (.vcf) with all of the above in the notes, so you can add us to your contacts in one click.");
  const personalizedParas = [opener.opener, `${triggers} ${explain}`, logistics, opener.nextStep];
  const paras = [`Hi ${opts.first ?? "there"},`, opener.opener, `${triggers} ${explain}`, ...block, logistics, opener.nextStep, rep.name];
  const body = withSignatureLine(stripDashes(paras.join("\n\n")));
  const words = [...req.specificItems, ...(req.relevantFamilies.map((f) => FAMILY_WORDS[f]))];
  const subject = stripDashes(format === "gatekeeper" ? lineCardSubject({ seed: opts.seed, gatekeeper: { company: opts.company } }) : lineCardSubject({ words, families: fams, seed: opts.seed }));
  return { subject, body, personalized: personalizedParas.join("\n\n"), format, attach_line_card: true };
}

// ---------- validation ----------

export type LineCardProblem = { rule: string; problem: string; hard: boolean };

const SPEC_TOKEN = /\b(?:[A-Z]{1,2}-?\d{2,4}[A-Z]{0,2}|\d{3,4}[A-Z]{1,3}|(?:Class|Gr(?:ade)?)\.? ?[0-9][0-9.]*|Xylan ?\d+|Inconel ?\d+|Monel ?[A-Z]?-?\d+|Hastelloy ?[A-Z]-?\d+|Incoloy ?\d+[A-Z]?)\b/g;
const norm = (s: string) => s.toUpperCase().replace(/[\s\-_/()]+/g, "");

/**
 * The checks on a line card email: hard ones fail the draft, soft ones show in the panel as warnings.
 * `personalized` is the part the model wrote plus the fixed lines; `transcript` is what the buyer actually said.
 */
export function validateLineCardEmail(email: { subject: string; body: string }, req: LineCardRequest, format: EmailFormat, personalized: string, transcript: string): LineCardProblem[] {
  const out: LineCardProblem[] = [];
  const hard = (rule: string, problem: string) => out.push({ rule, problem, hard: true });
  const soft = (rule: string, problem: string) => out.push({ rule, problem, hard: false });
  const body = email.body;
  if (DASHES.test(body) || DASHES.test(email.subject)) hard("dashes", "Em or en dash in the subject or body.");
  if (email.subject.length > SUBJECT_MAX) hard("subject", `Subject is ${email.subject.length} characters; the limit is ${SUBJECT_MAX}.`);
  if (!/^Westgate Supply(:| line card for )/.test(email.subject)) hard("subject", 'Subject must start with "Westgate Supply:".');
  const named = FAMILIES.filter((f) => body.toLowerCase().includes(f.name.toLowerCase())).length;
  if (format === "niche") {
    for (const id of req.relevantFamilies) if (!body.includes(familyById(id).name)) hard("families", `Niche email is missing the ${familyById(id).name} family they buy.`);
  } else if (format !== "pdf_only" && named < 10) hard("families", `Only ${named} of the 12 product families are named in the body.`);
  for (const s of personalized.split(/(?<=[.!?])\s+/)) {
    if (IDENTITY.some((r) => r.test(s))) hard("identity", `Phrases Westgate as someone the rep called: "${s.trim()}"`);
    if (HEDGE.test(s)) hard("hedging", `Hedges the ask: "${s.trim()}"`);
  }
  if (/\b(old|older|past|recent|previous) (rfq|po|purchase order|quote)\b/i.test(personalized) && (req.openNeed || !req.pastBenchmark)) hard("benchmark", "Asks for an old RFQ to re-price; Walt doesn't want that line.");
  if (/\b(check (back|in)|circle back|follow up|reach (back )?out|touch base) .{0,20}\b(on|by|in|next|around) (mon|tues|wednes|thurs|fri)?/i.test(personalized)) soft("timing", "Mentions when you'll follow up; take that out so they don't wait.");
  // A spec the card doesn't carry and the buyer didn't say is an invention.
  const terms = cardTerms();
  const said = norm(transcript);
  for (const m of personalized.matchAll(SPEC_TOKEN)) {
    const tok = m[0];
    if (/^(19|20)\d\d$/.test(tok) || /^\d{3,4}$/.test(tok)) continue; // a year, a time, an area code
    if (terms.has(norm(tok)) || said.includes(norm(tok))) continue;
    hard("invented", `"${tok}" isn't on the line card and wasn't said on the call.`);
  }
  const words = wordCount(personalized);
  if (words < 120 || words > 180) soft("length", `The personal part is ${words} words; the target is 120 to 180.`);
  if (format === "gatekeeper") {
    if (!/\b(forward|pass (it|this) (along|on|to)|get (it|this) to)\b/i.test(personalized)) hard("gatekeeper", "Gatekeeper email doesn't ask them to forward it to whoever buys materials.");
    if (/\b(your (next|open) (rfq|list|order)|send (me|over) (your|an) (rfq|list)|reply with (your|the) (rfq|list))\b/i.test(personalized)) hard("gatekeeper", "Gatekeeper email treats the gatekeeper as the buyer.");
  }
  return out;
}

/** Say which attachments the Close template carries, by file name. */
export function attachedKinds(attachments: Array<{ filename?: string | null }>): Attached {
  const names = attachments.map((a) => (a.filename ?? "").toLowerCase());
  return { vcf: names.some((n) => n.endsWith(".vcf")), w9: names.some((n) => /w-?9/.test(n)) };
}

// ---------- the draft, end to end ----------

export type LineCardState = {
  request: LineCardRequest;
  format: EmailFormat;
  reason: string;
  opener: Opener | null;
  problems: LineCardProblem[];
  attached: Attached;
  to: string | null;
  formats: Array<{ id: EmailFormat; label: string; help: string }>;
};

type EmailProposal = { to: Array<{ name: string; email: string }>; subject: string; body: string; attach_line_card: boolean; address_as_heard: string | null };

/**
 * The line card draft for a call: the opener written once (the model), the rest composed from the card and the
 * format, checked before it's saved. Pass `opener` to change the format without re-reading the transcript.
 */
export async function draftLineCardEmail(d: Deps, opts: { leadId: string; company: string; transcript: string; req: LineCardRequest; format?: EmailFormat | null; opener?: Opener | null; context?: string; attachments?: Array<{ filename?: string | null }> }): Promise<{ email: EmailProposal | null; state: LineCardState; warnings: string[] }> {
  const { lineCardAttachments } = await import("./assistant.js");
  const { greetName } = await import("./followup.js");
  const { nameFromEmail } = await import("./linecard.js");
  const attachments = opts.attachments ?? (await lineCardAttachments(d).catch(() => []));
  const attached = attachedKinds(attachments);
  const req = opts.req;
  const rec = recommendFormat(req, { hasVcf: attached.vcf });
  const format = opts.format ?? rec.format;
  const reason = opts.format && opts.format !== rec.format ? `You picked ${FORMAT_LABEL[format]}. The app suggested ${FORMAT_LABEL[rec.format]}: ${rec.reason}` : rec.reason;
  const formats = FORMATS.map((id) => ({ id, label: FORMAT_LABEL[id], help: FORMAT_HELP[id] }));
  const to = req.requester.email;
  const warnings: string[] = [];
  const state: LineCardState = { request: req, format, reason, opener: opts.opener ?? null, problems: [], attached, to, formats };
  if (!to) {
    warnings.push(`${req.requester.name ?? "They"} asked for the line card but no email address came through on the call. Add it to the contact and use Send line card from the lead.`);
    return { email: null, state, warnings };
  }
  const first = greetName(req.requester.name) ?? nameFromEmail(to);
  const context = opts.context ?? "";
  let opener = opts.opener ?? null;
  let problems: LineCardProblem[] = [];
  let composed: ComposedEmail | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!opener) opener = await writeOpener(d, { context, transcript: opts.transcript, req, company: opts.company, feedback: problems.filter((p) => p.hard).map((p) => p.problem) });
    composed = composeLineCardEmail({ req, format, opener, rep: { name: d.rep.name, email: d.rep.email }, first, company: opts.company, seed: opts.leadId, attached });
    problems = validateLineCardEmail(composed, req, format, composed.personalized, opts.transcript);
    if (!problems.some((p) => p.hard)) break;
    // A cached opener that fails for this format gets rewritten once.
    opener = null;
  }
  state.opener = opener;
  state.problems = problems;
  for (const p of problems.filter((x) => !x.hard)) warnings.push(`Line card email: ${p.problem}`);
  if (!composed || problems.some((p) => p.hard)) {
    warnings.push(`Line card email not saved: ${problems.filter((p) => p.hard).map((p) => p.problem).join(" ")} Pick another format or write it yourself.`);
    return { email: null, state, warnings };
  }
  const email: EmailProposal = {
    to: [{ name: req.requester.name ?? first ?? to, email: to }], subject: composed.subject, body: composed.body, attach_line_card: true,
    address_as_heard: req.requester.email ? req.requester.email : null,
  };
  return { email, state, warnings };
}

/** What format each lead got (per rep, in the store), so replies and RFQs can be compared by format later. */
export type LineCardSend = { leadId: string; format: EmailFormat; filing: FilingMethod; at: string; emailId: string | null };
const SENDS_KEY = "lineCardSends";
export async function recordLineCardSend(d: Deps, send: LineCardSend) {
  const { store } = await import("./store.js");
  const all = (await store.getSetting<Record<string, LineCardSend>>(d.rep.closeUserId, SENDS_KEY)) ?? {};
  all[send.leadId] = send;
  await store.putSetting(d.rep.closeUserId, SENDS_KEY, all);
}
export async function lineCardSends(d: Deps): Promise<Record<string, LineCardSend>> {
  const { store } = await import("./store.js");
  return (await store.getSetting<Record<string, LineCardSend>>(d.rep.closeUserId, SENDS_KEY)) ?? {};
}
