import { randomUUID } from "node:crypto";
import type { Tier } from "./potential.js";
import { SequenceSchema } from "./schemas.js";
import { store } from "./store.js";

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
 *
 * Since 11/9 the sequence is a record each rep can edit from the Automatic emails tab (the builder): the steps,
 * their gaps and the one sentence each carries, the rhythm by tier, when it goes monthly, and the click hold.
 * `DEFAULT_SEQUENCE` is the sequence as it was in code; a rep with nothing saved runs it.
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

/** One intro email: how long after the last email it goes, and the sentence in it. */
export type Step = { gap: number; line: string };
export type TrackPlan = {
  steps: Step[];
  /** Once the intro is done, the emails rotate through these lines. */
  after: string[];
};
/** The part of every email around the line. `{name}` is the buyer's first name (or "there"), `{url}` the link. */
export type Wrap = { greeting: string; cardLine: string; siteLine: string; signoff: string };
/** When they go out, their time, in minutes from midnight: a random minute in the window; Mondays have their own. */
export type SendWindow = { from: number; to: number; mondayFrom: number; mondayTo: number };
export type Sequence = {
  /** The version's name, stamped on every email it sends, so the scoreboard can compare versions. */
  name: string;
  talked: TrackPlan;
  cold: TrackPlan;
  rhythm: {
    /** Business days between emails once the intro is done, by how often they buy. */
    gaps: Record<Tier, number>;
    /** A shared mailbox, or someone you've never talked to: at least this many days apart. */
    slowMinGap: number;
  };
  /** After this many emails since the last conversation with nothing back, one every `gap` business days. */
  monthly: { after: number; gap: number };
  /** A click on the line card or the site: no email for this long, it's a call. */
  clickHoldDays: number;
  wrap: Wrap;
  send: SendWindow;
};

export const GENERIC = /^(info|sales|accounting|accounts|ap|ar|office|main|admin|purchasing|contact|hello|support|front ?desk|billing|estimating|estimator|reception|general|service ?sales|orders|shop|quotes?|bids?|inquiries|mail|team|dispatch)$/i;
/** A mailbox nobody owns: the part before the @ is a department word. */
export const isGenericAddress = (email: string | null | undefined) => !!email && GENERIC.test(email.split("@")[0].replace(/[^a-z ]/gi, ""));

// The lines (Walt 10/12): eager salesman, full sentences like Walt typed them, and every one ends in the same plain
// ask. Nothing self-aware about how many emails they've had.
export const ASK = "Please send me over an RFQ and we'll get you a quote back.";
export const HOPE_WEEK = `I hope your week's going good! ${ASK}`;
/** The first talked email: `{when}` becomes "yesterday" or "the other day" when it goes out. */
export const GREAT_TALKING = `It was great talking to you {when}! ${ASK}`;
const BENCHMARK = "I have a quick ask for you. Send me the last RFQ you sent out, even if it's already been bought, and we'll quote it so you can see where we land.";
export const RHYTHM_LINES = [
  `I wanted to get back in front of you so I'm on top of the pile the day one comes across your desk. Please send it over and we'll get you a quote back.`,
  `I'm bumping this back up for you. If you have an RFQ going out this week, please send it over and we'll get you a quote back.`,
  HOPE_WEEK,
];
const COLD_LINES = [
  `I wanted to bump this back up in case it got buried. ${ASK}`,
  `I'm checking in on this one more time. ${ASK}`,
];

