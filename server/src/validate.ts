import { z } from "zod/v4";
import { background } from "./background.js";
import { FileStore, store } from "./store.js";
import type { LeadContext } from "./context.js";
import { transcriptText } from "./close.js";
import type { Proposals } from "./schemas.js";

// Pre-save validation for every generated email (Walt 9/24). A draft that
// fails any check is regenerated; a failing draft is never saved to Close.
// Every rejection is logged with the rule it broke.

export const RULES = ["identity", "who_said_what", "recipient_readback", "names", "dashes", "intro_format"] as const;
export type Rule = (typeof RULES)[number];
export type Failure = { rule: Rule; sentence: string | null; problem: string };

type Email = NonNullable<Proposals["email"]>;

// 1. Identity: Walt works for Westgate. Westgate is never the thing he called, reached, or buys from.
const CALL_VERB = String.raw`(?:called|call|calling|phoned|contacted|contact|contacting|reached(?:\s+out)?(?:\s+to)?|reach(?:ing)?\s+out\s+to|spoke\s+(?:with|to)|speak(?:ing)?\s+(?:with|to)|talked\s+(?:with|to)|emailed|heard\s+(?:back\s+)?from|(?:am|was|have\s+been)\s+a\s+customer\s+of|buy\s+from|bought\s+from|order(?:ed)?\s+from)`;
const IDENTITY = [
  new RegExp(String.raw`\bI(?:'ve|'d|\s+have|\s+had|\s+just|\s+recently|\s+also)*\s+${CALL_VERB}\s+(?:(?:the\s+)?(?:team|folks|people|office)\s+(?:at|over\s+at)\s+)?Westgate\b`, "i"),
  /\bat Westgate,? I\b/i,
  /\bI(?:'m|\s+am|\s+was|'ve\s+been|\s+have\s+been)\s+(?:a\s+)?(?:long-?time\s+|loyal\s+|happy\s+)?customer\s+of\s+Westgate\b/i,
  /\b(my|our) (call|conversation|chat) with Westgate\b/i,
  /\bWestgate (told|let) me\b/i,
];

