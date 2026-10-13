import type { Tier } from "./potential.js";

/**
 * The email sequence (Walt 10/12). A bump only works on the day an RFQ is sitting on the buyer's desk, so the job is
 * to be on top of their inbox often enough to catch that day without wearing the account out, and to hand the
 * account to a call when email alone isn't getting anywhere.
 *
 * Two ways in:
 *  - talked: you reached the buyer. Line card, then 3 emails (next morning, +3, +5 business days), then a call flag.
 *  - cold: the front desk gave you the email, or you asked for it instead of leaving a voicemail. Line card, then 2
 *    emails (+2, +5), then a call flag: call the main line and ask for them by name.
 * After that the emails keep going at the account's rhythm, set by how often they buy, until you connect. A real
 * conversation starts the next round from the top. Six emails since the last conversation with no reply and no
 * click: once a month, never zero.
 *
 * Gaps are business days since the last email of ours on the account. Counts are emails since the last real
 * conversation (a round), not ever.
 */
export type Track = "talked" | "cold";
export type Phase = "intro" | "rhythm" | "monthly";
export type Cadence = {
  track: Track; round: number; phase: Phase;
  /** Automatic emails since the last real conversation. */
  nth: number;
  /** Business days to wait after the last email. */
  gap: number;
  /** The intro is done and there's been no conversation since: the app flags a call. */
  callFlag: boolean;
  why: string;
};

export const GENERIC = /^(info|sales|accounting|accounts|ap|ar|office|main|admin|purchasing|contact|hello|support|front ?desk|billing|estimating|estimator|reception|general|service ?sales|orders|shop|quotes?|bids?|inquiries|mail|team|dispatch)$/i;
/** A mailbox nobody owns: the part before the @ is a department word. */
export const isGenericAddress = (email: string | null | undefined) => !!email && GENERIC.test(email.split("@")[0].replace(/[^a-z ]/gi, ""));

export const INTRO_GAPS: Record<Track, readonly number[]> = { talked: [1, 3, 5], cold: [2, 5] };
export const RHYTHM_GAPS: Record<Tier, number> = { steady: 3, project: 5, occasional: 15, unknown: 5 };
/** A shared mailbox, or someone you've never talked to: weekly at most. */
export const SLOW_MIN_GAP = 5;
export const QUIET_AFTER = 6;
export const MONTHLY_GAP = 20;
/** A click on the line card or the site: no email for this long, it's a call. */
export const CLICK_HOLD_DAYS = 3;

const TIER_WORDS: Record<Tier, string> = {
  steady: "they get several RFQs a week", project: "they buy by the project", occasional: "they only buy a few times a year", unknown: "we don't know how often they buy yet",
};

export function cadenceFor(x: { track: Track; round: number; nth: number; tier?: Tier | null; generic?: boolean; heardBack?: boolean }): Cadence {
  const { track, round, nth } = x;
  const intro = INTRO_GAPS[track];
  const base = { track, round, nth };
  if (nth < intro.length) {
    const gap = intro[nth];
    return { ...base, phase: "intro", gap, callFlag: false, why: `${track === "cold" ? "Cold" : `Round ${round}`} intro, email ${nth + 1} of ${intro.length}: ${gap} business day${gap === 1 ? "" : "s"} after the last one.` };
  }
  if (nth >= QUIET_AFTER && !x.heardBack) {
    return { ...base, phase: "monthly", gap: MONTHLY_GAP, callFlag: true, why: `${nth} emails since you last talked and nothing back: once a month until you connect.` };
  }
  const tier: Tier = x.tier ?? "unknown";
  let gap = RHYTHM_GAPS[tier];
  let why = `Every ${gap} business days: ${TIER_WORDS[tier]}.`;
  if ((x.generic || track === "cold") && gap < SLOW_MIN_GAP) {
    gap = SLOW_MIN_GAP;
    why = `Every ${gap} business days: ${x.generic ? "a shared mailbox" : "you haven't talked to them yet"}, so weekly at most.`;
  }
  return { ...base, phase: "rhythm", gap, callFlag: true, why: `${why} Call to start the next round.` };
}
