import { z } from "zod/v4";
import type { Deps } from "./assistant.js";
import { untrusted } from "./claude.js";
import { config } from "./config.js";
import { cardTerms, FAMILIES, FAMILY_HINTS, FAMILY_IDS, FAMILY_WORDS, familyById, familiesForIndustry, KEYWORDS, renderNiche, renderPlainText, renderShort, renderVendorRow, signatureLine, wordCount, type ProductFamilyId } from "./content/lineCard.js";
import { HEDGE, IDENTITY } from "./validate.js";
import { stripDashes } from "./benchmark.js";

/**
 * "Send us a line card" (Walt 10/7). The most common good outcome of a cold call, and the email has to do one job
 * well: be findable later. Buyers keep vendors in their inbox, their contacts, or a vendor list, and search them
 * by product word. A PDF is searchable in none of those reliably; words in the subject and body are. So every line
 * card email carries the card as text, a keyword subject, and the keyword line under the name, and the body is
 * shaped to how this buyer said they file vendors.
 *
 * The wrapper around the card (10/7, final): nothing about where we are, ever (no warehouses, cities, "national",
 * drive times); no phone number the model wrote; the PDF mentioned once; the opener built only from what the buyer
 * said; the "call us when" triggers from what they named; one closing sentence chosen by state.
 */

export const SUBJECT_MAX = 70;
/** Two fixed words close every subject; they rotate so a buyer's inbox doesn't show ten identical ones. */
const FIXED_WORDS = ["fasteners", "gaskets", "flanges", "fittings", "pipe", "steel"];
const DASHES = /[\u2013\u2014]/;

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
  /** Their words, verbatim from the transcript; the opener may mention how they file only when this is set. */
  filingEvidence: string | null;
  relevantFamilies: ProductFamilyId[];
  specificItems: string[];
  /** What they do and what they buy, in their words: the only material the opener is built from. */
  transcriptFacts: string[];
  openNeed: string | null;
  pastBenchmark: boolean;
  wants: { fullText: boolean; pdfOnly: boolean; setupPacket: boolean };
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
  filingEvidence: z.string().nullable().describe("Their exact words that showed the method, one sentence verbatim from the transcript. Null if unknown."),
  transcriptFacts: z.array(z.string()).describe("2 to 4 short facts the buyer stated about their work and what they buy, each close to their words ('they do a lot of stainless work, 304 and 316 plate', 'duplex now and then'). Nothing inferred."),
  productTerms: z.array(z.string()).describe("Product words they used for what they buy or build with, as said: 'pipe supports', 'U-bolts', 'B7 studs', 'plate'. Only what was said on the call."),
  specificItems: z.array(z.string()).describe("Exact grades or parts they named: 'B7 studs', '2H nuts', 'spiral wound', '4 inch flanges'. Empty if none."),
  openNeed: z.string().nullable().describe("Anything they said they're buying or pricing right now, as a short noun phrase in their words ('the pump skid', 'next week's flange order'). Null if nothing is open."),
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

/** The sentence they said it in, from the transcript, so the evidence is verbatim or nothing. */
export function evidenceFromText(text: string, method: FilingMethod | null): string | null {
  if (!method || method === "unknown") return null;
  const lines = text.split(/\n+/).map((l) => l.replace(/^[^:]{0,60}@ \d+:\d\d:\s*/, "").trim()).filter(Boolean);
  return lines.find((l) => filingMethodFromText(l) === method) ?? null;
}

/** Did they ask for it, in the usual words? Only decides when to bother the model. */
export function askedForLineCard(text: string): boolean {
  return /line ?card|send (me|us|it|that|over|your)|shoot (me|us)|email (it|me|us|that|over)|add us to your list|what you (have|carry|guys do)|send (your|the) (info|information|w-?9|stuff)/i.test(text);
}

/**
 * Read the call for a line card request and how they file vendors. Null when they didn't ask. The rules decide the
 * filing method when they can hear it; the model fills the rest. Never a product they didn't mention.
 */
