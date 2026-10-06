import { z } from "zod";
import type { Deps } from "./assistant.js";
import { untrusted } from "./claude.js";
import { config } from "./config.js";

/**
 * The purchasing cycle (Walt 10/5): how often they send RFQs, when, whether they bid it out or keep a vendor list,
 * how to get on that list, who they buy through, how many buyers. Heard on the call (the transcript, with the
 * buyer's words kept as the evidence), confirmed or corrected by the rep in the side panel, written to Close as a
 * [Purchasing] note. A field the buyer never answered stays empty: nothing is guessed.
 */
export const PURCHASING_TAG = "[Purchasing]";

export const FIELDS = ["rfq_volume", "rfq_timing", "buying_mode", "vendor_policy", "how_to_get_on_list", "works_through", "buyer_count", "incumbent", "cycle_notes"] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_LABEL: Record<Field, string> = {
  rfq_volume: "RFQs per week", rfq_timing: "When they send them", buying_mode: "Buying mode", vendor_policy: "Vendors", how_to_get_on_list: "How to get on the list",
  works_through: "They buy through", buyer_count: "Buyers on the team", incumbent: "Who they buy from now", cycle_notes: "Their cycle, in their words",
};
export const BUYING_MODES = ["project", "ongoing", "both"] as const;
export const VENDOR_POLICIES = ["open bid", "preferred list", "single source", "contract elsewhere"] as const;
export const WORKS_THROUGH = ["owner direct", "GC", "sub", "PM"] as const;

/** One answer: the value, the buyer's words it came from, when, and whether the rep confirmed it. */
export type Answer = { value: string; quote: string | null; at: string; confirmed: boolean };
export type Purchasing = Partial<Record<Field, Answer>>;

const ans = (what: string) => z.object({ value: z.string(), quote: z.string().describe("The buyer's own words this came from, one sentence, verbatim from the transcript.") }).nullable().describe(`${what} Null if the buyer didn't say.`);

export const PurchasingSchema = z.object({
  rfq_volume: ans("How many RFQs they send out, as a short value like '~15/week', '2-3/month', 'a few a year'. Convert what they said to a per-week or per-month figure in the value; keep their words in the quote."),
  rfq_timing: ans("When they typically send RFQs: a day ('Mondays'), a trigger ('when a job is awarded'), or a season ('spring turnaround')."),
  buying_mode: z.object({ value: z.enum(BUYING_MODES), quote: z.string() }).nullable().describe("project: they buy job by job. ongoing: day-to-day MRO/stock buying. both. Null if they didn't say."),
  vendor_policy: z.object({ value: z.enum(VENDOR_POLICIES), quote: z.string() }).nullable().describe("open bid: they send RFQs to whoever. preferred list: a set vendor list you must get on. single source: one supplier. contract elsewhere: locked into a contract with another supplier. Null if they didn't say."),
  how_to_get_on_list: ans("What it takes to become a vendor they send RFQs to: 'send W-9 and ISO cert', 'vendor form on their portal', 'just email the buyer'."),
  works_through: z.object({ value: z.enum(WORKS_THROUGH), quote: z.string() }).nullable().describe("Who the buying goes through: owner direct, a GC, a sub, or project managers. Null if they didn't say."),
  buyer_count: ans("How many people do the purchasing, as a number or range ('2', '4-5')."),
  incumbent: ans("Who they buy pipe, valves and fittings from now (a company name), if they named anyone."),
  cycle_notes: ans("One or two sentences, close to their words, on how their purchasing cycle works, if they described it."),
});

/** The buyer's answers in a transcript, each with the line it came from. Nothing for a call where they said nothing. */
export async function extractPurchasing(d: Deps, company: string, transcript: string, callAt: string): Promise<Purchasing> {
  if (!transcript || transcript.split(/\s+/).length < 60) return {};
  const { data } = await d.llm({
    schema: PurchasingSchema, effort: "low", model: config.briefModel,
    context: untrusted(`CALL TRANSCRIPT with ${company}`, transcript),
    task: `From this call, pull what the buyer (not the rep, not a receptionist or phone menu) said about their purchasing cycle: how many RFQs they send and when, whether they buy by project or day to day, whether they bid it out or have a vendor list, how to get on that list, who the buying goes through, how many buyers, who they buy from now. Only what was actually said on the call, with the buyer's words as the quote. Leave a field null if it wasn't covered.`,
  });
  const out: Purchasing = {};
  for (const f of FIELDS) {
    const v = data[f];
    if (v && v.value.trim()) out[f] = { value: v.value.trim(), quote: v.quote?.trim() || null, at: callAt, confirmed: false };
  }
  return out;
}