const sentences = (body: string) => body.split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z"'])/).map((s) => s.trim()).filter(Boolean);
const first = (name: string) => name.trim().split(/\s+/)[0].replace(/[^A-Za-z'-]/g, "").toLowerCase();
const GREETING = /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|dear)\s+([A-Z][A-Za-z'-]+)/i;
const SPOKE_WITH = /\b(?:spoke|speaking|talked|talking|chatted) (?:with|to) ([A-Z][a-z'-]+)|\b([A-Z][a-z'-]+) (?:suggested|mentioned|said|told me|let me know|pointed me|passed along)\b/g;
const NOT_NAMES = new Set(["i", "we", "you", "they", "he", "she", "it", "westgate", "thanks", "the", "who", "that"]);

/** The checks code can make exactly: identity phrasing, names, dashes. */
export function ruleChecks(email: Email, ctx: LeadContext, transcript: string | null, repName: string, opts: { intro?: Referral | null } = {}): Failure[] {
  const out: Failure[] = [];
  const body = email.body;
  if (opts.intro) out.push(...introChecks(email, opts.intro));
  for (const s of sentences(body)) {
    if (IDENTITY.some((r) => r.test(s))) out.push({ rule: "identity", sentence: s, problem: `Phrases Westgate as someone ${repName.split(" ")[0]} contacted; he works for Westgate ("I'm ${repName.split(" ")[0]} with Westgate Supply").` });
  }
  if (/[—–]/.test(body)) out.push({ rule: "dashes", sentence: sentences(body).find((s) => /[—–]/.test(s)) ?? null, problem: "Em or en dash in the body." });

  // 4. Names: greeting = a recipient; every name on the email is a real contact or was said on the call; the gatekeeper isn't the recipient.
  // The lead record (contacts, notes, earlier calls) and this call's transcript.
  const record = [
    ...ctx.contacts.map((c) => c.name ?? ""),
    ...ctx.notes.map((n) => n.note),
    ...ctx.calls.map((c) => [c.note, transcriptText(c.recording_transcript)].join(" ")),
    transcript ?? "",
    // Whoever we're writing to, by the name in their address ("renee@…" → Renee).
    ...email.to.map((r) => r.email.split("@")[0].replace(/[._-]+/g, " ")),
  ].join(" ");
  const known = record.split(/[^A-Za-z'-]+/).map(first).filter(Boolean);
  const isKnown = (n: string) => known.includes(first(n));
  const recipients = email.to.map((r) => first(r.name)).filter(Boolean);
  const greet = body.trim().match(GREETING)?.[1];
  if (greet && !["team", "there", "all"].includes(greet.toLowerCase())) {
    if (recipients.length && !recipients.includes(first(greet))) {
      out.push({ rule: "names", sentence: body.trim().split("\n")[0], problem: `Greets ${greet} but it's addressed to ${email.to.map((r) => r.name).join(", ")}.` });
    }
    if (!isKnown(greet)) out.push({ rule: "names", sentence: body.trim().split("\n")[0], problem: `${greet} isn't a contact on the lead and wasn't named on the call.` });
  }
  for (const r of email.to) {
    if (r.name && !isKnown(r.name) && !r.email.toLowerCase().includes(first(r.name))) {
      out.push({ rule: "names", sentence: null, problem: `Recipient ${r.name} isn't a contact on the lead and wasn't named on the call.` });
    }
  }
  for (const m of body.matchAll(SPOKE_WITH)) {
    const name = m[1] ?? m[2];
    if (!name || NOT_NAMES.has(name.toLowerCase()) || first(name) === first(repName)) continue;
    const s = sentences(body).find((x) => x.includes(m[0])) ?? m[0];
    if (greet && first(name) === first(greet) && /spoke|speaking|talked|talking|chatted/.test(m[0]) && !/\byou\b/i.test(s)) {
      out.push({ rule: "names", sentence: s, problem: `${name} is both the person greeted and the person you "spoke with": the recipient and the gatekeeper are swapped.` });
    } else if (!isKnown(name)) {
      out.push({ rule: "names", sentence: s, problem: `${name} wasn't named on the call and isn't a contact on the lead.` });
    }
  }
  return out;
}

// ---------- cold intro via gatekeeper (Walt 9/24) ----------

export type Referral = { gatekeeper: string; recipient: string; said_about_recipient: string | null; back_when: string | null };

export const INTRO_SUBJECT = "Westgate Supply – line card";
export const INTRO_OFFER = "If any of your projects have an open RFQ or a materials list out for pricing, I'd be glad to put a quick quote together so you can see how we compare. Otherwise no rush at all.";
/** Nothing that implies the recipient already spoke with Walt, and no RFQ push or past-RFQ ask. */
const INTRO_NEVER = /\byou mentioned\b|\bas we discussed\b|\bas discussed\b|\bour (call|conversation|chat)\b|\bgreat (talking|speaking|chatting) with you\b|\bthanks for (taking )?(my|the) call\b|\breply here\b|\bjust reply (to this email )?with\b|\bwhenever you('ve| have) got an rfq\b|\bstack up\b|\bno strings\b|\b(recent|past|old) (rfq|po)\b|\bprice it\b/i;

function introChecks(email: Email, r: Referral): Failure[] {
  const out: Failure[] = [];
  const fail = (problem: string, sentence: string | null = null) => out.push({ rule: "intro_format", sentence, problem });
  const body = email.body;
  // Parts 1-4 (between the greeting and the closer) stay under 130 words; Walt's Probst example is 125.
  const paras = body.trim().split(/\n\s*\n/);
  const content = paras.slice(GREETING.test(paras[0]) ? 1 : 0, Math.max(1, paras.length - 2));
  const words = content.join(" ").split(/\s+/).filter(Boolean).length;
  if (words >= 130) fail(`Cold intro is ${words} words before the closer; it must be under 130.`);
  for (const s of sentences(body)) if (INTRO_NEVER.test(s)) fail("Implies the recipient already spoke with Walt, pushes for an RFQ, or asks for a past RFQ; none belong in a cold intro.", s);
  const gk = first(r.gatekeeper);
  const opening = sentences(body).slice(0, 3).join(" ").toLowerCase();
  if (gk && !opening.includes(gk)) fail(`Doesn't open with who Walt spoke to (${r.gatekeeper}).`);
  if (!/attached our line card so you can see the full range/i.test(body)) fail(`Missing "I've attached our line card so you can see the full range."`);
  if (!/open RFQ or a materials list out for pricing/i.test(body) || !/no rush at all/i.test(body)) fail(`Missing the soft offer: "${INTRO_OFFER}"`);
  if (!/\b(give you a call|call you)\b/i.test(body)) fail("Missing the next touch (when Walt will call to introduce himself).");
  if (r.back_when && !body.toLowerCase().includes(r.back_when.toLowerCase().replace(/^(on|until) /, ""))) fail(`${r.gatekeeper} said ${first(r.recipient)} is back ${r.back_when}; the next-touch line should name it.`);
  return out;
}

export const EmailReviewSchema = z.object({
  failures: z.array(z.object({
    rule: z.enum(RULES),
    sentence: z.string().nullable().describe("The exact sentence from the draft"),
    problem: z.string().describe("What's wrong, in one line"),
  })).describe("Only clear violations. Empty if the draft is fine."),
});

/** Task text for the reviewing model: checks 2–4, which need judgment. */
/** The rep testing the pipeline on themselves: the recipient has their name, or a Westgate address. */
export function isSelfTest(email: Email, repName: string): boolean {
  const first = repName.split(" ")[0].toLowerCase();
  return email.to.some((r) => /@westgatesupply\.com$/i.test(r.email) || r.name.trim().toLowerCase() === repName.trim().toLowerCase() || r.name.trim().split(/\s+/)[0].toLowerCase() === first);
}

export function reviewTask(email: Email, repName: string): string {
  const who = repName.split(" ")[0];
  return [
    isSelfTest(email, repName)
      ? `This is a TEST: ${repName} is calling and emailing himself to check the system, so the recipient shares his name (and may use a Westgate address). Do not flag that the sender and recipient are the same person or share a name or domain; judge everything else as if the recipient were a real prospect.`
      : "",
    `Review this follow-up email draft before it's saved. ${repName} (the sender) works for Westgate Supply; the recipient works at the prospect company in the lead record above. Judge ONLY the four rules below and report only clear violations; an empty list means it passes. Don't report rules that pass, and don't judge style, length, structure, or whether a paragraph belongs in the email (e.g. the optional past-RFQ offer or the "I'll give you a call" line are decided elsewhere and are allowed).`,
    `identity: any sentence that treats Westgate Supply as a company ${who} called, contacted, reached, spoke with, or is a customer of (he works there; right is "I'm ${who} with Westgate Supply").`,
    "who_said_what: every claim about the prospect (their products, who's out of office, what they said or asked for) must come from the transcript or the lead record; every claim about Westgate (products, warehouses, capabilities) must come from the playbook. Flag anything invented, and anything moved from one side to the other (e.g. a product the prospect makes described as something Westgate supplies, or something Walt said attributed to the prospect).",
    "recipient_readback: read it as the recipient. Flag any sentence that would confuse them about who is writing, who works where, or what is being asked.",
    "names: the greeting name, the person referred to as the one Walt spoke with (the gatekeeper), and the recipient must match the lead's contacts and the transcript, and must not be swapped (e.g. greeting the gatekeeper in an email addressed to the buyer).",
    `The draft:\nTo: ${email.to.map((r) => `${r.name} <${r.email}>`).join(", ")}\nSubject: ${email.subject}\n\n${email.body}`,
  ].filter(Boolean).join("\n\n");
}

/** Feedback appended to the prompt when a draft is regenerated. */
export function retryNote(failures: Failure[]): string {
  return `Your previous draft was rejected by the pre-save checks. Write it again and fix these:\n${failures.map((f) => `- [${f.rule}] ${f.problem}${f.sentence ? ` (in: "${f.sentence}")` : ""}`).join("\n")}`;
}

// ---------- rejection log ----------

export type Rejection = { at: string; leadId: string; company: string; callId: string | null; attempt: number; failures: Failure[]; subject: string; body: string; final: boolean; fixed?: boolean };

export function logRejection(r: Rejection) {
  console.info(`[email-check] rejected ${r.company} attempt ${r.attempt}: ${r.failures.map((f) => `${f.rule}: ${f.problem}`).join(" | ")}`);
  background(store.logRejection(r), "rejection log");
}

/** The latest rejections and how often each rule fails, for review. */
export async function rejections(limit = 100): Promise<{ byRule: Record<string, number>; items: Rejection[] }> {
  const items = (await store.rejections(limit)) as Rejection[];
  const byRule: Record<string, number> = {};
  for (const r of items) for (const f of r.failures) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return { byRule, items };
}

/** Tests only. */
export function resetRejections() {
  if (store instanceof FileStore) store.resetRejections();
}
