import { promises as dns } from "node:dns";
import { advanceStatus, isBounce } from "./accounts.js";
import { siteEmails } from "./website.js";
import { classifyOpen, lineCardAttachments, type Deps } from "./assistant.js";
import { stripDashes } from "./benchmark.js";
import { INTRO_SUBJECT } from "./validate.js";
import { bumpHtml, memeFor, rememberMeme, type Meme } from "./memes.js";

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
  // "renee.smith" → Renee. A single word only when it's a common first name ("tammy" → Tammy): "bobeso" is
  // B. Obeso, not Bobeso (Walt 9/29), and "jkristo", "cmoreno", "waltboxwell" are initials or names run together.
  if (parts.length > 1) return cap(w);
  return FIRST_NAMES.has(w.toLowerCase()) ? cap(w) : null;
}

const FIRST_NAMES = new Set(`aaron adam adrian alan albert alex alexa alexander alexis alice alicia allen allison alma amanda amber amy ana andre andrea andrew andy angel angela angie anita ann anna anne annie anthony antonio april arthur ashley audrey austin barbara barry becky ben benjamin beth betty beverly bill billy bob bobby bonnie brad bradley brandon brenda brent brett brian brittany brooke bruce bryan bud caleb carl carla carlos carmen carol caroline carolyn carrie casey cassie catherine cathy chad charles charlie chelsea cheryl chris christian christina christine christopher chuck cindy claire clara clay cody colby cole colleen colton connie corbin corey courtney craig crystal curtis cynthia dale damon dan dana daniel danielle danny darlene darren dave david dawn dean debbie deborah debra denise dennis derek diana diane don donald donna doris doug douglas drew dustin dylan ed eddie edgar edward eileen elaine eli elijah elizabeth ellen emily emma eric erica erik erin ethan eugene eva evan faith frances frank fred gabriel gail gary gavin gene george gerald gina glen glenn gloria grace greg gregory hannah harold harry heather heidi helen henry holly howard hunter ian isaac jack jackie jacob jacqueline jaime jake james jamie jan jane janet janice jared jason javier jay jean jeff jeffrey jen jenna jennifer jenny jeremy jerry jesse jessica jesus jill jim jimmy jo joan joanne joe joel john johnny jon jonathan jordan jorge jose joseph josh joshua joy joyce juan judith judy julia julie justin karen kari karl kate katherine kathleen kathy katie kay keith kelly kelsey ken kendra kenneth kevin kim kimberly kristen kristin kristy kurt kyle lance larry laura lauren leah lee leo leslie linda lisa logan lori louis lucas luis luke lynn madison marc marcus margaret maria marie marilyn mario mark marsha martha martin marty mary matt matthew maureen max mayra megan melanie melissa michael michele michelle mike miguel mindy misty mitch molly monica morgan nancy natalie nathan neil nicholas nick nicole noah norma oscar pam pamela pat patricia patrick paul paula peggy pete peter phil philip phillip rachel ralph randy ray raymond rebecca regina renee rhonda ricardo rich richard rick ricky rob robert roberto robin rod rodney roger ron ronald rosa rose roy ruben russell ruth ryan sally sam samantha samuel sandra sandy sara sarah scott sean seth shane shannon sharon shawn sheila shelby sherry shirley stacey stacy stan stephanie stephen steve steven sue susan suzanne sylvia tamara tammy tanya tara ted teresa terri terry theresa thomas tiffany tim timothy tina todd tom tommy toni tony tracy travis trevor troy tyler valerie vanessa veronica vicki vickie victor victoria vincent virginia walt walter wanda wayne wendy wesley william willie yolanda zach zachary`.split(/\s+/));

// Typed on the call, so typos happen: "hall@gatewayspecific.com" for gatewaypacific.com bounced (Walt 9/28).
// Before it goes: does that domain take email at all, and does it match their website?
export const mailDns = { resolveMx: dns.resolveMx, resolve4: dns.resolve4 };
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|aol|icloud|me|mac|comcast|att|sbcglobal|verizon|cox|charter|bellsouth|protonmail|proton)\./i;
const siteDomain = (url: string | null | undefined) => {
  try { return url ? new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, "").toLowerCase() : null; } catch { return null; }
};
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms).unref())]);

