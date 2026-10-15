import type { Deps } from "./assistant.js";
import { classifyReply } from "./warmth.js";
import { store } from "./store.js";

/**
 * The heat map, v3 (Walt 10/14: "it's not accurate and doesn't take a lot of shit into consideration"). One question:
 * who is most likely to send an RFQ soon, and why. Built on what buyers said and did, never on how often you dialed:
 *
 *  - a promise to send one (fresh: expect it; a few days on: chase it)
 *  - when they said work is coming ("middle of next week"): up on that day, quiet before it
 *  - a question or a request in a reply, read without the signature
 *  - a click on your email
 *  - "the next one is yours" / "we'll keep you in mind"
 *  - a real conversation with the buyer (your tap, else the call note), fading over a month, not ten days
 *  - "nothing right now": emails only for 10 days, then back to neutral
 *  - a past RFQ you quoted: ask for the next one
 *  - how much they buy breaks ties; opens count only across several days
 *
 * Each account gets a band (call today, this week, emails only, off) and one line in plain words.
 */
export type Band = "today" | "week" | "emails" | "later" | "off";
export type Heat = {
  band: Band;
  /** For ordering inside a band only; never shown. */
  score: number;
  /** One line, plain words: why they're here. */
  reason: string;
  /** Short imperative for the call list: "Chase the RFQ Norma promised Oct 12". */
  headline: string;
  tags: string[];
  /** Who to ask for, if a call or reply named them. */
  who: string | null;
  /** The day they said work is coming, if they did. */
  expected: string | null;
  lastSignal: string | null;
  /** The promise to chase: when, and their words (from the call or the reply), if we have them. */
  promise?: { at: string; quote: string | null } | null;
};

/** What one call said, saved on the account when the after-call step reads it (the queue only keeps 8 days). */
export type CallSignal = {
  at: string; callId: string | null; tapped: string | null; buyer: boolean;
  promised: boolean; nextOne: boolean; softYes: boolean; noneNow: boolean; benchmark: boolean;
  expectedWhen: string | null; who: string | null; summary: string | null;
  /** Their words when they promised it, from the transcript (10/14). "" = looked, didn't find a line. */
  quote?: string | null;
};
const SIGNALS_KEY = "callSignals";
export async function saveCallSignal(d: Deps, leadId: string, sig: CallSignal) {
  const all = (await store.getSetting<Record<string, CallSignal[]>>(d.rep.closeUserId, SIGNALS_KEY).catch(() => null)) ?? {};
  const list = (all[leadId] ?? []).filter((x) => !(sig.callId && x.callId === sig.callId));
  all[leadId] = [...list, sig].sort((a, b) => a.at.localeCompare(b.at)).slice(-12);
  await store.putSetting(d.rep.closeUserId, SIGNALS_KEY, all);
}
export async function loadCallSignals(repId: string): Promise<Record<string, CallSignal[]>> {
  return (await store.getSetting<Record<string, CallSignal[]>>(repId, SIGNALS_KEY).catch(() => null)) ?? {};
}

const DAY = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The calendar day (YYYY-MM-DD, their time) of an ISO instant. */
const dayIn = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const monday = (day: string) => addDays(day, -((weekday(day) + 6) % 7));

/**
 * "middle of next week", "Monday", "end of the month", "after the first of the year" → the day it means, counted from
 * when it was said. Null when it isn't a time we can pin down.
 */