export const DEFAULT_WRAP: Wrap = {
  greeting: "Hi {name}!",
  // Said in every bump (10/6): the PDF rides along each time, and the hosted copy is one click away.
  cardLine: "Line card's attached too, or you can grab it here: {url}",
  // Someone you haven't talked to gets the site too (Walt 10/12): a click tells us the address works.
  siteLine: "Our site is here if that's easier: {url}",
  signoff: "Thanks,",
};
// Around their 8am (Walt 10/8), a random minute so a wave isn't a block; Monday morning is a pile of mail (10/12),
// so Monday's go out after 10.
export const DEFAULT_SEND: SendWindow = { from: 7 * 60 + 50, to: 8 * 60 + 35, mondayFrom: 10 * 60, mondayTo: 10 * 60 + 45 };
export const DEFAULT_SEQUENCE: Sequence = {
  name: "Standard",
  talked: { steps: [{ gap: 1, line: GREAT_TALKING }, { gap: 3, line: BENCHMARK }, { gap: 5, line: HOPE_WEEK }], after: RHYTHM_LINES },
  cold: { steps: [{ gap: 2, line: COLD_LINES[0] }, { gap: 5, line: COLD_LINES[1] }], after: [HOPE_WEEK, ...COLD_LINES] },
  rhythm: { gaps: { steady: 3, project: 5, occasional: 15, unknown: 5 }, slowMinGap: 5 },
  monthly: { after: 6, gap: 20 },
  clickHoldDays: 3,
  wrap: DEFAULT_WRAP,
  send: DEFAULT_SEND,
};
/** A deep copy, so an edit never touches the default. */

// The old constants, now the default's numbers: nothing that reads them changes.
export const INTRO_GAPS: Record<Track, readonly number[]> = { talked: DEFAULT_SEQUENCE.talked.steps.map((s) => s.gap), cold: DEFAULT_SEQUENCE.cold.steps.map((s) => s.gap) };
export const RHYTHM_GAPS: Record<Tier, number> = DEFAULT_SEQUENCE.rhythm.gaps;
export const SLOW_MIN_GAP = DEFAULT_SEQUENCE.rhythm.slowMinGap;
export const QUIET_AFTER = DEFAULT_SEQUENCE.monthly.after;
export const MONTHLY_GAP = DEFAULT_SEQUENCE.monthly.gap;
export const CLICK_HOLD_DAYS = DEFAULT_SEQUENCE.clickHoldDays;

/** The rep's sequence: what they saved in the builder, or the default. Anything saved that no longer parses runs the default. */
export const cloneSequence = (s: Sequence): Sequence => JSON.parse(JSON.stringify(s)) as Sequence;
export const isDefaultSequence = (s: Sequence) => JSON.stringify(s) === JSON.stringify(DEFAULT_SEQUENCE);

// Several sequences a rep, one live (Walt 11/10: "more of a campaign builder"). Saved as one setting, "campaigns";
// the built-in Standard is never stored and is live when nothing else is. The builder's earlier single "sequence"
// setting (11/9) becomes the first saved one, live, the first time the book is read.
export type Campaign = Sequence & { id: string; createdAt: string; updatedAt: string };
/** `enrolled` (Walt 11/10): companies put on a sequence by hand, lead id → sequence id. Everyone else follows the live one. */
export type CampaignBook = { campaigns: Campaign[]; liveId: string | null; enrolled?: Record<string, string> };
export const STANDARD_ID = "standard";
const BOOK_KEY = "campaigns";
export const standardCampaign = (): Campaign => ({ ...cloneSequence(DEFAULT_SEQUENCE), id: STANDARD_ID, createdAt: "", updatedAt: "" });
const parses = (c: unknown): c is Campaign => !!c && typeof c === "object" && typeof (c as Campaign).id === "string" && SequenceSchema.safeParse(c).success;
export async function campaignBook(repId: string): Promise<CampaignBook> {
  const saved = await store.getSetting<CampaignBook>(repId, BOOK_KEY).catch(() => null);
  if (saved && Array.isArray(saved.campaigns)) {
    const campaigns = saved.campaigns.filter(parses);
    if (campaigns.length < saved.campaigns.length) console.warn(`[sequence] ${repId}: a saved sequence doesn't parse; skipping it`);
    const enrolled = saved.enrolled && typeof saved.enrolled === "object" ? saved.enrolled : {};
    return { campaigns, liveId: typeof saved.liveId === "string" ? saved.liveId : null, enrolled };
  }
  const old = await store.getSetting<unknown>(repId, "sequence").catch(() => null);
  const r = old ? SequenceSchema.safeParse(old) : null;
  if (!r || !r.success) return { campaigns: [], liveId: null };
  const at = new Date().toISOString();
  const first: Campaign = { ...r.data, id: randomUUID(), createdAt: at, updatedAt: at };
  const book: CampaignBook = { campaigns: [first], liveId: first.id };
  await store.putSetting(repId, BOOK_KEY, book).catch(() => undefined);
  return book;
}
export async function saveBook(repId: string, book: CampaignBook) {
  await store.putSetting(repId, BOOK_KEY, book);
}
export async function liveCampaign(repId: string): Promise<Campaign> {
  const book = await campaignBook(repId);
  return book.campaigns.find((c) => c.id === book.liveId) ?? standardCampaign();
}
/**
 * Which sequence each company follows (Walt 11/10: "the non-original one has companies manually selected in, otherwise
 * people may be enrolled in both"): the live one for everyone, except a company put on another sequence by hand, which
 * follows that one and nothing else. Read the book once, then ask per lead.
 */
