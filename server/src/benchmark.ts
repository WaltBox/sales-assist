import type { LeadContext } from "./context.js";
import { businessDaysAt, isoWithOffset } from "./rules.js";
import type { Proposals } from "./schemas.js";
import { HEDGE } from "./validate.js";

// The past-RFQ ask (Walt 9/24, reworded 9/28): when a buyer has nothing open, the
// follow-up email asks, in one plain sentence, for a recent RFQ or PO to price.
// No hedging ("no strings", "no pressure", "see how we stack up"): it sounds like a
// pitch. All we want is their RFQ.

// Phrases that mean "no current RFQ". The model flags paraphrases too.
export const NO_RFQ = /nothing (right )?now|no open rfqs?|no rfqs right now|bought for the year|nothing going on|not at the moment|maybe in a couple (of )?months|here and there/i;

/** Plain asks. The model picks one and adapts it; the server falls back to these. */
export const OFFERS = [
  "Send over a recent RFQ or PO and I'll price it.",
  "If you have a recent RFQ or PO handy, send it my way and I'll quote it.",
  "Reply with a recent RFQ or PO and I'll price it for you.",
];

/** A sentence that's making the past-RFQ offer, however it was worded. */
const OFFER = /\b(recent|past|old|previous|last)\b[^.!?]{0,40}\b(RFQs?|POs?|quotes?|bid tabs?)\b|\bstack up\b|\bnumbers compare\b|\bcomparison on hand\b|\bas if it were live\b|\bbenchmark\b/i;
const PRICING = /\b(price|priced|pricing|quote|compare|comparison|stack up)\b|as if it were live|benchmark/i;
/** An offer to price a past RFQ/PO (not a sentence recalling what the buyer said about one). */
const isOffer = (s: string) => OFFER.test(s) && PRICING.test(s) && !/\byou (mentioned|said|told)\b/i.test(s);
/** What the offer must never say. */
const NEVER = /shoot it over|no obligation|side-by-side|what you paid|come in at|as if it were live|benchmark/i;
const SIGN_OFF = /^(no (pressure|strings|worries)|totally optional)\b[^.!?]{0,25}[.!?]$/i;
/** Things the offer may only mention if the buyer brought them up. */
const UNMENTIONED = [
  { said: /approv/i, bad: /approv/i },
  { said: /supplier list|vendor list|approved (supplier|vendor)|on (the|your) list|add(ed)? to (the|your) list/i, bad: /\b(supplier|vendor)s?\b|\bto (the|your) list\b/i },
];

