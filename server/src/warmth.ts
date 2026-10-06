import type { Account } from "./accounts.js";

/**
 * How warm a lead is before an RFQ (Walt 10/5): a score built from what Close already knows, not a field anyone fills in.
 * Points for every sign they're paying attention; the total fades when nothing happens for a while.
 */
export type Warmth = { score: number; bucket: "hot" | "warm" | "cool" | "cold"; why: string[]; lastSignal: string | null };

/** Nothing for this many days before the score starts fading. */
export const FADE_AFTER_DAYS = 7;
/** Once fading, the score halves every this many days. */
export const HALF_LIFE_DAYS = 14;
export const HOT_AT = 7;
export const WARM_AT = 4;
export const COOL_AT = 2;

const DAY = 86_400_000;
/** A mailbox, not a person: info@, accounting@, "Main". */
const GENERIC = /^(info|sales|accounting|accounts|ap|ar|office|main|admin|purchasing|contact|hello|support|front ?desk|billing|estimating|reception|general|service ?sales|orders|shop)$/i;

export function warmthFor(a: Pick<Account, "seen" | "opens" | "events" | "touches" | "contact" | "rfqPromised" | "cardSentAt">, now = new Date()): Warmth {
  const why: string[] = [];
  let score = 0;
  const add = (pts: number, text: string) => { score += pts; why.push(`${pts > 0 ? "+" : ""}${pts} ${text}`); };
  const signals: string[] = [];

  if (a.seen === "bounced") add(-3, "bounced or blocked: they never got it");

  if (a.opens.person > 0) {
    add(Math.min(a.opens.person, 3), a.opens.person === 1 ? "opened the line card" : `opened it ${a.opens.person}×`);
    if (a.opens.last) signals.push(a.opens.last);
  } else if (a.opens.maybe > 0) {
    add(0.5, "maybe opened (can't tell if it was a person)");
  }

  const replies = a.events.filter((e) => e.kind === "reply");
  if (replies.length) {
    add(3 + Math.min(replies.length - 1, 2), replies.length === 1 ? "wrote back" : `wrote back ${replies.length}×`);
    signals.push(replies[0].at);
  }

  if (a.touches.talked > 0) {
    // The first talk is usually the intro call that got us their email: table stakes. Picking up again is the signal.
    add(1, "talked on the phone");
    if (a.touches.talked > 1) add(Math.min((a.touches.talked - 1) * 1.5, 3), `picked up again ${a.touches.talked - 1}×`);
    if (a.touches.lastTalk) signals.push(a.touches.lastTalk);
    // A real conversation, not a brush-off: the longest connected call, 3 minutes or more.
    const mins = a.events.filter((e) => e.kind === "call").map((e) => Number(/connected \((\d+) min\)/.exec(e.text)?.[1] ?? 0));
    const longest = Math.max(0, ...mins);
    if (longest >= 5) add(2, `a real conversation (${longest} min)`);
    else if (longest >= 3) add(1, `a real conversation (${longest} min)`);
  }

  const first = (a.contact.name ?? "").split(/\s+/)[0] ?? "";
  // A person's name, not a mailbox or a login (jtrapp, bbelk): only a first name with a capital letter counts.
  if (first && !GENERIC.test(first) && !/@/.test(first) && /^[A-Z][a-z]/.test(first)) add(0.5, `a named buyer (${first})`);

  if (a.rfqPromised) add(5, "promised an RFQ");

  // A note is a sign of life only when it's about them (a call note), not one of our own tags.
  for (const n of a.events.filter((e) => e.kind === "note" && !/^\[(RFQ potential|Purchasing|RFQ status)\]/.test(e.text))) signals.push(n.at);

  const lastSignal = signals.sort().pop() ?? null;
  const quiet = lastSignal ? (now.getTime() - new Date(lastSignal).getTime()) / DAY : (now.getTime() - new Date(a.cardSentAt).getTime()) / DAY;
  if (score > 0 && quiet > FADE_AFTER_DAYS) {
    const faded = score * Math.pow(0.5, (quiet - FADE_AFTER_DAYS) / HALF_LIFE_DAYS);
    if (score - faded >= 0.1) why.push(`fades: nothing for ${Math.round(quiet)} days (${score.toFixed(1)} → ${faded.toFixed(1)})`);
    score = faded;
  }

  score = Math.round(score * 10) / 10;
  const bucket = score >= HOT_AT ? "hot" : score >= WARM_AT ? "warm" : score >= COOL_AT ? "cool" : "cold";
  return { score, bucket, why, lastSignal };
}
