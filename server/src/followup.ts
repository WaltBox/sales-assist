import { lineCardAttachments, type Deps } from "./assistant.js";
import { formatParagraphs, stripDashes } from "./benchmark.js";
import { transcriptText, type CloseClient, type LeadEmail } from "./close.js";
import { config } from "./config.js";
import { loadLeadContext, renderContext, type LeadContext } from "./context.js";
import { businessDaysBetween, isoWithOffset, localParts, nextWeekdayAt, zonedTime } from "./rules.js";
import { FollowUpSchema, type FollowUp } from "./schemas.js";
import { logRejection, retryNote, ruleChecks, type Failure } from "./validate.js";
import { bumpHtml, type Meme } from "./memes.js";

// "Write a follow-up" (Walt 9/25): one tap drafts a short bump in Close.
// It replies in the lead's existing thread when there is one (only a lead with
// no emails gets a new thread), resurfaces the original, and never sends.

export class FollowUpError extends Error {}

export type FollowUpResult =
  | { status: "warn"; warning: string }
  | { status: "drafted"; draftId: string; to: string; subject: string; body: string; threaded: boolean; attachedLineCard: boolean; warnings: string[]; scheduledFor: string | null; meme?: string | null };

/**
 * When an automatic bump goes out: a weekday morning, 9 to 11 their time. Before 9 → 9 today; in the
 * window → shortly; after → 9 the next weekday. `stagger` spreads a batch out so they don't all land at 9:00.
 */
