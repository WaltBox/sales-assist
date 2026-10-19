import { lineCardAttachments, type Deps } from "./assistant.js";
import { formatParagraphs, stripDashes } from "./benchmark.js";
import { transcriptText, type CloseClient, type LeadEmail } from "./close.js";
import { config } from "./config.js";
import { loadLeadContext, renderContext, type LeadContext } from "./context.js";
import { businessDaysBetween, isoWithOffset, localParts, nextWeekdayAt, zonedTime } from "./rules.js";
import { FollowUpSchema, type FollowUp } from "./schemas.js";
import { logRejection, retryNote, ruleChecks, type Failure } from "./validate.js";
import { bumpHtml, linkUrl, newToken, trackingOn, trackMeme, type Meme } from "./memes.js";

// "Write a follow-up" (Walt 9/25): one tap drafts a short bump in Close.
// It replies in the lead's existing thread when there is one (only a lead with
// no emails gets a new thread), resurfaces the original, and never sends.

export class FollowUpError extends Error {}

export type FollowUpResult =
  | { status: "warn"; warning: string }
  | { status: "drafted"; draftId: string; to: string; subject: string; body: string; threaded: boolean; attachedLineCard: boolean; warnings: string[]; scheduledFor: string | null; meme?: string | null; track?: string | null };

/**
 * When an automatic bump goes out (Walt 10/6): a weekday, a random minute between 8:11 and 11:00 their time, so a
 * batch doesn't land as a block at the top of the hour. Before 8:11 → somewhere in today's window; inside it → a
 * random minute from a few minutes out to 11:00; after 11 → the next weekday's window. `stagger` only nudges the
 * earliest possible minute, so a big batch still spreads across the whole window.
 */
// Around their 8am (Walt 10/8: "they should go out around the customer's 8am"), a random minute so a wave isn't a block.
export const SEND_WINDOW = { fromMinute: 7 * 60 + 50, toMinute: 8 * 60 + 35 };
/** Monday morning is a pile of mail (10/12): Monday's go out after 10. */
export const MONDAY_WINDOW = { fromMinute: 10 * 60, toMinute: 10 * 60 + 45 };
const windowOn = (weekday: number) => (weekday === 1 ? MONDAY_WINDOW : SEND_WINDOW);
export function sendSlot(tz: string, now: Date, stagger = 0, rand: () => number = Math.random): string {
  const p = localParts(now, tz);
  const mins = p.hour * 60 + p.minute;
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  const w = windowOn(p.weekday);
  const pick = (dayStart: Date, fromMin: number, win: { toMinute: number }) => {
    const span = Math.max(1, win.toMinute - fromMin);
    return new Date(dayStart.getTime() + (fromMin + Math.floor(rand() * span)) * 60 * 1000);
  };
  let at: Date;
  if (weekday && mins < w.fromMinute) at = pick(zonedTime(p.year, p.month, p.day, 0, 0, tz), w.fromMinute + Math.min(stagger, 20), w);
  else if (weekday && mins < w.toMinute - 5) at = pick(zonedTime(p.year, p.month, p.day, 0, 0, tz), mins + 5 + Math.min(stagger, 10), w);
  else {
    const next = nextWeekdayAt(tz, now, 0, 0);
    const nw = windowOn(localParts(new Date(next.getTime() + 12 * 3600 * 1000), tz).weekday);
    at = pick(next, nw.fromMinute + Math.min(stagger, 20), nw);
  }
  return isoWithOffset(at, tz);
}

const REAL = new Set(["sent", "inbox"]); // not drafts, scheduled, or failed sends
const when = (e: LeadEmail) => e.date_sent ?? e.date_created ?? "";
/** "renee.smith@x.com" → "Renee", for greeting someone who isn't a saved contact. */
const nameFromEmail = (addr: string) => { const n = addr.split("@")[0].split(/[._-]/)[0]; return n ? n[0].toUpperCase() + n.slice(1).toLowerCase() : addr; };
const emailOf = (s: string | null | undefined) => (s ?? "").match(/<([^>]+)>/)?.[1] ?? (s ?? "").trim();