/** false only when we're sure the domain can't get mail (it doesn't exist); DNS hiccups never block a send. */
export async function domainTakesMail(domain: string): Promise<boolean> {
  try {
    await withTimeout(mailDns.resolveMx(domain), 3000);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND") return false; // NXDOMAIN: no such domain
    if (code === "ENODATA") {
      // No MX record: mail falls back to the domain's own address, if it has one.
      try { return (await withTimeout(mailDns.resolve4(domain), 3000)).length > 0; } catch (e2) { return (e2 as { code?: string }).code !== "ENOTFOUND" && (e2 as { code?: string }).code !== "ENODATA"; }
    }
    return true;
  }
}

/** Letters-apart count, for "gatewayspecific" vs "gatewaypacific". */
function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) { const t = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return row[b.length];
}

export type AddressCheck = { problem: "no_domain" | "not_their_domain" | null; message: string | null; suggestion: string | null };

export async function checkAddress(to: string, website: string | null | undefined): Promise<AddressCheck> {
  const ok: AddressCheck = { problem: null, message: null, suggestion: null };
  if (!EMAIL.test(to)) return ok;
  const [local, domain] = [to.slice(0, to.lastIndexOf("@")), to.slice(to.lastIndexOf("@") + 1).toLowerCase()];
  const site = siteDomain(website);
  // Close to their website's domain but not it: almost always a typo.
  const near = site && site !== domain && !FREE_MAIL.test(domain) && !domain.endsWith(`.${site}`)
    && editDistance(domain.split(".")[0], site.split(".")[0]) <= Math.max(2, Math.floor(site.length / 4));
  const suggestion = near ? `${local}@${site}` : null;
  if (!(await domainTakesMail(domain))) {
    return { problem: "no_domain", message: `${domain} doesn't exist, so this would bounce.${suggestion ? ` Their website is ${site}.` : " Check the spelling."}`, suggestion };
  }
  if (suggestion) return { problem: "not_their_domain", message: `Their website is ${site}. Did you mean ${suggestion}?`, suggestion };
  return ok;
}

/** Did the line card we just sent bounce back? Mail servers answer within a minute or two. */
export async function lineCardBounce(d: Deps, leadId: string, to: string, since: string) {
  const emails = await d.close.leadEmails(leadId).catch(() => []);
  const bounce = emails.find((e) => e.direction === "incoming" && isBounce(e) && (e.date_sent ?? e.date_created ?? "") >= since
    && (!e.body_text || e.body_text.toLowerCase().includes(to.toLowerCase())));
  if (!bounce) return { bounced: false as const };
  const t = bounce.body_text ?? "";
  const reason = /couldn't be found|domain name not found|nxdomain/i.test(t) ? "That domain doesn't exist."
    : /wasn't found|was not found|doesn't exist|does not exist|no such user|user unknown|address not found|recipient not found|5\.1\.1/i.test(t) ? "That mailbox doesn't exist."
    : /blocked|rejected|spam|policy/i.test(t) ? "Their mail server blocked it." : "Their mail server sent it back.";
  return { bounced: true as const, at: bounce.date_sent ?? bounce.date_created ?? null, reason };
}

/** The bump: they already have the line card, this just puts the thread back on top. */
export function bumpBody(first: string | null, rep: string) {
  return stripDashes([
    `Hi ${first ?? "there"},`,
    "I wanted to make sure this reached you. The line card is in my email below.",
    "Mind replying \"got it\" so I know it came through?",
    rep,
  ].join("\n\n"));
}

