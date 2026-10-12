import type { Account } from "./accounts.js";

/**
 * How likely a lead is to send an RFQ soon, and whether to call them now (Walt 10/12: "the heat map is kind of
 * useless and not taking in the necessary variables"). Built from what Close already knows, no AI.
 *
 *  - Every signal fades on its own (half-life 10 days), so last week's reply beats last month's.
 *  - Replies are read for what they say: a question or "RFQ to follow" is hot; "nothing yet" is a pause; "not
 *    interested" or "fewer emails" takes them off the map.
 *  - Opens count by distinct day (Outlook's preview pane re-opens the same email dozens of times), plus a bonus for
 *    opening your latest email within two days.
 *  - Calls count by length: a short connect is usually the front desk.
 *  - The account's RFQ potential (how much they buy) scales the score.
 *  - Paused accounts (cooling, snoozed until a date, bounced, out) are off the call bands, with the reason and the
 *    date they come back.
 */
export type Paused = { kind: "cooling" | "later" | "not_now" | "bounced" | "no_emails" | "out"; until: string | null; why: string };
export type Warmth = { score: number; bucket: "hot" | "warm" | "cool" | "cold"; why: string[]; lastSignal: string | null; paused: Paused | null };

export const HALF_LIFE_DAYS = 10;
export const HOT_AT = 6;
export const WARM_AT = 3;
export const COOL_AT = 1;
/** "Nothing yet" pauses them this long (the reply cool-down, 10/12). */
export const NOT_NOW_DAYS = 10.5;
const DAY = 86_400_000;
const GENERIC = /^(info|sales|accounting|accounts|ap|ar|office|main|admin|purchasing|contact|hello|support|front ?desk|billing|estimating|reception|general|service ?sales|orders|shop)$/i;