export async function sequencePicker(repId: string): Promise<{ live: Sequence; of: (leadId: string) => Sequence; book: CampaignBook }> {
  const book = await campaignBook(repId);
  const asSeq = (c: Campaign): Sequence => (c.id === STANDARD_ID ? DEFAULT_SEQUENCE : c);
  const live = asSeq(book.campaigns.find((c) => c.id === book.liveId) ?? standardCampaign());
  const byId = new Map<string, Sequence>([[STANDARD_ID, DEFAULT_SEQUENCE], ...book.campaigns.map((c) => [c.id, asSeq(c)] as const)]);
  const enrolled = book.enrolled ?? {};
  return { live, book, of: (leadId) => (leadId in enrolled ? byId.get(enrolled[leadId]) ?? live : live) };
}
/** The live sequence: what the board, the morning plan and every bump read. With a lead: the one that company follows. */
export async function sequenceFor(repId: string, leadId?: string): Promise<Sequence> {
  if (leadId) return (await sequencePicker(repId)).of(leadId);
  const c = await liveCampaign(repId);
  if (c.id === STANDARD_ID) return DEFAULT_SEQUENCE;
  return SequenceSchema.parse(c);
}

export const TIER_WORDS: Record<Tier, string> = {
  steady: "they get several RFQs a week", project: "they buy by the project", occasional: "they only buy a few times a year", unknown: "we don't know how often they buy yet",
};

export function cadenceFor(x: { track: Track; round: number; nth: number; tier?: Tier | null; generic?: boolean; heardBack?: boolean }, seq: Sequence = DEFAULT_SEQUENCE): Cadence {
  const { track, round, nth } = x;
  const intro = seq[track].steps;
  const base = { track, round, nth };
  if (nth < intro.length) {
    const gap = intro[nth].gap;
    return { ...base, phase: "intro", gap, callFlag: false, why: `${track === "cold" ? "Cold" : `Round ${round}`} intro, email ${nth + 1} of ${intro.length}: ${gap} business day${gap === 1 ? "" : "s"} after the last one.` };
  }
  if (nth >= seq.monthly.after && !x.heardBack) {
    const gap = seq.monthly.gap;
    return { ...base, phase: "monthly", gap, callFlag: true, why: `${nth} emails since you last talked and nothing back: ${gap === 20 ? "once a month" : `every ${gap} business days`} until you connect.` };
  }
  const tier: Tier = x.tier ?? "unknown";
  let gap = seq.rhythm.gaps[tier];
  let why = `Every ${gap} business days: ${TIER_WORDS[tier]}.`;
  if ((x.generic || track === "cold") && gap < seq.rhythm.slowMinGap) {
    gap = seq.rhythm.slowMinGap;
    why = `Every ${gap} business days: ${x.generic ? "a shared mailbox" : "you haven't talked to them yet"}, so ${gap === 5 ? "weekly" : `every ${gap} days`} at most.`;
  }
  return { ...base, phase: "rhythm", gap, callFlag: true, why: `${why} Call to start the next round.` };
}