/** What the rep typed or confirmed: every field given becomes a confirmed answer; empty strings clear a field. */
export function confirmAnswers(prev: Purchasing | null | undefined, given: Partial<Record<Field, string | null>>, quotes: Partial<Record<Field, string | null>>, at: string): Purchasing {
  const out: Purchasing = { ...(prev ?? {}) };
  for (const f of FIELDS) {
    if (!(f in given)) continue;
    const value = (given[f] ?? "").trim();
    if (!value) { delete out[f]; continue; }
    const same = prev?.[f]?.value === value;
    out[f] = { value, quote: quotes[f] ?? (same ? prev![f]!.quote : null), at, confirmed: true };
  }
  return out;
}

/** The newest answers win; a confirmed one beats an unconfirmed one of the same age. */
export function mergePurchasing(prev: Purchasing | null | undefined, next: Purchasing): Purchasing {
  const out: Purchasing = { ...(prev ?? {}) };
  for (const f of FIELDS) {
    const a = out[f], b = next[f];
    if (!b) continue;
    if (!a || b.at > a.at || (b.at === a.at && b.confirmed)) out[f] = b;
    // Never let an unconfirmed read overwrite what the rep confirmed on the same or a later day.
    if (a?.confirmed && !b.confirmed && a.at >= b.at) out[f] = a;
  }
  return out;
}

/** The note for the lead's timeline in Close: readable, one line per answer, the quote after it. */
export function purchasingNote(p: Purchasing): string {
  const lines = FIELDS.filter((f) => p[f]).map((f) => `${FIELD_LABEL[f]}: ${p[f]!.value}${p[f]!.quote ? ` — “${p[f]!.quote}”` : ""}`);
  return `${PURCHASING_TAG} ${lines.join("\n")}`;
}

/** A weekly figure from an answer like '~15/week', '2-3/month', 'a few a year', 'once a week, every couple weeks'. */
export function rfqsPerWeek(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.toLowerCase();
  const nums = [...v.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  let n = nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : /\bone\b|once|single/.test(v) ? 1 : /a few|several|couple/.test(v) ? 2.5 : null;
  if (n === null) return null;
  if (/day|daily/.test(v)) n *= 5;
  else if (/month/.test(v)) n /= 4.3;
  else if (/year|annual/.test(v)) n /= 52;
  else if (/every (couple|few|two|2) weeks|biweekly|every other week/.test(v)) n /= 2;
  return Math.round(n * 10) / 10;
}

/** The tier the call answers point at, if they settle it; null when they don't. */
export function tierFromPurchasing(p: Purchasing | null | undefined): "steady" | "project" | "occasional" | null {
  if (!p) return null;
  const policy = p.vendor_policy?.value;
  if (policy === "single source" || policy === "contract elsewhere") return "occasional";
  const perWeek = rfqsPerWeek(p.rfq_volume?.value);
  if (perWeek !== null) return perWeek >= 3 ? "steady" : perWeek >= 0.5 ? "project" : "occasional";
  if (p.buying_mode?.value === "project") return "project";
  if (p.buying_mode?.value === "ongoing" || p.buying_mode?.value === "both") return "steady";
  return null;
}

/** The one question worth asking next on this account, by value: volume, then the vendor list, then how to get on it. */
export function askNext(p: Purchasing | null | undefined): { field: Field; question: string } | null {
  const order: Array<[Field, string]> = [
    ["rfq_volume", "Roughly how many RFQs do you send out a week?"],
    ["vendor_policy", "Do you bid those out, or do you have a set list of vendors?"],
    ["how_to_get_on_list", "What's the easiest way for us to get on that list?"],
    ["buying_mode", "Is that mostly project by project, or day-to-day stock?"],
    ["incumbent", "Who are you getting pipe and fittings from now?"],
    ["works_through", "Does the buying go through you, or a GC or project manager?"],
    ["buyer_count", "How many of you handle the purchasing?"],
  ];
  // "How to get on the list" only matters once they've said there is one.
  for (const [field, question] of order) {
    if (p?.[field]) continue;
    if (field === "how_to_get_on_list" && p?.vendor_policy?.value !== "preferred list") continue;
    return { field, question };
  }
  return null;
}

/** Short lines for the drawer: what the rep heard, newest first. */
export function heardLines(p: Purchasing | null | undefined): string[] {
  if (!p) return [];
  return FIELDS.filter((f) => p[f] && f !== "cycle_notes").map((f) => `${FIELD_LABEL[f]}: ${p[f]!.value}${p[f]!.confirmed ? "" : " (heard, not confirmed)"}`);
}