export type ReplyKind = "out" | "no_emails" | "engaged" | "promise" | "not_now" | "later" | "ack" | "other";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** What a reply says, from their own words (above the quoted thread). `until` for "not until [month]" replies. */
export function classifyReply(text: string, at: string): { kind: ReplyKind; until: string | null } {
  const t = (text ?? "").toLowerCase().replace(/[’]/g, "'");
  // No more email reminders (Tammy at SBI 10/12: "I do not need weekly reminders to send RFQ's. I will reach out if
  // needed"): never another automatic email. Still a customer to call, so not a no.
  if (/(don't|do not|no) need (the |any |weekly |more |these |your )*(reminders|follow.?ups|emails)|stop (the |these |your )?(reminders|emails|follow.?ups)|no more (emails|reminders)|(please )?(don't|do not) (email|send) (me|us)/.test(t)) return { kind: "no_emails", until: null };
  // "Fewer emails, please" isn't a no: back in a month (CTI 10/8: "monthly at most").
  if (/reduce (the )?frequency|fewer (emails|messages)|too many (emails|messages)|(monthly|quarterly) at most|less often/.test(t)) return { kind: "later", until: new Date(Date.parse(at) + 30 * DAY).toISOString() };
  if (/(not|n't) interested|no interest|remove (me|us)|unsubscribe|stop (emailing|sending)|take (me|us) off|do not (email|contact)|don't (email|contact)|(not|n't) (looking to |interested in )?(moving|switching|changing) (suppliers|vendors)|no longer (need|buy)|we don't (buy|use) (that|those|this)|don't purchase/.test(t)) return { kind: "out", until: null };
  // A month named as the time to come back: "mid November", "after the first of the year", "next month".
  // A month only counts right after a time word ("mid November", "until March", "in January"): "may" alone is the
  // verb (10/12: "what you may need" read as May and paused five live customers).
  const month = MONTHS.findIndex((m) => new RegExp(`\\b(mid|mid-|late|early|end of|until|after|in|around|by|before|this|next)\\s+${m}\\b`).test(t));
  if (month >= 0) {
    const now = new Date(at);
    let y = now.getUTCFullYear();
    if (month < now.getUTCMonth()) y++;
    const day = /\b(mid)\b/.test(t) ? 10 : /\b(late|end of)\b/.test(t) ? 20 : 1;
    return { kind: "later", until: new Date(Date.UTC(y, month, day, 15)).toISOString() };
  }
  if (/first of the year|next year|after the holidays|january/.test(t)) {
    const y = new Date(at).getUTCFullYear() + 1;
    return { kind: "later", until: new Date(Date.UTC(y, 0, 5, 15)).toISOString() };
  }
  if (/next month/.test(t)) return { kind: "later", until: new Date(Date.parse(at) + 30 * DAY).toISOString() };
  if (/rfq to follow|will send (it|you|the|an? )|i'll send|sending (it|you|over)|send(ing)? (it )?(over )?(this|next) week|have (one|an rfq|something) (coming|for you)/.test(t)) return { kind: "promise", until: null };
  if (/\?|please (send|quote|provide)|can you (send|quote|get|help)|could you (send|quote)|set (you|westgate) up|vendor (form|setup|packet|application)|w-?9|trade references|quote (price|this|these|for)|price and lead.?time/.test(t)) return { kind: "engaged", until: null };
  if (/nothing (yet|right now|at the moment|currently|now)|not (right )?now|no(t)? (rfqs?|needs?|projects?) (right now|at the moment|currently|yet)|don't have (a need|anything|any)|keep you in mind|reach out (when|if)|(pretty|well) covered|all set|we're good|we are good|will let you know|when (something|anything) comes up/.test(t)) return { kind: "not_now", until: null };
  if (/got it|received|thanks|thank you|appreciate/.test(t)) return { kind: "ack", until: null };
  return { kind: "other", until: null };
}

type In = Pick<Account, "seen" | "opens" | "events" | "touches" | "contact" | "rfqPromised" | "cardSentAt"> & {
  potential?: { tier?: string } | null;
  /** Their replies, own words, newest last. */
  replyNotes?: Array<{ at: string; text: string }>;
  /** Distinct days a person opened our emails (ISO dates). */
  openDays?: string[];
  lastOutAt?: string | null;
  lastOpenAt?: string | null;
  cooling?: { until: string | null; why: string | null } | null;
};

const TIER_X: Record<string, number> = { steady: 1.3, project: 1.15, occasional: 1, unknown: 0.9 };

export function warmthFor(a: In, now = new Date()): Warmth {
  const why: string[] = [];
  const fade = (at: string | null | undefined, half = HALF_LIFE_DAYS) => (at ? Math.pow(0.5, Math.max(0, (now.getTime() - Date.parse(at)) / DAY) / half) : 1);
  let score = 0;
  const add = (pts: number, text: string, at?: string | null, half?: number) => {
    const p = Math.round(pts * fade(at, half) * 10) / 10;
    if (Math.abs(p) < 0.05) return;
    score += p;
    why.push(`${p > 0 ? "+" : ""}${p} ${text}${at && fade(at, half) < 0.95 ? ` (${Math.round((now.getTime() - Date.parse(at)) / DAY)}d ago)` : ""}`);
  };
  const signals: string[] = [];
  let paused: Paused | null = null;
  const pause = (p: Paused) => { if (!paused || p.kind === "out") paused = p; };

  // Their replies, read for what they say. The newest one sets any pause.
  const replies = a.replyNotes ?? [];
  for (const r of replies) {
    const c = classifyReply(r.text, r.at);
    signals.push(r.at);
    const said = r.text.replace(/\s+/g, " ").trim().slice(0, 60);
    if (c.kind === "engaged") add(6, `asked or asked for something ("${said}")`, r.at);
    else if (c.kind === "promise") add(5, `said an RFQ is coming ("${said}")`, r.at, 21);
    else if (c.kind === "ack") add(2, `wrote back ("${said}")`, r.at);
    else if (c.kind === "other") add(2, `wrote back ("${said}")`, r.at);
    else if (c.kind === "not_now") add(0.5, `"${said}"`, r.at);
  }
  const newest = replies.length ? replies[replies.length - 1] : null;
  if (newest) {
    const c = classifyReply(newest.text, newest.at);
    const said = newest.text.replace(/\s+/g, " ").trim().slice(0, 80);
    if (c.kind === "out") pause({ kind: "out", until: null, why: `They said: "${said}"` });
    else if (c.kind === "no_emails") pause({ kind: "no_emails", until: new Date(Date.parse(newest.at) + 30 * DAY).toISOString(), why: `No more automatic emails. They said: "${said}"` });
    else if (c.kind === "later" && c.until && c.until > now.toISOString()) pause({ kind: "later", until: c.until, why: `They said: "${said}"` });
    else if (c.kind === "not_now") {
      const until = new Date(Date.parse(newest.at) + NOT_NOW_DAYS * DAY).toISOString();
      if (until > now.toISOString()) pause({ kind: "not_now", until, why: `They said: "${said}"` });
    }
  }

  // Opens, by distinct day: one person reading it on three days says more than 32 preview-pane opens in one.
  const days = a.openDays ?? [];
  if (days.length) {
    for (const [i, day] of days.slice(0, 4).entries()) add(1, i === 0 ? "opened our email" : "opened it again another day", day);
    signals.push(days[0]);
  } else if (a.opens.maybe > 0) add(0.5, "maybe opened (can't tell if it was a person)");
  if (a.lastOpenAt && a.lastOutAt && a.lastOpenAt > a.lastOutAt && Date.parse(a.lastOpenAt) - Date.parse(a.lastOutAt) < 2 * DAY) add(1.5, "opened your latest email within 2 days", a.lastOpenAt);

  // Calls, by length: two minutes or more is likely the buyer; a short connect is usually the front desk.
  for (const e of a.events.filter((x) => x.kind === "call")) {
    const m = /connected \((\d+)\s*(min|s)\)/.exec(e.text);
    if (!m) continue;
    const secs = Number(m[1]) * (m[2] === "min" ? 60 : 1);
    if (secs >= 120) { add(2.5, `a real conversation (${Math.round(secs / 60)} min)`, e.at); signals.push(e.at); }
    else if (secs >= 20) add(0.5, "someone picked up", e.at);
  }

  if (a.rfqPromised) add(5, "promised an RFQ on a call", signals.sort().pop() ?? a.cardSentAt, 21);
  const first = (a.contact.name ?? "").split(/\s+/)[0] ?? "";
  if (first && !GENERIC.test(first) && !/@/.test(first) && /^[A-Z][a-z]/.test(first)) add(0.5, `a named buyer (${first})`);

  // How much they buy scales it.
  const tier = a.potential?.tier ?? "unknown";
  const x = TIER_X[tier] ?? 1;
  if (score > 0 && x !== 1) { why.push(`×${x} ${tier} RFQ potential`); score *= x; }

  // Paused for other reasons: bounced (needs a working email), or cooling off by hand.
  if (a.seen === "bounced") pause({ kind: "bounced", until: null, why: "The line card bounced: get a working email first." });
  if (a.cooling && (!a.cooling.until || a.cooling.until > now.toISOString())) pause({ kind: "cooling", until: a.cooling.until, why: a.cooling.why ? `Cooling off: ${a.cooling.why}` : "Cooling off" });

  score = Math.round(score * 10) / 10;
  const bucket = score >= HOT_AT ? "hot" : score >= WARM_AT ? "warm" : score >= COOL_AT ? "cool" : "cold";
  return { score, bucket, why, lastSignal: signals.sort().pop() ?? null, paused };
}