export function whenFromPhrase(phrase: string | null | undefined, saidAt: string, tz: string): string | null {
  if (!phrase) return null;
  const t = phrase.toLowerCase();
  const said = dayIn(saidAt, tz);
  const nextMon = addDays(monday(said), 7);
  if (/\btoday\b|this afternoon|later today/.test(t)) return said;
  if (/\btomorrow\b/.test(t)) return addDays(said, 1);
  if (/(middle|mid)[- ]?(of )?(the )?next week|next week.{0,10}(middle|mid)/.test(t)) return addDays(nextMon, 2);
  if (/end of (the )?next week/.test(t)) return addDays(nextMon, 4);
  if (/end of (the |this )?week/.test(t)) return addDays(monday(said), 4);
  if (/(early|beginning of|start of) next week|next week/.test(t)) return nextMon;
  if (/(middle|mid)[- ]?(of )?(the |this )?week/.test(t)) { const w = addDays(monday(said), 2); return w >= said ? w : addDays(w, 7); }
  for (const [i, d] of WEEKDAYS.entries()) {
    if (!new RegExp(`\\b${d}\\b`).test(t)) continue;
    // The coming one ("Monday" said on a Wednesday is next Monday; said on a Monday, it's a week out).
    return addDays(said, ((i - weekday(said) + 7) % 7) || 7);
  }
  if (/couple (of )?weeks|two weeks|2 weeks/.test(t)) return addDays(said, 14);
  if (/few weeks|three weeks|3 weeks/.test(t)) return addDays(said, 21);
  if (/\ba week\b|one week|1 week/.test(t)) return addDays(said, 7);
  const y = Number(said.slice(0, 4)), m = Number(said.slice(5, 7)) - 1;
  if (/end of (the |this )?month/.test(t)) return new Date(Date.UTC(y, m + 1, 0, 12)).toISOString().slice(0, 10);
  if (/next month|beginning of next month|first of next month/.test(t)) return new Date(Date.UTC(y, m + 1, 1, 12)).toISOString().slice(0, 10);
  if (/first of the year|new year|after the holidays|next year/.test(t)) return `${y + 1}-01-05`;
  for (const [i, mo] of MONTHS.entries()) {
    if (!new RegExp(`\\b${mo}\\b`).test(t)) continue;
    const yy = i < m ? y + 1 : y;
    const dd = /\b(mid|middle)\b/.test(t) ? 10 : /\b(late|end)\b/.test(t) ? 20 : 1;
    return new Date(Date.UTC(yy, i, dd, 12)).toISOString().slice(0, 10);
  }
  return null;
}

/** The buyer's own words in a reply: the signature, phone numbers, images and the quoted thread cut off. */
export function cleanReply(text: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const cut = t.search(/\[cid:|\bcid:|\b(thanks|thank you|regards|best regards|sincerely|cheers)\s*[,!.-]?\s+[A-Z][a-z]+ [A-Z]|\b[A-Z][a-z]+ [A-Z][a-z]+ (purchasing|buyer|procurement|estimator|manager|coordinator|president|owner)\b|\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}|\bwww\.|[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}|\bon (mon|tue|wed|thu|fri|sat|sun)[a-z]*,? .{3,40} wrote:|-{2,} ?original message|\bfrom: /i);
  return (cut > 0 ? t.slice(0, cut) : t).trim();
}

// ---------- reading old call notes (the app has written one after every call since September) ----------
const NOT_A_CALL = /^\s*\[(RFQ received|Cooling|Purchasing|RFQ status)|^Opener:|^\[Said on the call\]/i;
const PROMISE = /\[RFQ promised\]|\b(will|'ll|is going to|plans to|promised to|said (he|she|they)('d| would)) (send|shoot|forward|email|get) (us |you |me |walt |over |him |her )*(an? |the |some )?(rfq|list|quote|takeoff|drawing|po\b|order|bid|something|material)|working on a quote|send (it|something|that|one) over (today|this week|shortly|soon|before)/i;
const NEXT_ONE = /(send|shoot|forward) (us |you |it |rfqs? )*(the next|our way|your way) |when (he|she|they) (has|have|get|gets) (one|something|an rfq|projects?)|keep (us|you|westgate) in mind|reach out when|send rfqs our way|on the next (one|opportunity)|add (us|you|westgate) to (the|their) (bid|vendor) list/i;
const NONE_NOW = /\b(no|not any|doesn'?t have (an?|any)|does not have (an?|any)|don'?t have (an?|any)) (open |current |new )?(rfqs?|projects?|needs?|quotes?)\b|nothing (right now|open|going on|at the moment|currently|yet)|not needing anything|not (quoting|buying) anything|no big projects|no open rfqs/i;
const WHEN = /(middle of next week|mid[- ]?(next )?week|next week|end of (the |this |next )?week|end of (the |this )?month|next month|after the first of the year|first of the year|after the holidays|(this |next )?(monday|tuesday|wednesday|thursday|friday)|in (a couple|a few|two|three) weeks|(early|mid|late) (january|february|march|april|may|june|july|august|september|october|november|december)|tomorrow)/i;
const FRONT = /main (office|line)|front desk|reception|voicemail|transferred|gatekeeper|automated|operator|was not in|wasn't in|not available|out of the office/i;
const WHO = /(?:[Ss]poke (?:with|to)|[Rr]eached|[Tt]alked (?:to|with)|[Cc]onnected with)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/;

