import { z } from "zod/v4";
import type { Deps } from "./assistant.js";
import { config } from "./config.js";
import type { QueueItem } from "./queue.js";
import { localDay } from "./stats.js";
import { store, type RungEvent } from "./store.js";

/**
 * The call analyzer (Walt 11/12: "analyze each of their calls ... find what they are doing that typically works and
 * what they are doing that typically fails"). The after-call reviews already hold, for every call the app read, who
 * answered, what happened, the tap, and a coaching line; the events table says what each company did afterwards. The
 * analyzer gathers a month of those for one rep, counts what followed what, and has the model write the two lists
 * with the reps' own moments as quotes. Rebuilt once a day per rep, or on demand.
 */
const DAY_MS = 24 * 3600 * 1000;

export type CallFact = {
  id: string; callId: string | null; leadId: string; company: string; at: string; day: string;
  seconds: number; outcome: string; label: string | null; with: string | null; summary: string | null;
  nice: string | null; next: string | null; namesProposed: number;
  /** What the company did after this call: the rungs it reached, from the events table. */
  after: { named: boolean; card: boolean; reached: boolean; rfq: boolean };
};

const WON = (f: CallFact) => f.after.rfq || f.after.reached || f.after.named;

export function callFacts(items: QueueItem[], events: RungEvent[], tz: string): CallFact[] {
  const byLead = new Map<string, RungEvent[]>();
  for (const e of events) if (e.leadId) byLead.set(e.leadId, [...(byLead.get(e.leadId) ?? []), e]);
  return items
    .filter((it) => it.callId && (it.duration ?? 0) >= 45 && !["discarded", "failed"].includes(it.state))
    .map((it) => {
      const later = (byLead.get(it.leadId) ?? []).filter((e) => e.at >= it.createdAt && e.at <= new Date(Date.parse(it.createdAt) + 14 * DAY_MS).toISOString());
      const has = (k: RungEvent["kind"]) => later.some((e) => e.kind === k);
      return {
        id: it.id, callId: it.callId, leadId: it.leadId, company: it.company, at: it.createdAt, day: localDay(tz, new Date(it.createdAt)).day,
        seconds: it.duration ?? 0, outcome: it.outcome, label: it.outcomeLabel, with: it.callWith, summary: it.summary,
        nice: it.coaching?.nice ?? null, next: it.coaching?.next ?? null, namesProposed: it.proposals?.contacts?.length ?? 0,
        after: { named: has("named"), card: has("card"), reached: has("reached"), rfq: has("rfq") },
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export type CallStats = {
  conversations: number; days: number; medianSeconds: number;
  after: { named: number; card: number; reached: number; rfq: number };
  byOutcome: Array<{ outcome: string; label: string; n: number; won: number }>;
  byWho: Array<{ who: "buyer" | "front desk" | "someone"; n: number; won: number }>;
  byLength: Array<{ band: string; n: number; won: number }>;
};
const FRONT = /main office|front desk|reception|office|gatekeeper|assistant|answering/i;
const BUYER = /purchas|buyer|procure|owner|president|manager|estimat|sourcing|supply/i;
export function callStats(facts: CallFact[]): CallStats {
  const secs = facts.map((f) => f.seconds).sort((a, b) => a - b);
  const group = <K extends string>(key: (f: CallFact) => K, labelOf: (k: K, f: CallFact) => string) => {
    const m = new Map<K, { label: string; n: number; won: number }>();
    for (const f of facts) { const k = key(f); const g = m.get(k) ?? { label: labelOf(k, f), n: 0, won: 0 }; g.n++; if (WON(f)) g.won++; m.set(k, g); }
    return [...m].map(([k, g]) => ({ key: k, ...g })).sort((a, b) => b.n - a.n);
  };
  const who = (f: CallFact): "buyer" | "front desk" | "someone" => {
    const w = `${f.with ?? ""} ${f.label ?? ""}`;
    return BUYER.test(w) ? "buyer" : FRONT.test(w) || !f.with ? "front desk" : "someone";
  };
  const band = (s: number) => (s < 90 ? "under 1:30" : s < 180 ? "1:30 to 3:00" : s < 360 ? "3 to 6 min" : "over 6 min");
  return {
    conversations: facts.length, days: new Set(facts.map((f) => f.day)).size,
    medianSeconds: secs.length ? secs[Math.floor(secs.length / 2)] : 0,
    after: { named: facts.filter((f) => f.after.named).length, card: facts.filter((f) => f.after.card).length, reached: facts.filter((f) => f.after.reached).length, rfq: facts.filter((f) => f.after.rfq).length },
    byOutcome: group((f) => f.outcome, (k, f) => f.label ?? k).map((g) => ({ outcome: g.key, label: g.label, n: g.n, won: g.won })),
    byWho: group(who, (k) => k).map((g) => ({ who: g.key, n: g.n, won: g.won })),
    byLength: group((f) => band(f.seconds), (k) => k).map((g) => ({ band: g.key, n: g.n, won: g.won })),
  };
}

const SynthesisSchema = z.object({
  works: z.array(z.object({
    pattern: z.string().describe("What the rep does that tends to end in a name, a card to the buyer, a real conversation or an RFQ: one plain sentence, in the second person. At most five patterns in all."),
    why: z.string().describe("Why it works, one sentence, from the calls themselves"),
    quotes: z.array(z.string()).describe("The rep's own words from those calls, verbatim from the summaries or coaching, one to three"),
  })),
  fails: z.array(z.object({
    pattern: z.string().describe("What the rep does that tends to end in nothing: one plain sentence, in the second person"),
    why: z.string().describe("Why it fails, one sentence, from the calls"),
    quotes: z.array(z.string()).describe("The moments, verbatim from the summaries or coaching, 1 to 3"),
    instead: z.string().describe("What to do instead, one sentence they could use on the next call"),
  })),
  one_change: z.string().describe("The single change that would turn the most calls, one sentence"),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

export type CallAnalysis = { rep: { email: string; name: string }; since: string; at: string; stats: CallStats; synthesis: Synthesis | null; synthesisError: string | null; calls: CallFact[] };

const line = (f: CallFact) => {
  const after = Object.entries(f.after).filter(([, v]) => v).map(([k]) => k).join(",") || "nothing";
  return `[${f.day} ${Math.round(f.seconds / 60)}m ${f.company} | with: ${f.with ?? "?"} | tap: ${f.label ?? f.outcome} | after: ${after}]\n  summary: ${f.summary ?? ""}\n  did well: ${f.nice ?? ""}\n  next time: ${f.next ?? ""}`;
};

export async function analyzeCalls(d: Deps, opts: { days?: number; fresh?: boolean } = {}): Promise<CallAnalysis> {
  const repId = d.rep.closeUserId;
  const now = d.now?.() ?? new Date();
  const day = localDay(d.rep.timeZone, now).day;
  const key = `callAnalysis:${day}`;
  const saved = opts.fresh ? null : await store.getSetting<CallAnalysis>(repId, key).catch(() => null);
  if (saved) return saved;
  const days = opts.days ?? 30;
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const [items, events] = await Promise.all([
    store.listReviews<QueueItem>(repId, since).catch(() => [] as QueueItem[]),
    store.listRungEvents(repId, { sinceDay: since.slice(0, 10) }).catch(() => [] as RungEvent[]),
  ]);
  const calls = callFacts(items, events, d.rep.timeZone);
  const stats = callStats(calls);
  let synthesis: Synthesis | null = null, synthesisError: string | null = null;
  if (calls.length >= 5) {
    const sample = [...calls.filter(WON).slice(0, 30), ...calls.filter((f) => !WON(f)).slice(0, 40)];
    const context = `Rep: ${d.rep.name}. ${calls.length} conversations of 45 seconds or more in the last ${days} days; ${stats.after.named} were followed by a buyer named, ${stats.after.card} by a card to the buyer, ${stats.after.reached} by a real conversation with the buyer, ${stats.after.rfq} by an RFQ.\n\nThe calls (newest first; "after" is what the company did in the two weeks following):\n\n${sample.map(line).join("\n\n")}`;
    const task = "You are coaching one BDR at an industrial PVF supplier (pipe, valves, fittings, flanges, structural steel). The job on a call is: get the buyer's name and email, get the line card to the buyer, reach the buyer, and get an RFQ (the last one they sent out, a quote they got, a PO, or three items). From these calls, find what this rep does that typically works and what typically fails. Patterns, not single calls: name a pattern only when it shows up in several calls. Quote the rep's or prospect's actual words from the summaries and coaching lines; never invent a quote. Plain words, second person, no jargon, no praise padding. Then the one change that would turn the most calls.";
    try { synthesis = (await d.llm({ schema: SynthesisSchema, effort: config.effortEmail, model: config.briefModel, context, task })).data; }
    catch (err) { synthesisError = (err as Error).message; }
  } else synthesisError = calls.length ? `Only ${calls.length} conversations in the last ${days} days; the patterns need a few more.` : "No conversations read in this window.";
  const out: CallAnalysis = { rep: { email: d.rep.email.toLowerCase(), name: d.rep.name }, since, at: now.toISOString(), stats, synthesis, synthesisError, calls: calls.slice(0, 60) };
  if (synthesis) await store.putSetting(repId, key, out).catch(() => undefined);
  return out;
}
