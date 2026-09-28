import { lineCardAttachments, type Deps } from "./assistant.js";
import { stripDashes } from "./benchmark.js";
import { transcriptText, type CloseClient, type LeadEmail } from "./close.js";
import { config } from "./config.js";
import { loadLeadContext, renderContext, type LeadContext } from "./context.js";
import { isoWithOffset, localParts, nextWeekdayAt, zonedTime } from "./rules.js";
import { FollowUpSchema, type FollowUp } from "./schemas.js";
import { logRejection, retryNote, ruleChecks, type Failure } from "./validate.js";

// "Write a follow-up" (Walt 9/25): one tap drafts a short bump in Close.
// It replies in the lead's existing thread when there is one (only a lead with
// no emails gets a new thread), resurfaces the original, and never sends.

export class FollowUpError extends Error {}

export type FollowUpResult =
  | { status: "warn"; warning: string }
  | { status: "drafted"; draftId: string; to: string; subject: string; body: string; threaded: boolean; attachedLineCard: boolean; warnings: string[]; scheduledFor: string | null };

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

/** Weekdays between two instants in the rep's time zone (0 = same business day). */
export function businessDaysBetween(from: Date, to: Date, tz: string): number {
  const day = (d: Date) => { const p = localParts(d, tz); return Date.UTC(p.year, p.month - 1, p.day); };
  let n = 0;
  for (let t = day(from) + 864e5; t <= day(to); t += 864e5) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

const SENTENCES = (body: string, rep: string) => {
  const lines = body.trim().split(/\n\s*\n/);
  // Greeting, the thanks line, and the signature don't count toward the 2–4.
  const core = lines.filter((l, i) => !(i === 0 && /^(hi|hello|hey|good (morning|afternoon))\b/i.test(l)) && !/^thanks\b/i.test(l.trim()) && l.trim() !== rep);
  return core.join(" ").split(/(?<=[.!?])\s+(?=[A-Z"'])/).filter((s) => s.trim()).length;
};

function withSignature(body: string, rep: string) {
  const b = stripDashes(body).trim().replace(/\n{3,}/g, "\n\n");
  return b.endsWith(rep) ? b : `${b}\n\n${rep}`;
}

function threadText(emails: LeadEmail[]) {
  return emails.slice(0, 3).map((e) => [
    `--- ${e.direction === "incoming" ? "FROM THE PROSPECT" : "FROM US"} · ${when(e).slice(0, 10)} · ${e.subject ?? "(no subject)"}`,
    (e.body_text ?? "").trim().slice(0, 1200),
  ].join("\n")).join("\n\n");
}

/** Who the follow-up goes to: the other side of the latest email, else the last called contact, else the buyer on file. */
function recipient(ctx: LeadContext, latest: LeadEmail | undefined, repEmail: string) {
  const byEmail = (addr: string) => ctx.contacts.find((c) => c.emails.some((x) => x.email.toLowerCase() === addr.toLowerCase()));
  if (latest) {
    const addr = latest.direction === "incoming" ? emailOf(latest.sender) : (latest.to ?? []).map(emailOf).find((a) => a && a.toLowerCase() !== repEmail.toLowerCase());
    if (addr) { const c = byEmail(addr); return { email: addr, name: c?.name ?? null, contactId: c?.id ?? latest.contact_id ?? null }; }
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

export async function writeFollowUp(d: Deps, leadId: string, opts: { force?: boolean; schedule?: { stagger: number } } = {}): Promise<FollowUpResult> {
  const now = d.now?.() ?? new Date();
  const [ctx, all] = await Promise.all([loadLeadContext(d.close as CloseClient, leadId, now), d.close.leadEmails(leadId)]);
  if (ctx.facts.vendor || ctx.facts.competitorHits.length) throw new FollowUpError("This lead is a vendor or competitor. No follow-up.");

  const emails = all.filter((e) => REAL.has(e.status)).sort((a, b) => when(b).localeCompare(when(a)));
  const latest = emails[0];
  const lastOut = emails.find((e) => e.direction === "outgoing");

  // Guardrail: emailed under 3 business days ago with no reply or call since.
  if (lastOut && !opts.force) {
    const sentAt = new Date(when(lastOut));
    const replied = emails.some((e) => e.direction === "incoming" && when(e) > when(lastOut));
    const calledSince = ctx.calls.some((c) => c.direction === "outbound" && c.date_created > when(lastOut));
    const days = businessDaysBetween(sentAt, now, d.rep.timeZone);
    if (days < 3 && !replied && !calledSince) {
      const ago = days === 0 ? "earlier today" : `${days} business day${days === 1 ? "" : "s"} ago`;
      return { status: "warn", warning: `You emailed them ${ago} with no reply or call since. Send anyway?` };
    }
  }

  const to = recipient(ctx, latest, d.rep.email);
  if (!to) throw new FollowUpError("There's no email address on this lead to follow up with.");
  const threaded = Boolean(latest);
  const baseSubject = (latest?.subject ?? "").replace(/^(re:\s*)+/i, "");
  const subject = threaded ? `Re: ${baseSubject || "Westgate Supply"}` : "Westgate Supply – line card";
  const displayName = to.name ?? nameFromEmail(to.email);
  const first = displayName.split(/\s+/)[0] || null;
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
  for (let attempt = 1; attempt <= 2; attempt++) {
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
  const scheduledFor = opts.schedule ? sendSlot(ctx.facts.prospectTz ?? d.rep.timeZone, now, opts.schedule.stagger) : null;
  const created = await d.close.createDraftEmail(leadId, {
    contactId: to.contactId, to: [to.email], subject, body, attachments,
    sender: d.rep.sender ?? `"${d.rep.name.replaceAll('"', "")}" <${d.rep.email}>`, emailAccountId: d.rep.emailAccountId ?? null,
    inReplyToId: latest?.id ?? null, threadId: latest?.thread_id ?? null, scheduleAt: scheduledFor,
  });
  return { status: "drafted", draftId: created.id, to: to.email, subject, body, threaded, attachedLineCard: attachments.length > 0, warnings, scheduledFor };
}