/** A call note, read for the same things the after-call step now saves. */
export function signalFromNote(note: { note: string; date_created: string }): CallSignal | null {
  const text = note.note.replace(/\s+/g, " ").trim();
  if (NOT_A_CALL.test(text) || text.length < 30) return null;
  if (!/\b(spoke|reached|talked|call(ed)?|voicemail|main office|transferred|said|buyer|purchasing)\b/i.test(text)) return null;
  const who = WHO.exec(text)?.[1] ?? null;
  const buyer = /\b(spoke|talked|reached|connected)\b/i.test(text) && !FRONT.test(text.slice(0, 160));
  // "Nothing right now, but I'll send the next one" is the next one, not a promise to chase (10/14: Cleaver-Brooks,
  // KMP and Gira were tagged [RFQ promised] on calls like that).
  const noneNow = NONE_NOW.test(text);
  const promised = PROMISE.test(text) && !noneNow;
  return {
    at: note.date_created, callId: null, tapped: null, buyer,
    promised, nextOne: !promised && (NEXT_ONE.test(text) || PROMISE.test(text)), softYes: false, noneNow, benchmark: false,
    expectedWhen: (promised || NEXT_ONE.test(text) || /expect|land|come|going out|sending|send/i.test(text)) ? WHEN.exec(text)?.[0] ?? null : null,
    who: who && !/^(the|someone|main|front)$/i.test(who) ? who : null, summary: text,
  };
}

// ---------- the score ----------
export type HeatIn = {
  now: Date; tz: string; company: string;
  contactName: string | null;
  /** Saved call facts (precise) and the account's call notes (read with patterns), merged. */
  signals: CallSignal[];
  notes: Array<{ note: string; date_created: string }>;
  replies: Array<{ at: string; text: string }>;
  clickedAt: string | null;
  openDays: string[];
  lastOutAt: string | null;
  rfq: { at: string; quotedAt: string | null } | null;
  /** Paused by a reply or by hand (warmth's read), or bounced. */
  paused: { kind: string; until: string | null; why: string } | null;
  tier: string | null;
  /** "When they send them", from the purchasing answers ("Mondays"). */
  rfqTiming: string | null;
};