/** Who it goes to (the contact to ask for, else the first one with an email) and the email itself. */
export async function lineCardFor(d: Deps, leadId: string, opts: { to?: string | null; name?: string | null; referredBy?: string | null; askFor?: string | null; buys?: string[]; cold?: boolean; meme?: Meme | null } = {}) {
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
  // A name typed on the call screen wins (Walt 9/28: "sometimes we need to change the name").
  const typed = opts.name?.trim() || null;
  const first = typed ? typed.split(/\s+/)[0] : person ? person.split(/\s+/)[0] : to ? nameFromEmail(to) : null;
  // Only guessed from the address ("renee.smith@"): the side panel asks the rep to check it before sending.
  const nameGuessed = !typed && !person && !!first;
  const check = to ? await checkAddress(to, lead.url) : { problem: null, message: null, suggestion: null };
  // Addresses to pick from: every contact's email, then the ones on their website (DMG 9/29: none in Close, two on the site).
  const onFile = lead.contacts.flatMap((c) => c.emails.map((e) => ({ email: e.email.toLowerCase(), name: /main|office|front desk|reception/i.test(c.name) ? null : c.name })));
  // Only when Close has no address at all: it's a network read of their site.
  const fromSite = (onFile.length ? [] : await (d.siteEmails ?? siteEmails)(lead.url).catch(() => [])).filter((e) => !onFile.some((o) => o.email === e)).map((e) => ({ email: e, name: null, site: true }));
  const suggestions = [...onFile, ...fromSite].slice(0, 6);
  const buys = (opts.buys ?? []).slice(0, 4).map((b) => b.replace(/\s*\(.*?\)\s*/g, " ").trim()).filter(Boolean);

  // Already emailed them? Then this is a reply in that thread, so it stacks under the first one (Walt 9/26).
  const emails = await d.close.leadEmails(leadId).catch(() => []);
  const when = (e: { date_sent?: string | null; date_created?: string | null }) => e.date_sent ?? e.date_created ?? "";
  const sentTo = (e: { to?: string[] | null }) => (e.to ?? []).some((a) => a.toLowerCase().includes(to.toLowerCase()));
  const ours = emails.filter((e) => e.direction === "outgoing" && ["sent", "outbox"].includes(e.status)).sort((a, b) => when(b).localeCompare(when(a)));
  // Only continue a thread with this same person: an email to another (or bounced) address isn't theirs (9/28).
  const prior = to ? ours.find(sentTo) : ours[0];
  const priorCards = ours.filter((e) => (e.attachments ?? []).some((a) => /line.?card/i.test(a.filename ?? "")) && (!to || sentTo(e)));
  const lastCard = priorCards[0];
  const cardOpened = lastCard ? (lastCard.opens ?? []).filter((o) => o.opened_by && !/@westgatesupply\.com$/i.test(o.opened_by)).some((o) => classifyOpen(o, when(lastCard)) === "person") : false;
  const base = (prior?.subject ?? "").replace(/^(re:\s*)+/i, "").trim();
  const subject = prior ? `Re: ${base || INTRO_SUBJECT}` : INTRO_SUBJECT;

  // They already have the line card: a short bump in the same thread, no attachment (Walt 9/26).
  // The first email, with the card, sits right under it.
  if (lastCard && prior) {
    // With a meme, like every other bump (10/2: Todd's went out plain from the call screen).
    const meme = opts.meme !== undefined ? opts.meme : await memeFor(d, leadId).catch(() => null);
    const body = bumpBody(first, d.rep.name);
    return {
      to, name: typed ?? contact?.name ?? asked?.name ?? first, contactId: contact?.id ?? asked?.id ?? null, subject, attach: false, check, suggestions, nameGuessed,
      body, html: meme ? bumpHtml(body, d.rep.name, meme) : null, meme: meme?.name ?? null,
      reply: { id: prior.id, threadId: prior.thread_id ?? null, subject: prior.subject ?? "" },
      alreadySent: { at: when(lastCard), opened: cardOpened },
    };
  }
  // Sent while they're on the phone, so it reads like it was typed on the call (Walt 9/28): short, casual.
  const items = buys.map((b) => (/^[A-Z][a-z]/.test(b) ? b.charAt(0).toLowerCase() + b.slice(1) : b));
  // Emailing someone who wasn't on the call (Colton gave Mykala's address, 9/28): say who sent you.
  const referrer = opts.referredBy?.trim().split(/\s+/)[0] || null;
  const card = items.length ? `Here's our line card. We do ${items.join(", ")}, plus a lot more.` : "Here's our line card.";
  // Sent before or without a conversation (the pre-call screen, 9/29): say who we are first.
  const repFirst = d.rep.name.split(/\s+/)[0];
  const calledToday = opts.cold && (await d.close.calls({ leadId, since: new Date(Date.now() - 12 * 3600e3).toISOString() }).catch(() => [])).some((c) => c.direction === "outbound");
  const intro = opts.cold && !referrer ? `I'm ${repFirst} with Westgate Supply${calledToday ? " and tried you by phone today" : ""}. ` : "";
  const body = stripDashes([
    `Hi ${first ?? "there"},`,
    referrer ? `${referrer} suggested I send this your way. ${card}` : `${intro}${card}`,
    "Shoot me a quick \"got it\" when you see this. Send over an RFQ or a materials list and I'll price it.",
    d.rep.name,
  ].join("\n\n"));
  return {
    // A meme only when the rep picks one in the side panel (10/2), above the name; the PDF is still attached.
    to, name: typed ?? contact?.name ?? asked?.name ?? first, contactId: contact?.id ?? asked?.id ?? null, subject, body,
    html: opts.meme ? bumpHtml(body, d.rep.name, opts.meme) : null as string | null, meme: opts.meme?.name ?? null as string | null, memeUrl: opts.meme?.url ?? null,
    attach: true, check, suggestions, nameGuessed,
    reply: prior ? { id: prior.id, threadId: prior.thread_id ?? null, subject: prior.subject ?? "" } : null,
    alreadySent: lastCard ? { at: when(lastCard), opened: cardOpened } : null,
  };
}