export function sendSlot(tz: string, now: Date, stagger = 0): string {
  const p = localParts(now, tz);
  const mins = p.hour * 60 + p.minute;
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  const spread = Math.min(stagger, 110) * 60 * 1000;
  let at: Date;
  if (weekday && mins < 9 * 60) at = new Date(zonedTime(p.year, p.month, p.day, 9, 0, tz).getTime() + spread);
  else if (weekday && mins < 10 * 60 + 30) at = new Date(now.getTime() + 20 * 60 * 1000 + Math.min(spread, 30 * 60 * 1000));
  else at = new Date(nextWeekdayAt(tz, now, 9, 0).getTime() + spread);
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

// The automatic bump (Walt 9/30): no AI, just back to the top of the inbox and one question, plus a meme.
// A few wordings, so a second bump to the same company doesn't read word for word like the first.
const BUMP_LINES = [
  "Just bumping this back to the top of your inbox. Any RFQs coming up I can price for you?",
  "Bumping this back to the top of your inbox. Got any RFQs coming up I can quote?",
  "Popping this back to the top of your inbox. Anything coming up I can price for you?",
];
/**
 * The name to greet with, or null for "Hi there!" (10/1): a nickname in brackets wins ("H.C. (Clifford) Provence"
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

const VARIANTS: Record<string, string> = {
  // Friday send (Walt 10/2): pricing back Monday morning is the hook, so Monday has to deliver.
  friday: "Happy Friday! Bumping this back to the top before the weekend. If there's an RFQ on your desk, send it over and I'll have pricing back to you Monday morning.",
  // For an account that's never shown an open (Walt 10/5): ask straight out whether it landed; junk folders eat a lot of these.
  landed: "Bumping this back to the top in case it landed in junk. If there's an RFQ on your desk, send it over and I'll price it.",
};
export function bumpBodyFor(first: string | null, repName: string, nth = 0, variant?: string | null) {
  const line = (variant && VARIANTS[variant]) || BUMP_LINES[nth % BUMP_LINES.length];
  return `Hi ${first ?? "there"}!\n\n${line}\n\n${repName}`;
}

export async function writeFollowUp(d: Deps, leadId: string, opts: { force?: boolean; schedule?: { stagger: number; now?: boolean }; template?: { meme: Meme | null; nth: number; variant?: string | null }; onlyTo?: string } = {}): Promise<FollowUpResult> {
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
    "2 to 4 short sentences, max; longer reads as desperate. Walt's voice (9/26): open with \"Hi [first name]!\" and \"Just bumping this back to the top of your inbox.\" (or a close variation), then, only if it's true and adds something, one short line on the last real touch ('Tried you by phone this morning too.'), then one direct ask ('Reply here with your RFQ or list and I'll price it.'). No hedging: never 'no strings', 'no pressure', 'no rush', 'I'll get pricing back fast', or 'if something comes up'. End with the rep's full name on its own line; no separate thanks line.",
    "Tone by situation, still short: line card sent with no reply → 'bumping this back to the top of your inbox, reply here with your RFQ or list'. They promised an RFQ → 'bumping this to the top in case the RFQ is ready, just reply here with it'. Reached a gatekeeper and the buyer was out → 'checking back, is [name] around this week?'. Quote already sent → 'any thoughts on the numbers I sent?'. Buyer said nothing right now → one short line, and no past-RFQ ask if they already declined it.",
    "Never invent a reply the prospect didn't send and never claim a relationship that isn't there. No em or en dashes.",
    `Reference for length and tone:\nHi Zachary!\n\nJust bumping this back to the top of your inbox. Tried you by phone this morning too. Reply here with your RFQ or list and I'll price it.\n\n${d.rep.name}`,
    lastCall ? lastCallLine(lastCall, ctx.facts.prospectTz ?? d.rep.timeZone, now) : "There are no recent calls on this lead.",
    emails.length ? `The email thread, newest first:\n${threadText(emails)}` : "",
  ].filter(Boolean).join("\n\n");

  const context = renderContext(ctx, d.rep, { now, summariesOnly: true });
  let failures: Failure[] = [];
  let draft: FollowUp | null = null;
  let body = "";
  // Automatic bump in the thread: the template, no AI.
  if (opts.template && threaded) {
    body = bumpBodyFor(first, d.rep.name, opts.template.nth, opts.template.variant);
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
    logRejection({ at: now.toISOString(), leadId, company: ctx.facts.company, callId: null, attempt, failures, subject, body, final: attempt === 2 });
  }
  if (failures.length || !draft) throw new FollowUpError(`Couldn't write a follow-up that passed the checks (${failures.map((f) => f.problem).join(" ")}). Write this one yourself.`);

  // Attach the line card only on a brand-new thread; on a reply it's already above.
  const warnings: string[] = [];
  let attachments: Awaited<ReturnType<typeof lineCardAttachments>> = [];
  if (!threaded) {
    attachments = await lineCardAttachments(d).catch(() => []);
    if (!attachments.length) warnings.push("LINE CARD NOT ATTACHED: add it in Close before sending.");
  }
  // "now": out in a couple of minutes plus the stagger, whatever the hour (an approved same-day send, 10/2).
  const tz = ctx.facts.prospectTz ?? d.rep.timeZone;
  const scheduledFor = !opts.schedule ? null
    : opts.schedule.now ? isoWithOffset(new Date(now.getTime() + (2 + opts.schedule.stagger) * 60 * 1000), tz)
    : sendSlot(tz, now, opts.schedule.stagger);
  const created = await d.close.createDraftEmail(leadId, {
    contactId: to.contactId, to: [to.email], subject, body, attachments,
    sender: d.rep.sender ?? `"${d.rep.name.replaceAll('"', "")}" <${d.rep.email}>`, emailAccountId: d.rep.emailAccountId ?? null,
    inReplyToId: latest?.id ?? null, threadId: latest?.thread_id ?? null, scheduleAt: scheduledFor,
    html: opts.template && threaded && opts.template.meme ? bumpHtml(body, d.rep.name, opts.template.meme) : null,
  });
  return { status: "drafted", draftId: created.id, to: to.email, subject, body, threaded, attachedLineCard: attachments.length > 0, warnings, scheduledFor, meme: opts.template && threaded ? opts.template.meme?.name ?? null : null };
}