const firstName = (n: string | null | undefined) => {
  const w = (n ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Z][a-z'-]+$/.test(w) && !/^(Purchasing|Main|Office|Info|Sales|The)$/.test(w) ? w : null;
};
const short = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const TIER_BONUS: Record<string, number> = { steady: 8, project: 4, occasional: 0, unknown: 1 };

export function heatFor(x: HeatIn): Heat {
  const { now, tz } = x;
  const today = dayIn(now.toISOString(), tz);
  const daysSince = (iso: string) => Math.floor((now.getTime() - Date.parse(iso)) / DAY);
  // Saved facts win over a note written within 90 minutes of the same call.
  const fromNotes = x.notes.map(signalFromNote).filter((s): s is CallSignal => !!s)
    .filter((n) => !x.signals.some((s) => Math.abs(Date.parse(s.at) - Date.parse(n.at)) < 90 * 60_000));
  const calls = [...x.signals, ...fromNotes].sort((a, b) => a.at.localeCompare(b.at));
  const lastBuyerName = [...calls].reverse().find((c) => c.who)?.who ?? null;
  const who = firstName(lastBuyerName) ?? firstName(x.contactName);
  const they = who ?? "They";
  const co = x.company.split(/[,(]| - /)[0].replace(/\s+(Inc|LLC|Co|Corp|Company)\.?$/i, "").trim();
  const cands: Array<{ score: number; band?: Band; reason: string; headline: string; tag: string; at: string | null }> = [];
  const tags = new Set<string>();
  let expected: string | null = null;

  // An RFQ in is the RFQs page's job (10/14: Kwan Wo's and ThermaPlate's RFQ emails read as "asked you"). A quote two
  // weeks old with nothing since: ask for the next one.
  if (x.rfq && !(x.rfq.quotedAt && daysSince(x.rfq.quotedAt) >= 14)) {
    return { band: "off", score: 0, reason: x.rfq.quotedAt ? `Quoted ${short(x.rfq.quotedAt, tz)}: on the RFQs page.` : `RFQ in ${short(x.rfq.at, tz)}: on the RFQs page.`, headline: `${co}: RFQ in`, tags: ["rfq in"], who, expected: null, lastSignal: x.rfq.at };
  }
  if (x.paused && (x.paused.kind === "out" || x.paused.kind === "no_emails")) {
    return { band: "off", score: 0, reason: x.paused.why, headline: `${co}: off the list`, tags: ["said no"], who, expected: null, lastSignal: null };
  }

  // A promise, newest first, unless an RFQ came in after it. Their own words can make it softer (10/14: "when stuff
  // comes up, I'll send over quotes" is the next one, not one to chase).
  const SOFT = /when (stuff|something|anything|there'?s (one|an opportunity|something)|we (have|get) (one|something)|it comes up|something comes up)|next (time|one|opportunity)|if (anything|something) (comes up|pops up)|down the road/i;
  for (const c of calls) if (c.promised && c.quote && SOFT.test(c.quote)) { c.promised = false; c.nextOne = true; }
  const promise = [...calls].reverse().find((c) => c.promised);
  // An out-of-office or other auto-reply isn't a person writing back (10/14: Alexander Mechanical, Sanders Brothers).
  const AUTO = /out of (the )?office|automatic reply|auto[- ]?reply|autoreply|i am (currently )?(out|away)|i'?m (currently )?(out|away)|will be out (of|until|on)|on (vacation|leave|pto)|limited access to (my )?email|return(ing)? to the office|this mailbox is (not|no longer) monitored|delivery has failed/i;
  const replyKinds = x.replies.filter((r) => (!x.rfq || r.at > (x.rfq.quotedAt ?? x.rfq.at)) && !AUTO.test(r.text.slice(0, 400))).map((r) => ({ ...r, own: cleanReply(r.text), kind: classifyReply(cleanReply(r.text), r.at) }));
  const replyPromise = [...replyKinds].reverse().find((r) => r.kind.kind === "promise");
  const promisedAt = [promise?.at, replyPromise?.at].filter((v): v is string => !!v).sort().pop() ?? null;
  let promiseOut: { at: string; quote: string | null } | null = null;
  if (promisedAt && !(x.rfq && x.rfq.at > promisedAt)) {
    const d = daysSince(promisedAt);
    // Their words: the call line where they said it, or the reply itself.
    const fromCall = [...calls].reverse().find((c) => c.promised && c.quote && Math.abs(Date.parse(c.at) - Date.parse(promise?.at ?? promisedAt)) < 6 * 3600_000)?.quote ?? null;
    const words = replyPromise && replyPromise.at === promisedAt ? replyPromise.own.slice(0, 160) : fromCall;
    promiseOut = { at: promisedAt, quote: words || null };
    const by = who ?? "they";
    tags.add(d >= 2 ? "promised · overdue" : "promised");
    if (d < 2) cands.push({ score: 60, band: "week", reason: `${who ?? "They"} promised an RFQ ${short(promisedAt, tz)}. Give it a day, then chase it.`, headline: `Watch for the RFQ ${by} promised`, tag: "promised", at: promisedAt });
    else if (d <= 30) cands.push({ score: 96 - Math.min(d, 20), reason: `Chase it: ${by} promised an RFQ on ${short(promisedAt, tz)}, ${d} days ago, and nothing has come.`, headline: `Chase the RFQ ${by} promised ${short(promisedAt, tz)}`, tag: "promised", at: promisedAt });
    else cands.push({ score: 40, reason: `${who ?? "They"} promised an RFQ on ${short(promisedAt, tz)} and never sent it. Worth a fresh ask.`, headline: `Ask ${who ?? co} again for the RFQ`, tag: "promised", at: promisedAt });
  }

  // When they said work is coming.
  const timed = [...calls].reverse().find((c) => c.expectedWhen && whenFromPhrase(c.expectedWhen, c.at, tz));
  if (timed) {
    expected = whenFromPhrase(timed.expectedWhen, timed.at, tz);
    const late = expected! < today ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${expected}T12:00:00Z`)) / DAY) : 0;
    const said = `${timed.who ? firstName(timed.who) ?? timed.who : they} said work comes "${timed.expectedWhen}" (${shortDay(expected!)})`;
    if (expected! > today) { tags.add("waiting for their day"); cands.push({ score: 18, band: "emails", reason: `${said}. Wait for it.`, headline: `Wait until ${shortDay(expected!)}`, tag: "their day", at: timed.at }); }
    else if (late <= 4) { tags.add("their day is now"); cands.push({ score: 98 - late, reason: `${said}. That's now.`, headline: `${who ?? co}'s RFQs were due ${shortDay(expected!)}: call`, tag: "their day", at: timed.at }); }
    else cands.push({ score: 45, reason: `${said}, ${late} days ago. Check in.`, headline: `Check in with ${who ?? co}: their RFQs were due ${shortDay(expected!)}`, tag: "their day", at: timed.at });
  }

  // What their replies say, without the signature.
  const lastReply = replyKinds[replyKinds.length - 1];
  if (lastReply && daysSince(lastReply.at) <= 14) {
    const words = lastReply.own.slice(0, 70);
    // Only while it's still open: an email or a call of yours since then answered it (10/14: Munish's 10/1 question was
    // talked through on 10/9).
    const followedUp = [x.lastOutAt, ...calls.map((c) => c.at)].some((t) => !!t && t > lastReply.at);
    if (lastReply.kind.kind === "engaged" && !followedUp) { tags.add("asked something"); cands.push({ score: 90, reason: `Asked you: "${words}"`, headline: `Answer ${who ?? co}: they asked something`, tag: "asked", at: lastReply.at }); }
    else if (lastReply.kind.kind === "engaged") cands.push({ score: 34, reason: `Asked "${words}" (${short(lastReply.at, tz)}); you've followed up since.`, headline: `Call ${who ?? co}`, tag: "replied", at: lastReply.at });
    // Wrote back and you haven't answered yet (10/14: Nicolette at Lundahl looped in Raylee and it read as "opened 6 days").
    else if (lastReply.kind.kind === "other" && !followedUp && words.length > 3) { tags.add("waiting on you"); cands.push({ score: 86, reason: `Wrote back ${short(lastReply.at, tz)} and is waiting on you: "${words}"`, headline: `Answer ${who ?? co}: they wrote back`, tag: "replied", at: lastReply.at }); }
    else if (["other", "ack"].includes(lastReply.kind.kind) && daysSince(lastReply.at) <= 7 && words.length > 3) cands.push({ score: 30, reason: `Wrote back ${short(lastReply.at, tz)}: "${words}"`, headline: `Follow up with ${who ?? co}: they wrote back`, tag: "replied", at: lastReply.at });
  }

  // A click on the line card or site link: a person reading it.
  if (x.clickedAt && daysSince(x.clickedAt) <= 5) { tags.add("clicked"); cands.push({ score: 92, reason: `Clicked your email ${short(x.clickedAt, tz)}. They're reading it.`, headline: `Call ${who ?? co}: clicked your email`, tag: "clicked", at: x.clickedAt }); }

  // "The next one is yours."
  const next = [...calls].reverse().find((c) => c.nextOne || c.softYes);
  if (next && daysSince(next.at) <= 45) { tags.add("next one is yours"); cands.push({ score: 50, reason: `${next.who ? firstName(next.who) ?? next.who : they} said they'll send the next one (${short(next.at, tz)}).`, headline: `Ask ${who ?? co} if the next one's out`, tag: "next one", at: next.at }); }

  // A real conversation with the buyer, fading over a month.
  const talk = [...calls].reverse().find((c) => c.buyer || c.tapped === "reached_buyer" || c.tapped === "pms_buy");
  if (talk) {
    const fade = Math.pow(0.5, daysSince(talk.at) / 30);
    const name = firstName(talk.who) ?? who;
    cands.push({ score: 12 + 28 * fade, reason: `Talked to ${name ?? "the buyer"} ${short(talk.at, tz)}${talk.noneNow ? ": nothing open then" : ""}.`, headline: `Call ${name ?? co}`, tag: "talked", at: talk.at });
  }

  // "Nothing right now": emails only for 10 days, then neutral.
  const latest = calls[calls.length - 1];
  if (latest?.noneNow && daysSince(latest.at) <= 10 && !(promisedAt && promisedAt >= latest.at) && !(timed && timed.at >= latest.at)) {
    tags.add("nothing right now");
    cands.push({ score: 14, band: "emails", reason: `${latest.who ? firstName(latest.who) ?? latest.who : they} said nothing right now (${short(latest.at, tz)}). Emails until ${short(new Date(Date.parse(latest.at) + 10 * DAY).toISOString(), tz)}.`, headline: `Let the emails carry ${co}`, tag: "not now", at: latest.at });
  }
  if (x.paused && x.paused.kind !== "bounced") cands.push({ score: 12, band: "emails", reason: x.paused.why, headline: `${co}: paused`, tag: "paused", at: null });
  if (x.paused?.kind === "bounced") cands.push({ score: 30, band: "week", reason: "The email bounced. Get a working address.", headline: `Get a working email for ${who ?? co}`, tag: "bounced", at: null });

  // A past RFQ you quoted: they buy from someone; ask for the next one.
  if (x.rfq?.quotedAt && daysSince(x.rfq.quotedAt) >= 14) { tags.add("repeat"); cands.push({ score: 55, reason: `You quoted their RFQ ${short(x.rfq.quotedAt, tz)}. Ask for the next one.`, headline: `Ask ${who ?? co} for the next RFQ`, tag: "repeat", at: x.rfq.quotedAt }); }

  // Opens, only across several days.
  const recentOpenDays = x.openDays.filter((d) => daysSince(`${d}T12:00:00Z`) <= 10);
  if (recentOpenDays.length >= 2) cands.push({ score: 16 + 4 * Math.min(recentOpenDays.length, 4), reason: `Opened your emails on ${recentOpenDays.length} different days.`, headline: `Call ${who ?? co}: they keep opening your emails`, tag: "opening", at: `${recentOpenDays[0]}T12:00:00Z` });
  if (x.rfqTiming) tags.add(`sends ${x.rfqTiming}`);

  // They gave a date (Walt 10/14: Allison at Alcatex, "mid November to early December before I know anything"): off the
  // map until then, with a task in Close for that day. Anything they do after saying it (a reply, a click) brings them back.
  // Only a date the buyer gave counts: not an email pause (the reply cool-down, a cool-off you set, "fewer emails please").
  // 10/14: those made 11 wrong tasks.
  const laterReplyAll = [...replyKinds].reverse().find((r) => r.kind.kind === "later");
  const gaveDate = !!laterReplyAll && !/reduce (the )?frequency|fewer (emails|messages)|too many|(monthly|quarterly) at most|less often|number of your messages/i.test(laterReplyAll.own);
  const pausedLater = x.paused && x.paused.kind === "later" && gaveDate && x.paused.until && x.paused.until > now.toISOString() ? x.paused : null;
  const farDay = timed && expected && expected > addDays(today, 3) ? { until: `${expected}T15:00:00Z`, said: timed } : null;
  // When they said it: the reply that named the date (a hold you set by hand sticks until its date).
  const snooze = pausedLater ? { until: pausedLater.until!, why: pausedLater.why, saidAt: laterReplyAll?.at ?? null, byHand: false } : farDay ? { until: farDay.until, why: `${farDay.said.who ? firstName(farDay.said.who) ?? farDay.said.who : they} said work comes "${farDay.said.expectedWhen}"`, saidAt: farDay.said.at, byHand: false } : null;
  if (snooze) {
    const since = snooze.saidAt ?? "";
    const newer = !snooze.byHand && ((x.clickedAt && x.clickedAt > since) || replyKinds.some((r) => r.at > since && ["engaged", "promise", "other"].includes(r.kind.kind)));
    if (!newer) {
      const back = dayIn(snooze.until, tz);
      tags.add("later");
      return { band: "later", score: 0, reason: `Back ${shortDay(back)}: ${snooze.why.replace(/^They said: /, `${they} said `)}`, headline: `Call ${who ?? co} on ${shortDay(back)}`, tags: [...tags], who, expected: back, lastSignal: since || null };
    }
  }
  if (!cands.length) return { band: "emails", score: TIER_BONUS[x.tier ?? "unknown"] ?? 0, reason: "Nothing from them yet: the emails carry it.", headline: `Let the emails carry ${co}`, tags: [...tags], who, expected, lastSignal: null };
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0];
  // "Wait for their day" holds them back unless something stronger came after it.
  const waiting = cands.find((c) => c.tag === "their day" && c.band === "emails");
  const lead = waiting && top.score < 85 ? waiting : top;
  const score = Math.round((lead.score + 0.15 * cands.filter((c) => c !== lead).reduce((s, c) => s + c.score, 0) + (TIER_BONUS[x.tier ?? "unknown"] ?? 0)) * 10) / 10;
  const band: Band = lead.band ?? (score >= 70 ? "today" : score >= 25 ? "week" : "emails");
  const lastSignal = cands.map((c) => c.at).filter((v): v is string => !!v).sort().pop() ?? null;
  return { band, score, reason: lead.reason, headline: lead.headline, tags: [...tags], who, expected, lastSignal, promise: promiseOut };
}

// ---------- their words, for promises made before the quote was saved (10/14) ----------
/** A line from their side of the call that promises something: "I'll shoot that over this afternoon". */
// "I'll send you…", "we'll shoot that over…", "I'm working on a quote…". Not "send me an email" or "you want to…":
// that's them asking you for something (10/14: "Let me pull up my email" read as a promise).
const THEIR_PROMISE = /\b(i'?ll|i will|we'?ll|we will|i can|i'?m going to|i'?m gonna|gonna|i'?m working on|we'?re working on)\b[^.?!]{0,60}?(\b(send|shoot|email|forward)\s+(you|it|that|those|them|something|over|our|the|a|an|some|this)\b|\bget\s+you\b)[^.?!]*[.?!]?/i;
const NOT_A_PROMISE = /\b(send|shoot|email|forward|text)\s+me\b|you want|pull up|look up|look at|send it to me|if you (send|email)/i;
export function promiseLine(utterances: Array<{ speaker_side?: string; text: string }>): string | null {
  const theirs = utterances.filter((u) => u.speaker_side === "contact").map((u) => u.text.replace(/\s+/g, " ").trim());
  for (const t of theirs) {
    for (const sentence of t.split(/(?<=[.?!])\s+/)) {
      const m = THEIR_PROMISE.exec(sentence);
      if (m && !NOT_A_PROMISE.test(sentence)) { const s = sentence.trim(); return (s.length > 180 ? `${s.slice(0, 177)}…` : s).replace(/^./, (c) => c.toUpperCase()); }
    }
  }
  return null;
}
/**
 * For promises with no saved words yet: find the call it was made on, read their side of the transcript, save the line.
 * A few accounts a pass; "" marks one looked at and not found, so it isn't read again.
 */
export async function backfillPromiseQuotes(d: Deps, accounts: Array<{ leadId: string; heat?: Heat }>, max = 6, opts: { reread?: boolean } = {}): Promise<number> {
  const all = await loadCallSignals(d.rep.closeUserId);
  let n = 0;
  for (const a of accounts) {
    if (n >= max) break;
    const p = a.heat?.promise;
    if (!p || (p.quote && !opts.reread)) continue;
    const near = (all[a.leadId] ?? []).find((s) => Math.abs(Date.parse(s.at) - Date.parse(p.at)) < 6 * 3600_000);
    if (near && near.quote !== undefined && near.quote !== null && !(opts.reread && !near.summary)) continue; // looked already (a re-read redoes only lines this job found)
    n++;
    const calls = await d.close.calls({ leadId: a.leadId, since: new Date(Date.parse(p.at) - 2 * DAY).toISOString(), withTranscripts: true, max: 20 }).catch(() => []);
    const call = calls.filter((c) => Date.parse(c.date_created) <= Date.parse(p.at) + 3600_000 && (c.duration ?? 0) >= 20)
      .sort((x, y) => Math.abs(Date.parse(x.date_created) - Date.parse(p.at)) - Math.abs(Date.parse(y.date_created) - Date.parse(p.at)))[0];
    const line = call?.recording_transcript?.utterances?.length ? promiseLine(call.recording_transcript.utterances as never) : null;
    await saveCallSignal(d, a.leadId, near ? { ...near, promised: true, quote: line ?? "" } : {
      at: p.at, callId: call?.id ?? null, tapped: null, buyer: true, promised: true, nextOne: false, softYes: false, noneNow: false, benchmark: false,
      expectedWhen: null, who: null, summary: null, quote: line ?? "",
    });
  }
  return n;
}