/** Send it now: one email, to the address the rep confirmed on the call, line card attached. */
export async function sendLineCard(d: Deps, leadId: string, req: { to: string; name?: string | null; referredBy?: string | null; askFor?: string | null; buys?: string[]; cold?: boolean; meme?: Meme | null }) {
  const to = req.to.trim();
  if (!EMAIL.test(to)) throw new LineCardError(`"${to}" doesn't look like an email address.`);
  const email = await lineCardFor(d, leadId, { to, name: req.name, referredBy: req.referredBy, askFor: req.askFor, buys: req.buys, cold: req.cold, meme: req.meme });
  // A domain that doesn't exist can only bounce, so don't send it. A near-miss of their website only warns.
  if (email.check.problem === "no_domain") throw new LineCardError(email.check.message ?? "That email domain doesn't exist.");
  // Someone new (Ethan at Titan, 9/29: "send it to me and I'll share it with the PMs"): add them as a contact
  // in Close so the email is filed under them and the next call knows who they are.
  // Filed under whoever already has that address; else the person you asked for, if they had no email and you
  // didn't type someone else's name; else it's a new person (Renee isn't Rob).
  const lead = await d.close.lead(leadId).catch(() => null);
  const owner = lead?.contacts.find((c) => c.emails.some((e) => e.email.toLowerCase() === to.toLowerCase()));
  const asked = lead?.contacts.find((c) => c.id === email.contactId);
  const first = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0].toLowerCase();
  const typedOther = !!req.name?.trim() && !!asked && first(req.name) !== first(asked.name);
  // Or the contact with that first name and no email yet (Cain Chavez, 9/30: "Cain" typed, no second contact).
  const named = req.name?.trim() ? lead?.contacts.find((c) => !c.emails.length && first(c.name) === first(req.name)) : undefined;
  let contactId: string | null = owner?.id ?? (asked && !asked.emails.length && !typedOther && !/main|office|front desk|reception|purchasing/i.test(asked.name) ? asked.id : null) ?? named?.id ?? null;
  // Give that contact the address, so it's on file next time.
  if (contactId && !owner && contactId === (named?.id ?? asked?.id)) await d.close.updateContact(contactId, { emails: [{ email: to, type: "office" }] }).catch(() => null);
  if (!contactId) {
    const name = req.name?.trim() || nameFromEmail(to) || to.split("@")[0];
    contactId = (await d.close.createContact(leadId, { name, title: null, email: to, phone: null }).catch(() => null))?.id ?? null;
  }
  const attachments = email.attach ? await lineCardAttachments(d).catch(() => []) : [];
  if (email.attach && !attachments.length) throw new LineCardError("Couldn't load the line card PDF from Close, so nothing was sent. Try again, or send it from Close.");
  const draft = await d.close.createDraftEmail(leadId, {
    contactId, to: [to], subject: email.subject, body: email.body, html: email.html, attachments,
    sender: d.rep.sender ?? null, emailAccountId: d.rep.emailAccountId ?? null,
    inReplyToId: email.reply?.id ?? null, threadId: email.reply?.threadId ?? null,
  });
  await d.close.sendDraft(draft.id);
  if (email.meme) await rememberMeme(d, leadId, email.meme).catch(() => null);
  // A line card out moves the lead to "Sent Line Card" (forward only).
  if (email.attach) await advanceStatus(d, leadId, "Sent Line Card").catch(() => null);
  console.info(`${new Date().toISOString()} [line card ${leadId}] sent to ${to} (${draft.id})`);
  return { sent: true, id: draft.id, to, at: new Date().toISOString(), threaded: !!email.reply, newContact: !!contactId && contactId !== owner?.id && contactId !== asked?.id && contactId !== named?.id };
}
