import { classifyOpen, lineCardAttachments, type Deps } from "./assistant.js";
import { stripDashes } from "./benchmark.js";
import { INTRO_SUBJECT } from "./validate.js";

// "Send line card now" (Walt 9/26): on the call screen, the line card email is ready the moment the
// buyer says "send it over", so it goes out while they're still on the phone and the rep can ask for the
// "got it" right then. The after-call step then skips its own line card draft for that call.

export class LineCardError extends Error {}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);

/** "renee.smith@x.com" → "Renee"; "purchasing@x.com" → null. */
export function nameFromEmail(addr: string): string | null {
  const local = addr.split("@")[0];
  const parts = local.split(/[._-]/);
  const w = parts[0];
  if (!/^[a-z]{2,}$/i.test(w) || /^(info|sales|purchasing|office|admin|orders|accounts|ap|contact|hello|team|main|service|support)$/i.test(w)) return null;
  // "renee.smith" → Renee; "tammy" → Tammy; but not "waltboxwell", "jkristo", "cmoreno" (first+last run together).
  if (parts.length > 1) return cap(w);
  return w.length >= 3 && w.length <= 7 && !/^[^aeiouy]{2}/i.test(w) ? cap(w) : null;
}

function joinList(xs: string[]) {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** The bump: they already have the line card, this just puts the thread back on top. */
export function bumpBody(first: string | null, rep: string) {
  return stripDashes([
    `Hi ${first ?? "there"}!`,
    "Just bumping this back to the top of your inbox. The line card is in my email below.",
    "Mind replying \"got it\" so I know it came through?",
    rep,
  ].join("\n\n"));
}

/** Who it goes to (the contact to ask for, else the first one with an email) and the email itself. */
export async function lineCardFor(d: Deps, leadId: string, opts: { to?: string | null; askFor?: string | null; buys?: string[] } = {}) {
  const lead = await d.close.lead(leadId);
  const withEmail = lead.contacts.filter((c) => c.emails.length);
  const byName = opts.askFor ? withEmail.find((c) => c.name.toLowerCase().split(/\s+/)[0] === opts.askFor!.toLowerCase().split(/\s+/)[0]) : undefined;
  const contact = opts.to
    ? withEmail.find((c) => c.emails.some((e) => e.email.toLowerCase() === opts.to!.toLowerCase()))
    : byName ?? withEmail.find((c) => /purchas|buyer|procure/i.test(c.title ?? "")) ?? withEmail[0];
  const to = (opts.to ?? contact?.emails[0]?.email ?? "").trim();
  // Greet the person: the contact with that email, else who you asked for (even with no email on file yet).
  const asked = opts.askFor ? lead.contacts.find((c) => c.name.toLowerCase().split(/\s+/)[0] === opts.askFor!.toLowerCase().split(/\s+/)[0]) : undefined;
  const person = [contact?.name, asked?.name, opts.askFor].find((n) => n && !/main|office|front desk|reception|purchasing|whoever/i.test(n));
  const first = person ? person.split(/\s+/)[0] : to ? nameFromEmail(to) : null;
  const buys = (opts.buys ?? []).slice(0, 4).map((b) => b.replace(/\s*\(.*?\)\s*/g, " ").trim()).filter(Boolean);

  // Already emailed them? Then this is a reply in that thread, so it stacks under the first one (Walt 9/26).
  const emails = await d.close.leadEmails(leadId).catch(() => []);
  const when = (e: { date_sent?: string | null; date_created?: string | null }) => e.date_sent ?? e.date_created ?? "";
  const sentTo = (e: { to?: string[] | null }) => (e.to ?? []).some((a) => a.toLowerCase().includes(to.toLowerCase()));
  const ours = emails.filter((e) => e.direction === "outgoing" && ["sent", "outbox"].includes(e.status)).sort((a, b) => when(b).localeCompare(when(a)));
  const prior = (to ? ours.find(sentTo) : undefined) ?? ours[0];
  const priorCards = ours.filter((e) => (e.attachments ?? []).some((a) => /line.?card/i.test(a.filename ?? "")) && (!to || sentTo(e)));
  const lastCard = priorCards[0];
  const cardOpened = lastCard ? (lastCard.opens ?? []).filter((o) => o.opened_by && !/@westgatesupply\.com$/i.test(o.opened_by)).some((o) => classifyOpen(o, when(lastCard)) === "person") : false;
  const base = (prior?.subject ?? "").replace(/^(re:\s*)+/i, "").trim();
  const subject = prior ? `Re: ${base || INTRO_SUBJECT}` : INTRO_SUBJECT;

  // They already have the line card: a short bump in the same thread, no attachment (Walt 9/26).
  // The first email, with the card, sits right under it.
  if (lastCard && prior) {
    return {
      to, name: contact?.name ?? asked?.name ?? first, contactId: contact?.id ?? asked?.id ?? null, subject, attach: false,
      body: bumpBody(first, d.rep.name),
      reply: { id: prior.id, threadId: prior.thread_id ?? null, subject: prior.subject ?? "" },
      alreadySent: { at: when(lastCard), opened: cardOpened },
    };
  }
  const body = stripDashes([
    `Hi ${first ?? "there"},`,
    "Great talking just now. Here's our line card (attached), as promised.",
    buys.length ? `For a shop like yours we can cover ${joinList(buys.map((b) => (/^[A-Z][a-z]/.test(b) ? b.charAt(0).toLowerCase() + b.slice(1) : b)))}, and a lot more on the card.` : "",
    "Mind replying \"got it\" when this comes through? Just want to make sure it didn't land in junk.",
    "Whenever you've got an RFQ or a materials list, just reply here with it and I'll get pricing back to you fast.",
    d.rep.name,
  ].filter(Boolean).join("\n\n"));
  return {
    to, name: contact?.name ?? asked?.name ?? first, contactId: contact?.id ?? asked?.id ?? null, subject, body, attach: true,
    reply: prior ? { id: prior.id, threadId: prior.thread_id ?? null, subject: prior.subject ?? "" } : null,
    alreadySent: lastCard ? { at: when(lastCard), opened: cardOpened } : null,
  };
}

/** Send it now: one email, to the address the rep confirmed on the call, line card attached. */
export async function sendLineCard(d: Deps, leadId: string, req: { to: string; askFor?: string | null; buys?: string[] }) {
  const to = req.to.trim();
  if (!EMAIL.test(to)) throw new LineCardError(`"${to}" doesn't look like an email address.`);
  const email = await lineCardFor(d, leadId, { to, askFor: req.askFor, buys: req.buys });
  const attachments = email.attach ? await lineCardAttachments(d).catch(() => []) : [];
  if (email.attach && !attachments.length) throw new LineCardError("Couldn't load the line card PDF from Close, so nothing was sent. Try again, or send it from Close.");
  const draft = await d.close.createDraftEmail(leadId, {
    contactId: email.contactId, to: [to], subject: email.subject, body: email.body, attachments,
    sender: d.rep.sender ?? null, emailAccountId: d.rep.emailAccountId ?? null,
    inReplyToId: email.reply?.id ?? null, threadId: email.reply?.threadId ?? null,
  });
  await d.close.sendDraft(draft.id);
  console.info(`${new Date().toISOString()} [line card ${leadId}] sent to ${to} (${draft.id})`);
  return { sent: true, id: draft.id, to, at: new Date().toISOString(), threaded: !!email.reply };
}