export async function detectLineCardRequest(d: Deps, opts: { company: string; transcript: string; description?: string | null; contacts?: Array<{ name: string; email: string | null }> }): Promise<LineCardRequest | null> {
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
  // Evidence must be their words: a quote the transcript actually contains, else the sentence the rules matched, else nothing.
  const quoted = data.filingEvidence && transcript.toLowerCase().includes(data.filingEvidence.toLowerCase().trim()) ? data.filingEvidence.trim() : null;
  const filingEvidence = filingMethod === "unknown" ? null : quoted ?? evidenceFromText(transcript, filingMethod);
  const terms = [...data.productTerms, ...data.specificItems].join(" ");
  const relevantFamilies = familiesFromText(`${terms} ${transcript}`, opts.description ?? null);
  const email = data.requester.email?.trim().toLowerCase() || null;
  const known = email ? null : opts.contacts?.find((c) => c.email && data.requester.name && c.name.toLowerCase().split(/\s+/)[0] === data.requester.name.toLowerCase().split(/\s+/)[0]);
  const req: LineCardRequest = {
    requested: true,
    requester: { name: data.requester.name, email: email ?? known?.email ?? null, title: data.requester.title, isGatekeeper: data.requester.isGatekeeper },
    forwardTo: data.forwardTo,
    filingMethod: filingEvidence ? filingMethod : filingMethod === "inbox_search" || filingMethod === "unknown" ? filingMethod : "unknown",
    filingEvidence,
    relevantFamilies, specificItems: data.specificItems, transcriptFacts: data.transcriptFacts,
    openNeed: data.openNeed, pastBenchmark: data.pastBenchmark,
    wants: { fullText: data.wantsFullText, pdfOnly: data.wantsPdfOnly, setupPacket: data.wantsSetupPacket },
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
  const t = w.replace(/\s*\(.*?\)\s*/g, " ").replace(/[\u2013\u2014]/g, "-").replace(/[^\w\s#/-]/g, "").trim().replace(/\s+/g, " ");
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
    const base = `Westgate Supply line card for ${opts.gatekeeper.company.replace(/[\u2013\u2014]/g, "-")}`;
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

/**
 * "Call us when you need: 304 plate, 316 plate, bolts and screws." 3 to 5 triggers: the items they named, then the
 * family names for the rest. Nothing invented (no scenarios they didn't describe).
 */
export function callUsWhen(specificItems: string[], families: ProductFamilyId[]): string {
  const picked: string[] = [];
  const add = (t: string) => { const x = t.trim().replace(/[.]$/, ""); if (x && !picked.some((p) => p.toLowerCase() === x.toLowerCase()) && picked.length < 5) picked.push(x); };
  // Lower-case a leading ordinary word ("Spiral wound" → "spiral wound"); a grade or an acronym keeps its case (B7, RTJ, 2H).
  for (const it of specificItems) add(/^(?:[A-Z]{1,3}\d|[A-Z][A-Z0-9-]+\b|\d)/.test(it) ? it : it.charAt(0).toLowerCase() + it.slice(1));
  const fams = families.length ? families : (["studs", "flanges", "gaskets"] as ProductFamilyId[]);
  for (const id of fams) {
    if (picked.length >= 3 && picked.length >= Math.min(5, specificItems.length)) break;
    const name = familyById(id).name;
    add(name.charAt(0).toLowerCase() + name.slice(1));
  }
  for (const id of FAMILY_IDS) { if (picked.length >= 3) break; add(familyById(id).name.toLowerCase()); }
  return `Call us when you need: ${picked.join(", ")}.`;
}

/** The keyword line under the sign-off, on line card emails only (Walt 10/7), unless the flag is off. */
export function withSignatureLine(body: string): string {
  const line = signatureLine(config.linecardPageLive);
  if (!config.signatureKeywords || body.includes(line)) return body;
  return `${body.trimEnd()}\n\n${line}`;
}

/** The fixed second sentence of the opener when the buyer didn't say how they file vendors. */
export const FALLBACK_SECOND = "I wrote our line card out below so you can paste it into your notes or search your email for it later. It is attached as a PDF too.";

/**
 * One closing sentence, by state. Walt (10/7): never "no pressure" and never an old-RFQ ask; nothing open means a
 * plain ask for the next list.
 */
export function closingFor(req: LineCardRequest): string {
  if (req.requester.isGatekeeper) return "If you can pass this along to whoever buys materials, I would appreciate it.";
  if (req.openNeed) return `Send over the ${req.openNeed.replace(/^(the|your|our)\s+/i, "").replace(/\s+list$/i, "")} list whenever it is ready and I will price it.`;
  return "Send me your next list or RFQ and I will price it.";
}

// ---------- the opener's facts, written once per call ----------

export const OpenerSchema = z.object({
  opener: z.string().describe("1 to 3 complete sentences in the rep's voice, built ONLY from the transcript facts given: thanks for the call (only if this person was on it) and what they said they do and buy, close to their words. Do not mention the line card, the PDF, attachments, how they file vendors, where Westgate is, or any phone number; the app adds those. Plain words, no email lingo, no exclamation marks, no em or en dashes."),
});
export type Opener = z.infer<typeof OpenerSchema>;

export async function writeOpener(d: Deps, opts: { context: string; transcript: string; req: LineCardRequest; company: string; feedback?: string[] }): Promise<Opener> {
  const r = opts.req;
  const who = r.requester.name?.split(/\s+/)[0] ?? "there";
  const parts = [
    `The rep just finished a call with ${opts.company}. ${who} asked for the line card${r.requester.isGatekeeper ? ` and will pass it to ${r.forwardTo?.name ?? "whoever buys materials"}` : ""}. Write ONLY the first sentences of the email: thanks for the call (if ${who} was on it) and what they said about their work and what they buy. The app adds everything else: the line card, the PDF line, the "call us when" line, the closing and the sign-off.`,
    `Facts you may use, nothing else: ${r.transcriptFacts.length ? r.transcriptFacts.map((f) => `"${f}"`).join("; ") : "(none beyond the transcript itself)"}.${r.specificItems.length ? ` Items they named: ${r.specificItems.join(", ")}.` : ""}`,
    `No greeting line (the app adds "Hi ${who},"). ${r.requester.isGatekeeper ? `${who} isn't the buyer: no assumed relationship, nothing about "your RFQ".` : ""}`,
    "Never: the PDF, 'attached', a phone number, a warehouse or city, 'national', how they keep track of vendors, a grade or product they didn't mention, 'bumping', 'circling back', 'quick one', 'hope this finds you well', exclamation marks, em or en dashes.",
    `${d.rep.name.split(" ")[0]} works for Westgate Supply: never phrase Westgate as someone he called or spoke with.`,
    ...(opts.feedback?.length ? [`Your previous draft was rejected. Fix these:\n${opts.feedback.map((f) => `- ${f}`).join("\n")}`] : []),
  ].filter(Boolean);
  const { data } = await d.llm({
    schema: OpenerSchema, effort: config.effortEmail, model: config.emailModel,
    context: `${opts.context}\n\n${untrusted(`CALL TRANSCRIPT with ${opts.company}`, opts.transcript)}`,
    task: parts.join("\n\n"),
  });
  return { opener: stripDashes(data.opener).trim() };
}

// ---------- compose ----------

export type Attached = { vcf: boolean; w9: boolean };
export type ComposedEmail = { subject: string; body: string; personalized: string; format: EmailFormat; attach_line_card: boolean };

/** The opener's second sentence: how they file (only with their words on record), else the fixed line. */
function pdfSentence(req: LineCardRequest, format: EmailFormat): string {
  if (format === "pdf_only") return "Our line card is attached as a PDF.";
  if (req.filingMethod !== "unknown" && req.filingEvidence) {
    if (req.filingMethod === "contact_card") return "You said you keep a contact for each vendor, so I wrote our line card out below to paste into the notes. It is attached as a PDF too.";
    if (req.filingMethod === "spreadsheet" || req.filingMethod === "erp_vendor_list") return "You said you keep a vendor list, so there is one line below to paste into it, and the card under that. It is attached as a PDF too.";
    if (req.filingMethod === "print") return "You said you print these for the binder, so the PDF is attached, and the card is written out below so it is easy to search for later.";
    if (req.filingMethod === "inbox_search") return "You said you search your email when you need a vendor, so I wrote our line card out below. It is attached as a PDF too.";
  }
  return FALLBACK_SECOND;
}

/** The email for a format: greeting, opener, "call us when", the line card block, the closing, the sign-off, the keyword line. */
export function composeLineCardEmail(opts: { req: LineCardRequest; format: EmailFormat; opener: Opener; rep: { name: string; email: string; phone?: string | null }; first: string | null; company: string; seed: string; attached: Attached }): ComposedEmail {
  const { req, format, opener, rep } = opts;
  const fams = req.relevantFamilies;
  const phone = config.company.phone;
  const block: string[] = [];
  if (format === "full_text" || format === "contact_card") block.push(renderPlainText({ phone }));
  else if (format === "niche") block.push(renderNiche(fams));
  else if (format === "vendor_row") block.push(renderVendorRow({ name: rep.name, email: rep.email, phone: rep.phone ?? phone }), renderShort({ name: rep.name, email: rep.email }));
  else if (format === "setup_packet") {
    block.push(renderShort({ name: rep.name, email: rep.email }), [
      "For vendor setup:",
      opts.attached.w9 ? "W-9: included with this email." : "W-9: available on request, I will send it the same day.",
      "Certificate of insurance: available on request.",
      "Quality: full traceability, with certified test reports to ASTM, ASME, ANSI, ISO, DIN, NACE and PED on every order.",
      "Tax ID: on the W-9.",
      "Terms: net terms on approved credit; card or prepay to start if that is easier.",
    ].join("\n"));
  } else if (format !== "pdf_only") block.push(renderShort({ name: rep.name, email: rep.email }));
  if (format === "contact_card" && opts.attached.vcf) block.push("There is also a contact card (.vcf) with all of the above in the notes, so you can add us to your contacts in one click.");
  const openerText = `${opener.opener.trim()} ${pdfSentence(req, format)}`.trim();
  const triggers = callUsWhen(req.specificItems, fams);
  const closing = closingFor(req);
  const paras = [`Hi ${opts.first ?? "there"},`, openerText, triggers, ...block, closing, `Thanks,\n${rep.name}`];
  const body = withSignatureLine(stripDashes(paras.join("\n\n")));
  const words = [...req.specificItems, ...fams.map((f) => FAMILY_WORDS[f])];
  const subject = stripDashes(format === "gatekeeper" ? lineCardSubject({ seed: opts.seed, gatekeeper: { company: opts.company } }) : lineCardSubject({ words, families: fams, seed: opts.seed }));
  return { subject, body, personalized: [openerText, triggers, closing].join("\n\n"), format, attach_line_card: true };
}

// ---------- validation ----------

export type LineCardProblem = { rule: string; problem: string; hard: boolean };

const SPEC_TOKEN = /\b(?:[A-Z]{1,2}-?\d{2,4}[A-Z]{0,2}|\d{3,4}[A-Z]{1,3}|(?:Class|Gr(?:ade)?)\.? ?[0-9][0-9.]*|Xylan ?\d+|Inconel ?\d+|Monel ?[A-Z]?-?\d+|Hastelloy ?[A-Z]-?\d+|Incoloy ?\d+[A-Z]?)\b/g;
const norm = (s: string) => s.toUpperCase().replace(/[\s\-_/()]+/g, "");
/** Nothing about where we are, ever (Walt 10/7). */
export const LOCATION_WORDS = /warehouse|ship from|Oakland|Houston|Burbank|San Francisco|Howard Street|national supplier|local to|minutes from/i;
const ASSUMED_FILING = /you said you file|the way you file|your vendor contact|contact card/i;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/**
 * The checks on a line card email: hard ones fail the draft, soft ones show in the panel as warnings.
 * `personalized` is the opener, the triggers and the closing; `transcript` is what the buyer actually said.
 */
export function validateLineCardEmail(email: { subject: string; body: string }, req: LineCardRequest, format: EmailFormat, personalized: string, transcript: string): LineCardProblem[] {
  const out: LineCardProblem[] = [];
  const hard = (rule: string, problem: string) => out.push({ rule, problem, hard: true });
  const soft = (rule: string, problem: string) => out.push({ rule, problem, hard: false });
  const body = email.body;
  if (DASHES.test(body) || DASHES.test(email.subject)) hard("dashes", "Em or en dash in the subject or body.");
  if (email.subject.length > SUBJECT_MAX) hard("subject", `Subject is ${email.subject.length} characters; the limit is ${SUBJECT_MAX}.`);
  if (!/^Westgate Supply(:| line card for )/.test(email.subject)) hard("subject", 'Subject must start with "Westgate Supply:".');
  const loc = `${email.subject}\n${body}`.match(LOCATION_WORDS);
  if (loc) hard("location", `Names where we are ("${loc[0]}"); nothing about warehouses or cities goes in a line card email.`);
  // Phone numbers only from config.
  const allowed = new Set([config.company.phone].filter(Boolean).map((p) => p!.replace(/\D/g, "")));
  for (const m of body.matchAll(/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (!allowed.has(digits)) hard("phone", `A phone number the config doesn't know: "${m[0]}".`);
  }
  // No repeats.
  if (count(body, /\bPDF\b/g) > 1) hard("repeat", `"PDF" appears ${count(body, /\bPDF\b/g)} times; once, in the opener.`);
  // "certs attached" in the block header is the card's own line; the wrapper may say "attached" once.
  if (count(personalized, /\battached\b/gi) > 1) hard("repeat", `"attached" appears ${count(personalized, /\battached\b/gi)} times in the wrapper; once, in the opener.`);
  if (count(body, /\bNo minimum/gi) > 1) hard("repeat", `"No minimum order" appears ${count(body, /\bNo minimum/gi)} times; once, in the block header.`);
  if (count(body, /\bMTR/g) > 2) hard("repeat", `"MTR" appears ${count(body, /\bMTR/g)} times; at most twice.`);
  if (req.filingMethod === "unknown" && ASSUMED_FILING.test(body)) hard("assumed", "Says how they file vendors, but they never said.");
  const named = FAMILIES.filter((f) => body.toLowerCase().includes(f.name.toLowerCase())).length;
  if (format === "niche") {
    for (const id of req.relevantFamilies) if (!body.includes(familyById(id).name)) hard("families", `Niche email is missing the ${familyById(id).name} family they buy.`);
  } else if (format !== "pdf_only" && named < 10) hard("families", `Only ${named} of the 12 product families are named in the body.`);
  for (const s of personalized.split(/(?<=[.!?])\s+/)) {
    if (IDENTITY.some((r) => r.test(s))) hard("identity", `Phrases Westgate as someone the rep called: "${s.trim()}"`);
    if (HEDGE.test(s)) hard("hedging", `Hedges the ask: "${s.trim()}"`);
  }
  if (/\b(old|older|past|recent|previous) (rfq|po|purchase order|quote)\b/i.test(personalized)) hard("benchmark", "Asks for an old RFQ to re-price; Walt doesn't want that line.");
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
  const sentences = personalized.split(/\n\n/)[0].split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (sentences < 2 || sentences > 4) soft("length", `The opener is ${sentences} sentences; the target is 2 to 4.`);
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
    composed = composeLineCardEmail({ req, format, opener, rep: { name: d.rep.name, email: d.rep.email, phone: d.rep.phone ?? null }, first, company: opts.company, seed: opts.leadId, attached });
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