export { businessDaysBetween };

const SENTENCES = (body: string, rep: string) => {
  const lines = body.trim().split(/\n\s*\n/);
  // Greeting, the thanks line, and the signature don't count toward the 2–4.
  const core = lines.filter((l, i) => !(i === 0 && /^(hi|hello|hey|good (morning|afternoon))\b/i.test(l)) && !/^thanks\b/i.test(l.trim()) && l.trim() !== rep);
  return core.join(" ").split(/(?<=[.!?])\s+(?=[A-Z"'])/).filter((s) => s.trim()).length;
};

function withSignature(body: string, rep: string) {
  const b = formatParagraphs(stripDashes(body).trim().replace(/\n{3,}/g, "\n\n"), rep);
  return b.endsWith(rep) ? b : `${b}\n\n${rep}`;
}

function threadText(emails: LeadEmail[]) {
  return emails.slice(0, 3).map((e) => [
    `--- ${e.direction === "incoming" ? "FROM THE PROSPECT" : "FROM US"} · ${when(e).slice(0, 10)} · ${e.subject ?? "(no subject)"}`,
    (e.body_text ?? "").trim().slice(0, 1200),
  ].join("\n")).join("\n\n");
}

/** Who the follow-up goes to: the other side of the latest email, else the last called contact, else the buyer on file. */
function recipient(ctx: LeadContext, latest: LeadEmail | undefined, repEmail: string, thread: LeadEmail[] = []) {
  const byEmail = (addr: string) => ctx.contacts.find((c) => c.emails.some((x) => x.email.toLowerCase() === addr.toLowerCase()));
  // The name they write under beats the contact's name in Close (10/1: "Sam Ives" in Close, but jives@ signs as Jennifer Ives).
  const theirName = (addr: string) => {
    const m = thread.find((e) => e.direction === "incoming" && emailOf(e.sender)?.toLowerCase() === addr.toLowerCase())?.sender?.match(/^\s*"?([^"<]+?)"?\s*</);
    return m && /[a-z]/i.test(m[1]) && !m[1].includes("@") ? m[1].trim() : null;
  };
  if (latest) {
    // Never a Westgate address (you, Jacob, team@): the buyer on that email.
    const addr = [latest.direction === "incoming" ? emailOf(latest.sender) : null, ...(latest.to ?? []).map(emailOf)]
      .find((a) => a && a.toLowerCase() !== repEmail.toLowerCase() && !/@westgatesupply\.com$/i.test(a));
    if (addr) { const c = byEmail(addr); return { email: addr, name: theirName(addr) ?? c?.name ?? null, contactId: c?.id ?? latest.contact_id ?? null }; }
  }
  const called = ctx.calls.map((c) => ctx.contacts.find((x) => x.id === c.contact_id)).find((c) => c?.emails.length);
  const fallback = called ?? ctx.contacts.find((c) => c.emails.length && /purchas|buyer|procure/i.test(c.title ?? "")) ?? ctx.contacts.find((c) => c.emails.length);
  return fallback ? { email: fallback.emails[0].email, name: fallback.name, contactId: fallback.id } : null;
}

/** The last call, said plainly: when (their time), how long, and whether it connected. Close marks 7-second rings "answered". */
function lastCallLine(c: { date_created: string; duration: number; recording_transcript?: Parameters<typeof transcriptText>[0] }, tz: string, now: Date) {
  const at = new Date(c.date_created);
  const sameDay = localParts(at, tz).day === localParts(now, tz).day && now.getTime() - at.getTime() < 864e5;
  const hour = localParts(at, tz).hour;
  const when = sameDay ? (hour < 12 ? "this morning" : "this afternoon") : `on ${at.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" })}`;
  const connected = c.duration >= 20 && Boolean(c.recording_transcript?.utterances?.length);
  const transcript = transcriptText(c.recording_transcript);
  return `The rep's most recent call on this lead was ${when} (their time), ${c.duration} seconds: ${connected ? "they talked" : "it didn't connect (a missed try)"}.${transcript && connected ? ` Transcript:\n${transcript.slice(0, 1500)}` : ""}`;
}

// The automatic bumps (Walt 10/12): the job is to be on top of their inbox the day an RFQ is ready, not to sell.
// Eager salesman, full sentences like Walt typed them, and every one ends in the same plain ask. Nothing self-aware
// about how many emails they've had. The line depends on the track (talked to the buyer, or the email came from the
// front desk), the round (how many real conversations), and where the account is in the sequence.
export const ASK = "Please send me over an RFQ and we'll get you a quote back.";
const BENCHMARK = "I have a quick ask for you. Send me the last RFQ you sent out, even if it's already been bought, and we'll quote it so you can see where we land.";
const HOPE_WEEK = `I hope your week's going good! ${ASK}`;
const RHYTHM = [
  `I wanted to get back in front of you so I'm on top of the pile the day one comes across your desk. Please send it over and we'll get you a quote back.`,
  `I'm bumping this back up for you. If you have an RFQ going out this week, please send it over and we'll get you a quote back.`,
  HOPE_WEEK,
];
const COLD = [
  `I wanted to bump this back up in case it got buried. ${ASK}`,
  `I'm checking in on this one more time. ${ASK}`,
  HOPE_WEEK,
];
/** A shared mailbox (info@, estimating@): every other email asks who to send it to. */
export const WHO_HANDLES = "I'm trying to reach whoever handles the pipe and fittings RFQs over there. If you can point me their way, or just send one over, we'll get you a quote back.";
const BUMP_LINES = RHYTHM;
/**
 * The name to greet with, or null for "Hi there," (10/1): a nickname in brackets wins ("H.C. (Clifford) Provence"
 * → Clifford); an initial ("J. Waite") or a mailbox word ("frontdesk", "hello", "info") isn't a name.
 */
export function greetName(name: string | null | undefined): string | null {
  if (!name) return null;
  const nick = name.match(/\(([A-Z][a-z]{1,20})\)/);
  if (nick) return nick[1];
  const w = name.trim().split(/\s+/)[0] ?? "";
  if (/^([A-Z]\.?){1,3}$/i.test(w) && w.replace(/\./g, "").length <= 2) return null;
  if (/^(info|hello|hi|frontdesk|front|desk|team|office|main|sales|purchasing|admin|contact|reception|receptionist|accounts?|ap|orders?|service|support|estimating|estimator|dispatch|general|mail|inquiries|quotes?|bids?)$/i.test(w.replace(/[^a-z]/gi, ""))) return null;
  if (!/^[A-Za-z][A-Za-z'-]+$/.test(w)) return null;
  return w[0].toUpperCase() + w.slice(1);
}

const VARIANTS: Record<string, string[]> = {
  // Friday (Walt 10/8, his words): bump it before the week ends.
  friday: [
    `I wanted to bump this before the week ends. ${ASK}`,
    `Happy Friday! Before the weekend hits, ${ASK.charAt(0).toLowerCase()}${ASK.slice(1)}`,
  ],
};
/** Said in every bump (10/6): the PDF rides along each time, and the hosted copy is one click away. */
export const LINE_CARD_URL = "https://westgatesupply.com/brand/westgate-line-card.pdf";
export const SITE_URL = "https://westgatesupply.com";
export const ATTACHED_LINE = `Line card's attached too, or you can grab it here: ${LINE_CARD_URL}`;
/**
 * The line fitted to the day it goes out, their time (Walt 10/12: "Hope your week's going good" landed on a Monday
 * morning). Monday: the week's just starting. Friday: "Happy Friday". A Friday line never goes out midweek.
 * `weekday`: 0 Sunday … 6 Saturday; unknown leaves the line as written.
 */
export function fitDay(line: string, weekday: number | null | undefined): string {
  if (weekday == null) return line;
  const fridayOnly = /happy friday|before the week ends|before the weekend/i.test(line);
  if (fridayOnly && weekday !== 5) return fitDay(BUMP_LINES[0], weekday);
  if (weekday === 1) return line.replace(/(I hope|Hope) your week's going good!/, "$1 your week's off to a good start!");
  if (weekday === 5) return line.replace(/(I hope|Hope) your week's going good!/, "Happy Friday!");
  return line;
}

export type BumpPlace = {
  /** Emails since the last real conversation (0 = the first one after the line card). */
  nth: number;
  track?: "talked" | "cold";
  /** Real conversations so far: round 2 knows you've talked before. */
  round?: number;
  /** A shared mailbox: every other email asks who handles RFQs. */
  generic?: boolean;
  weekday?: number | null;
  /** Calendar days since you talked (for "yesterday" vs "the other day"). */
  talkedDaysAgo?: number | null;
  variant?: string | null;
  /** Tracked links, when tracking is on. */
  cardUrl?: string | null;
  siteUrl?: string | null;
};

/** The one line in the bump: which depends on the track, the round and where they are in the sequence. */
export function bumpLine(p: BumpPlace): string {
  const { nth } = p;
  if (p.variant && VARIANTS[p.variant]) { const v = VARIANTS[p.variant]; return v[nth % v.length]; }
  if (p.generic && nth % 2 === 1) return WHO_HANDLES;
  if ((p.track ?? "talked") === "cold") return COLD[nth % COLD.length];
  const round = p.round ?? 1;
  // "Great talking to you" only while the call is fresh: more than a week later it reads wrong.
  if (nth === 0 && (p.talkedDaysAgo == null || p.talkedDaysAgo <= 7)) {
    if (round >= 2) return `It was good talking to you again! ${ASK}`;
    const when = p.talkedDaysAgo != null && p.talkedDaysAgo <= 1 ? "yesterday" : "the other day";
    return `It was great talking to you ${when}! ${ASK}`;
  }
  if (nth === 0) return HOPE_WEEK;
  if (nth === 1) return BENCHMARK;
  if (nth === 2) return HOPE_WEEK;
  return RHYTHM[(nth - 3) % RHYTHM.length];
}

export function bumpBodyFor(first: string | null, repName: string, place: BumpPlace = { nth: 0 }) {
  const line = fitDay(bumpLine(place), place.weekday);
  const card = `Line card's attached too, or you can grab it here: ${place.cardUrl ?? LINE_CARD_URL}`;
  // Someone you haven't talked to gets the site too (Walt 10/12): a click tells us the address works.
  const site = place.track === "cold" ? `\n\nOur site is here if that's easier: ${place.siteUrl ?? SITE_URL}` : "";
  return `Hi ${first ?? "there"}!\n\n${line}\n\n${card}${site}\n\nThanks,\n${repName}`;
}

export async function writeFollowUp(d: Deps, leadId: string, opts: { force?: boolean; schedule?: { stagger: number; now?: boolean }; template?: { meme: Meme | null; place: BumpPlace }; onlyTo?: string } = {}): Promise<FollowUpResult> {
  const now = d.now?.() ?? new Date();
  const [ctx, all] = await Promise.all([loadLeadContext(d.close as CloseClient, leadId, now), d.close.leadEmails(leadId)]);
  if (ctx.facts.vendor || ctx.facts.competitorHits.length) throw new FollowUpError("This lead is a vendor or competitor. No follow-up.");

  const emails = all.filter((e) => REAL.has(e.status)).sort((a, b) => when(b).localeCompare(when(a)));
  const involves = (e: LeadEmail, addr: string) => [emailOf(e.sender), ...(e.to ?? []).map(emailOf)].some((a) => a?.toLowerCase() === addr.toLowerCase());
  // The newest email with the buyer in it, not an internal one (10/1: the website's RFQ-form notification from
  // team@westgatesupply.com was the newest on the test lead, and a bump went to team@).
  const ours = (a: string | null | undefined) => !a || /@westgatesupply\.com$/i.test(a);
  const external = (e: LeadEmail) => [emailOf(e.sender), ...(e.to ?? []).map(emailOf)].some((a) => !ours(a));
  const latest = opts.onlyTo ? emails.find((e) => involves(e, opts.onlyTo!)) : emails.find(external);
  const lastOut = emails.find((e) => e.direction === "outgoing");

  // Guardrail: emailed inside the cadence (two business days, Walt 10/5) with no reply or call since.
  const MIN_GAP_BUSINESS_DAYS = 2;
  if (lastOut && !opts.force) {
    const sentAt = new Date(when(lastOut));
    const replied = emails.some((e) => e.direction === "incoming" && when(e) > when(lastOut));
    const calledSince = ctx.calls.some((c) => c.direction === "outbound" && c.date_created > when(lastOut));
    const days = businessDaysBetween(sentAt, now, d.rep.timeZone);
    if (days < MIN_GAP_BUSINESS_DAYS && !replied && !calledSince) {
      const ago = days === 0 ? "earlier today" : `${days} business day${days === 1 ? "" : "s"} ago`;
      return { status: "warn", warning: `You emailed them ${ago} with no reply or call since. Send anyway?` };
    }
  }

  // Test sends go to one address only, the test lead's contact (10/1: one went to team@, from the thread instead).
  const onlyContact = opts.onlyTo ? ctx.contacts.find((c) => c.emails.some((e) => e.email.toLowerCase() === opts.onlyTo!.toLowerCase())) : undefined;
  const to = opts.onlyTo ? { email: opts.onlyTo, name: onlyContact?.name ?? null, contactId: onlyContact?.id ?? null } : recipient(ctx, latest, d.rep.email, emails);
  if (!to) throw new FollowUpError("There's no email address on this lead to follow up with.");
  if (/@westgatesupply\.com$/i.test(to.email)) throw new FollowUpError(`Stopped: the follow-up was addressed to ${to.email}, a Westgate address.`);
  const threaded = Boolean(latest);
  const baseSubject = (latest?.subject ?? "").replace(/^(re:\s*)+/i, "");
  const subject = threaded ? `Re: ${baseSubject || "Westgate Supply"}` : "Westgate Supply – line card";
  const displayName = to.name ?? nameFromEmail(to.email);
  const first = greetName(to.name) ?? greetName(nameFromEmail(to.email));
  const lastCall = ctx.calls.find((c) => c.user_id === d.rep.closeUserId);

  const task = [
    `Write a follow-up email from ${d.rep.name} to ${to.name ?? to.email}${first ? ` (greet them as ${first})` : ""}.`,
    threaded
      ? "It is a REPLY in the existing thread: the original email is right below it, so it's a bump, not a re-pitch. Do NOT restate products, the value prop, or the detailed ask. Its only job is to resurface the original email."
      : "There are no earlier emails, so this is the first email: a short note that the line card is attached, one line on what we'd supply them, and the ask to reply with anything to price.",
    "2 to 4 short sentences, max; longer reads as desperate. The rep's own voice (10/6): complete sentences that read like they typed them, not a template and not email lingo. Open with \"Hi [first name],\" then a plain check-in in his words ('I wanted to check in on this.' / 'I'm following up on my last note.'), never 'bumping', 'circling back', 'top of your inbox' or clipped fragments ('Quick one:'); then, only if it's true and adds something, one short line on the last real touch ('Tried you by phone this morning too.'), then one direct ask ('Reply here with your RFQ or list and I'll price it.'). No hedging: never 'no strings', 'no pressure', 'no rush', 'I'll get pricing back fast', or 'if something comes up'. End with the rep's full name on its own line; no separate thanks line.",
    "Tone by situation, still short: line card sent with no reply → 'bumping this back to the top of your inbox, reply here with your RFQ or list'. They promised an RFQ → 'bumping this to the top in case the RFQ is ready, just reply here with it'. Reached a gatekeeper and the buyer was out → 'checking back, is [name] around this week?'. Quote already sent → 'any thoughts on the numbers I sent?'. Buyer said nothing right now → one short line, and no past-RFQ ask if they already declined it.",
    "Never invent a reply the prospect didn't send and never claim a relationship that isn't there. No em or en dashes.",
    `Reference for length and tone:\nHi Zachary,\n\nI wanted to check in on this. I tried you by phone this morning too. Reply here with your RFQ or list and I'll price it.\n\n${d.rep.name}`,
    lastCall ? lastCallLine(lastCall, ctx.facts.prospectTz ?? d.rep.timeZone, now) : "There are no recent calls on this lead.",
    emails.length ? `The email thread, newest first:\n${threadText(emails)}` : "",
  ].filter(Boolean).join("\n\n");

  const context = renderContext(ctx, d.rep, { now, summariesOnly: true });
  let failures: Failure[] = [];
  let draft: FollowUp | null = null;
  let body = "";
  // When it goes out, their time: the wording fits that day (10/12).
  const tz = ctx.facts.prospectTz ?? d.rep.timeZone;
  const scheduledFor = !opts.schedule ? null
    : opts.schedule.now ? isoWithOffset(new Date(now.getTime() + (2 + opts.schedule.stagger) * 60 * 1000), tz)
    : sendSlot(tz, now, opts.schedule.stagger);
  const sendDay = localParts(new Date(scheduledFor ?? now.toISOString()), tz).weekday;
  // Automatic bump in the thread: the template, no AI.
  // Every automatic bump is tracked when tracking is on (10/12): the meme, and the line card and site links, so a
  // click tells us a person read it.
  const token = opts.template && threaded && (opts.template.meme || trackingOn()) ? newToken() : null;
  if (opts.template && threaded) {
    const tracked = token && trackingOn() ? { cardUrl: linkUrl(token, "card"), siteUrl: linkUrl(token, "site") } : {};
    body = bumpBodyFor(first, d.rep.name, { ...opts.template.place, weekday: sendDay, ...tracked });
    draft = { body } as FollowUp;
  }
  for (let attempt = 1; attempt <= 2 && !(opts.template && threaded); attempt++) {
    const { data } = await d.llm({
      schema: FollowUpSchema, effort: config.effortFast, model: config.emailModel, context,
      task: failures.length ? `${task}\n\n${retryNote(failures)}` : task,
    });
    draft = data;
    body = withSignature(data.body, d.rep.name);
    failures = ruleChecks({ to: [{ name: displayName, email: to.email }], subject, body, attach_line_card: !threaded, address_as_heard: null }, ctx, null, d.rep.name);
    const n = SENTENCES(body, d.rep.name);
    if (n > 4) failures.push({ rule: "intro_format", sentence: null, problem: `The follow-up is ${n} sentences; it must be 2 to 4.` });
    if (!failures.length) break;
    logRejection({ repId: d.rep.closeUserId, at: now.toISOString(), leadId, company: ctx.facts.company, callId: null, attempt, failures, subject, body, final: attempt === 2 });
  }
  if (failures.length || !draft) throw new FollowUpError(`Couldn't write a follow-up that passed the checks (${failures.map((f) => f.problem).join(" ")}). Write this one yourself.`);

  // The line card is attached every time (Walt 10/6: buyers kept saying they couldn't find it in the thread).
  const warnings: string[] = [];
  let attachments: Awaited<ReturnType<typeof lineCardAttachments>> = await lineCardAttachments(d).catch(() => []);
  if (!attachments.length) warnings.push("LINE CARD NOT ATTACHED: add it in Close before sending.");
  // "now": out in a couple of minutes plus the stagger, whatever the hour (an approved same-day send, 10/2); set above.
  const meme = opts.template && threaded ? opts.template.meme : null;
  const created = await d.close.createDraftEmail(leadId, {
    contactId: to.contactId, to: [to.email], subject, body, attachments,
    sender: d.rep.sender ?? `"${d.rep.name.replaceAll('"', "")}" <${d.rep.email}>`, emailAccountId: d.rep.emailAccountId ?? null,
    inReplyToId: latest?.id ?? null, threadId: latest?.thread_id ?? null, scheduleAt: scheduledFor,
    html: opts.template && threaded ? bumpHtml(body, d.rep.name, meme, token) : null,
  });
  if (token) await trackMeme({ token, repId: d.rep.closeUserId, repName: d.rep.name, repEmail: d.rep.email, leadId, meme: meme?.name ?? "", emailId: created.id });
  return { status: "drafted", draftId: created.id, to: to.email, subject, body, threaded, attachedLineCard: attachments.length > 0, warnings, scheduledFor, meme: meme?.name ?? null, track: token };
}