/** Asking for something now after they promised the next one (Walt 9/24). */
const PUSH_NOW = /\bsomething small\b|\banything at all\b|\beven (a )?(small|little|rough)\b|\bwhatever(’|')?s on your desk\b|\bif (anything|something) is on your desk\b/i;
/** The sentence acknowledging "I'll send the next one". */
const NEXT_ONE = /\bnext (one|project|rfq|quote|job|bid|list|order)\b|\bwhen(ever)? (the next|something|one) (comes|pops) up\b/i;

export type BenchmarkSignals = {
  no_current_rfq: boolean;
  rfq_promised: boolean;
  benchmark_agreed: boolean;
  soft_yes: boolean;
  asked_specific_callback: boolean;
  next_one_promised?: boolean;
};

/** Whether the email should carry the past-RFQ offer. */
export function benchmarkDecision(s: BenchmarkSignals, ctx: LeadContext, transcript: string | null): boolean {
  if (s.benchmark_agreed || s.asked_specific_callback || ctx.facts.vendor || ctx.facts.competitorHits.length) return false;
  // "I'll send the next one": acknowledge it, then offer to price a past one.
  if (s.next_one_promised) return true;
  const noRfq = s.no_current_rfq || NO_RFQ.test(transcript ?? "");
  return noRfq && !s.rfq_promised && !s.soft_yes;
}

const splitSentences = (p: string) => p.split(/(?<=[.!?])\s+(?=[A-Z"'])/);

export function hasBenchmark(body: string) {
  return splitSentences(body).some(isOffer);
}

function acceptable(sentence: string, transcript: string) {
  if (NEVER.test(sentence) || HEDGE.test(sentence) || sentence.split(/\s+/).length > 32) return false;
  return UNMENTIONED.every((u) => !u.bad.test(sentence) || u.said.test(transcript));
}

/**
 * Makes the email match the decision. With the offer: exactly one acceptable
 * sentence, on its own line after what we'd supply and before the closer
 * (Walt's wording when the model's broke a rule or was missing). Without it:
 * any offer the model slipped in comes out.
 */
export function enforceBenchmark(
  email: Proposals["email"], want: boolean, warnings: string[], opts: { agreed?: boolean; transcript?: string | null; nextOne?: boolean } = {},
): Proposals["email"] {
  if (!email) return email;
  if (!want && opts.agreed) return email; // they said on the call they'd send one: the email should reference it
  let paras = email.body.split(/\n\s*\n/);
  if (opts.nextOne) {
    // They'll send the next one: never ask for "something small" or "anything at all" now.
    const before = paras.join("\n\n");
    paras = paras.map((p) => splitSentences(p).filter((s) => !PUSH_NOW.test(s)).join(" ")).filter((p) => p.trim());
    if (paras.join("\n\n") !== before) warnings.push("Took out asking for something now; they said they'll send the next one.");
    email = { ...email, body: paras.join("\n\n") };
  }
  // Offer sentences, plus any follow-on sentence that explains them ("No obligation, it gives you…").
  let firstAt = -1;
  const found: string[] = [];
  const kept = paras.map((p, i) => {
    const sentences = splitSentences(p);
    let prevOffer = false;
    return sentences.filter((s) => {
      if (isOffer(s)) { found.push(s); if (firstAt < 0) firstAt = i; prevOffer = true; return false; }
      // A tail on the offer: a short sign-off ("No pressure either way.") stays with it; an explanation gets caught by NEVER.
      if (prevOffer && (NEVER.test(s) || SIGN_OFF.test(s))) { found[found.length - 1] += ` ${s}`; return false; }
      prevOffer = false;
      return true;
    }).join(" ");
  });
  const join = (ps: string[]) => ps.filter((p) => p.trim()).join("\n\n");
  if (!want) return found.length ? { ...email, body: join(kept) } : email;

  const own = found.length === 1 && acceptable(found[0], opts.transcript ?? "") ? found[0] : null;
  if (own && paras[firstAt].trim() === own.trim()) return email; // already its own clean line
  if (opts.nextOne) {
    // Right after the line acknowledging the next one (same paragraph), else before the closer.
    if (own && splitSentences(paras[firstAt]).some((s, j, all) => s === own && j > 0 && NEXT_ONE.test(all[j - 1]))) return email;
    const sentence = own ?? OFFERS[0];
    const rest = kept.filter((p) => p.trim());
    const at = rest.findIndex((p, i) => i > 0 && NEXT_ONE.test(p));
    if (at >= 0) {
      const ss = splitSentences(rest[at]);
      const k = ss.findIndex((s) => NEXT_ONE.test(s));
      ss.splice(k + 1, 0, sentence);
      rest[at] = ss.join(" ");
    } else rest.splice(Math.max(1, rest.length - 2), 0, sentence);
    if (!own) warnings.push(found.length ? "Rewrote the past-RFQ offer to one casual sentence." : "Added the one-line past-RFQ offer after the next-one line.");
    return { ...email, body: join(rest) };
  }
  const seed = [...(email.to[0]?.email ?? "")].reduce((n, c) => n + c.charCodeAt(0), 0);
  const sentence = own ?? OFFERS[seed % OFFERS.length];
  warnings.push(found.length
    ? own ? "Moved the past-RFQ offer onto its own line." : "Rewrote the past-RFQ offer to one casual sentence."
    : "Added the one-line past-RFQ offer (they have nothing open right now).");
  const rest = kept.filter((p) => p.trim());
  // [greeting, thanks, what we'd supply, (ask), closer, signature]: the offer goes before the closer.
  rest.splice(Math.max(1, rest.length - 2), 0, sentence);
  return { ...email, body: join(rest) };
}

/** No em or en dashes in email bodies (Walt 9/24). Number ranges keep a hyphen. */
/**
 * Paragraphs, even when the model writes one block (Walt 9/29, the Anthony Labetti draft): greeting on its own,
 * then the pitch, the line card, the "got it" ask and the call line as short paragraphs, the thanks, the name.
 * An email that already has its paragraphs is left alone.
 */
export function formatParagraphs(body: string, repName?: string): string {
  let text = body.replace(/\r\n/g, "\n").trim();
  let sig = "";
  if (repName && text.endsWith(repName)) { sig = repName; text = text.slice(0, -repName.length).trim(); }
  else {
    // No name given: a last line that's just a name ("Walt Boxwell") is the signature.
    const last = text.match(/\n\s*([A-Z][a-z]+(?: [A-Z][a-z.'-]+){1,2})\s*$/);
    if (last) { sig = last[1]; text = text.slice(0, last.index).trim(); }
  }
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 3) return [...paras, sig].filter(Boolean).join("\n\n");
  let flat = paras.join(" ").replace(/\s*\n\s*/g, " ").trim();
  const out: string[] = [];
  const hi = flat.match(/^((?:hi|hello|hey|good (?:morning|afternoon))\b[^,.!?\n]{0,40}[,!])\s*/i);
  if (hi) { out.push(hi[1]); flat = flat.slice(hi[0].length); }
  let closer = "";
  const bye = flat.match(/\s*((?:thanks|thank you|thanks again|best|cheers|appreciate it)\b[^.!?]{0,40}[.!]?)$/i);
  if (bye && bye.index! > 0) { closer = bye[1]; flat = flat.slice(0, bye.index).trim(); }
  const sentences = flat.split(/(?<=[.!?]["”']?)\s+(?=["“']?[A-Z])/).filter((x) => x.trim());
  const cue = /^["“']?(i've attached|i have attached|attached|mind replying|could you reply|can you reply|would you mind replying|i'll give you a call|i'll call|i will call)\b/i;
  let cur: string[] = [];
  for (const sn of sentences) {
    if (cur.length && (cue.test(sn) || cur.length >= 3)) { out.push(cur.join(" ")); cur = []; }
    cur.push(sn);
  }
  if (cur.length) out.push(cur.join(" "));
  return [...out, closer, sig].filter(Boolean).join("\n\n");
}

export function stripDashes(body: string) {
  return body
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/,\s*([,.!?;:])/g, "$1")
    .replace(/^, /gm, "")
    .replace(/[ \t]+$/gm, "");
}

/** "Confirm benchmark RFQ from {name} received; nudge if not", 2 business days out, instead of the 3-week check-in. */
export function applyBenchmarkTask(p: Proposals, ctx: LeadContext, name: string | null, now: Date) {
  const tz = ctx.facts.prospectTz ?? "America/Los_Angeles";
  const who = (name ?? ctx.facts.askForDefault ?? "the buyer").replace(/\s*\(.*?\)\s*/g, " ").trim();
  const due = businessDaysAt(tz, now, 2, 10, 0);
  const first = who.split(/\s+/)[0].toLowerCase();
  const known = p.tasks.find((t) => t.ask_for.toLowerCase().includes(first) && (t.phone || t.email));
  // Drop the default long check-in (anything a week or more out that's a check-in/follow-up).
  p.tasks = p.tasks.filter((t) => !(new Date(t.due_at).getTime() - now.getTime() > 7 * 864e5 && /check.?in|follow.?up|touch base|reconnect/i.test(t.title)));
  p.tasks = p.tasks.filter((t) => !/benchmark/i.test(t.title));
  p.tasks.unshift({
    due_at: isoWithOffset(due, tz),
    title: `Confirm benchmark RFQ from ${who} received; nudge if not`,
    ask_for: who,
    phone: known?.phone ?? null,
    email: known?.email ?? null,
    why: "Agreed to send a past RFQ or PO for us to price",
    deadline: null,
    pitch: "If it hasn't come in, a friendly nudge: any recent RFQ or PO works and we'll price it.",
    details: null,
  });
}

/** Line card emails ask for a quick "got it" reply (Walt 9/26): it tells us the email didn't land in junk, and a reply keeps the thread out of spam. */
export const GOT_IT_LINE = 'Mind replying "got it" when this comes through?';

type Email = NonNullable<Proposals["email"]>;

export function enforceGotIt(email: Email): Email {
  if (!email.attach_line_card || /\bgot it\b/i.test(email.body)) return email;
  const rest = email.body.split(/\n\s*\n/).filter((p) => p.trim());
  // Right before the sign-off ("Thanks again, talk soon."), found by what it says, not by position:
  // the signature isn't always there yet, and the last ask can come after the offer (9/26).
  const closer = rest.findLastIndex((p, i) => i > 0 && /^(thanks|thank you|talk soon|best|cheers|regards|have a (great|good))\b/i.test(p.trim()));
  const signature = rest.length > 1 && rest[rest.length - 1].trim().split(/\s+/).length <= 4 && !/[.?!:]$/.test(rest[rest.length - 1].trim()) ? rest.length - 1 : -1;
  rest.splice(closer > 0 ? closer : signature > 0 ? signature : rest.length, 0, GOT_IT_LINE);
  return { ...email, body: rest.join("\n\n") };
}
