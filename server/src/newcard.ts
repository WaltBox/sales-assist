import { rfqByStatus } from "./accounts.js";
import { lineCardAttachments, type Deps } from "./assistant.js";
import { coolingFor, dailyCapFor, REPLY_COOLDOWN_DAYS } from "./automations.js";
import type { LeadEmail } from "./close.js";
import { config } from "./config.js";
import { loadLeadContext } from "./context.js";
import { recipient, sendSlot } from "./followup.js";
import { bumpHtml, clearPick, linkUrl, memeFor, memesFor, memesSeen, newToken, trackingOn, trackMeme, type Meme } from "./memes.js";
import { isOutStatus, localParts } from "./rules.js";
import { store, type Automation } from "./store.js";

/**
 * "New line card!" (Walt 10/28): one new email to every company that only ever got the old line card, from whoever
 * sent them a line card most recently (Walt, Chase or Liam), in a new thread with the new PDF and a meme. Walt is
 * CC'd on the ones he doesn't send. Each rep's share goes out on their mornings at their usual daily pace, and the
 * sequence's own emails fill in behind it. Anyone who's sent an RFQ, said no, is cooling off, wrote back in the
 * last week and a half, or already got the new card is left out.
 */
export const NEW_CARD_SUBJECT = "New line card!";
/** Who sends: whoever of these most recently sent the company a line card. (Not Ulysses or Jacob, Walt 10/28.) */
export const NEW_CARD_SENDERS = ["walt@westgatesupply.com", "chase@westgatesupply.com", "liam@westgatesupply.com"];
/** When the new PDF went on the template: a line card sent after this is the new one. */
export const NEW_CARD_SINCE = "2026-10-27T18:00:00Z";
const PLAN_KEY = "newCardPlan";
const DAY = 86_400_000;

export type NewCardPlan = {
  builtAt: string; since: string;
  leads: Array<{ leadId: string; company: string; repId: string; repName: string; lastCardAt: string }>;
  /** What happened to each lead: sent (the email id), or why it was skipped. */
  done: Record<string, { at: string; repId: string; emailId?: string; skipped?: string }>;
};

const isCard = (e: { attachments?: Array<{ filename?: string | null }> | null }) => (e.attachments ?? []).some((a) => /line.?card/i.test(a.filename ?? ""));
const at = (e: { date_sent?: string | null; date_created?: string | null }) => String(e.date_sent ?? e.date_created ?? "");

export async function newCardPlan(): Promise<NewCardPlan | null> {
  return store.getSetting<NewCardPlan>("team", PLAN_KEY).catch(() => null);
}

/**
 * Build the list: every company whose most recent line card (before the new one existed) came from one of the
 * senders, and who hasn't had a line card since. Read once with the owner's login, which sees the whole team's email.
 */
export async function planNewCard(owner: Deps, senders: Deps[], opts: { since?: string } = {}): Promise<NewCardPlan> {
  const since = opts.since ?? NEW_CARD_SINCE;
  const mails = await owner.close.listSince<Record<string, unknown>>("email", {
    since: "2026-08-01T00:00:00Z", max: 12_000, fields: "id,lead_id,user_id,direction,status,date_sent,date_created,attachments",
  });
  const cards = mails.filter((e) => e.direction === "outgoing" && e.status === "sent" && isCard(e as never));
  const latest = new Map<string, Record<string, unknown>>();
  const hasNew = new Set<string>();
  for (const e of cards) {
    const lead = String(e.lead_id);
    if (at(e as never) >= since) { hasNew.add(lead); continue; }
    if (!latest.has(lead) || at(e as never) > at(latest.get(lead)! as never)) latest.set(lead, e);
  }
  const byUser = new Map(senders.map((s) => [s.rep.closeUserId, s]));
  const names = new Map<string, string>();
  const leads: NewCardPlan["leads"] = [];
  for (const [leadId, e] of latest) {
    if (hasNew.has(leadId)) continue;
    const s = byUser.get(String(e.user_id));
    if (!s) continue;
    if (!names.has(leadId)) names.set(leadId, ((await owner.close.lead(leadId).catch(() => null)) as { display_name?: string } | null)?.display_name ?? "An account");
    leads.push({ leadId, company: names.get(leadId)!, repId: s.rep.closeUserId, repName: s.rep.name, lastCardAt: at(e as never) });
  }
  const old = await newCardPlan();
  const plan: NewCardPlan = { builtAt: new Date().toISOString(), since, leads: leads.sort((a, b) => a.lastCardAt.localeCompare(b.lastCardAt)), done: old?.done ?? {} };
  await store.putSetting("team", PLAN_KEY, plan);
  return plan;
}

/** The plan by rep: how many waiting, sent, skipped. */
export function newCardSummary(plan: NewCardPlan | null) {
  if (!plan) return null;
  const reps = new Map<string, { repId: string; name: string; waiting: number; sent: number; skipped: number }>();
  for (const l of plan.leads) {
    const r = reps.get(l.repId) ?? { repId: l.repId, name: l.repName, waiting: 0, sent: 0, skipped: 0 };
    const d = plan.done[l.leadId];
    if (!d) r.waiting++; else if (d.emailId) r.sent++; else r.skipped++;
    reps.set(l.repId, r);
  }
  return { builtAt: plan.builtAt, subject: NEW_CARD_SUBJECT, total: plan.leads.length, reps: [...reps.values()] };
}

const body = (first: string | null, repName: string, cardUrl: string | null) => [
  first ? `Hi ${first}!` : "Hi!",
  `We just redid our line card. New look, and it covers more of what we stock now. It's attached${cardUrl ? `, or you can grab it here: ${cardUrl}` : ""}.`,
  "If you've got anything you're pricing out, send it over and I'll quote it.",
  repName,
].join("\n\n");

/**
 * Write one "New line card!" email: a new thread to the buyer we've been writing to, the new PDF and a meme attached,
 * scheduled for a morning slot their time. Walt is CC'd when he isn't the sender.
 */
export async function writeNewCard(d: Deps, leadId: string, opts: { meme: Meme | null; stagger: number }) {
  const now = d.now?.() ?? new Date();
  const [ctx, all] = await Promise.all([loadLeadContext(d.close as never, leadId, now), d.close.leadEmails(leadId)]);
  const emails = all.filter((e) => ["sent", "inbox"].includes(String(e.status))).sort((a, b) => at(b).localeCompare(at(a)));
  const ours = (a: string | null | undefined) => !a || /@westgatesupply\.com$/i.test(a);
  const emailOf = (s: string | null | undefined) => (s ?? "").match(/<([^>]+)>/)?.[1] ?? (s ?? "").trim();
  const latest = emails.find((e: LeadEmail) => [emailOf(e.sender), ...(e.to ?? []).map(emailOf)].some((a) => !ours(a)));
  const to = recipient(ctx, latest, d.rep.email, emails);
  if (!to) throw new Error("No email address on this lead.");
  if (/@westgatesupply\.com$/i.test(to.email)) throw new Error(`Addressed to ${to.email}, a Westgate address.`);
  const first = greet(to.name) ?? greet(to.email.split("@")[0].replace(/[._-]+/g, " "));
  const tz = ctx.facts.prospectTz ?? d.rep.timeZone;
  const scheduledFor = sendSlot(tz, now, opts.stagger);
  const token = opts.meme || trackingOn() ? newToken() : null;
  const text = body(first, d.rep.name, token && trackingOn() ? linkUrl(token, "card") : null);
  const attachments = await lineCardAttachments(d).catch(() => []);
  if (!attachments.length) throw new Error("The line card isn't attached.");
  const cc = d.rep.email.toLowerCase() === config.ownerEmail ? null : [config.ownerEmail];
  const created = await d.close.createDraftEmail(leadId, {
    contactId: to.contactId, to: [to.email], subject: NEW_CARD_SUBJECT, body: text, attachments,
    sender: d.rep.sender ?? `"${d.rep.name.replaceAll('"', "")}" <${d.rep.email}>`, emailAccountId: d.rep.emailAccountId ?? null,
    scheduleAt: scheduledFor, html: bumpHtml(text, d.rep.name, opts.meme, token), cc,
  });
  if (token) await trackMeme({ token, repId: d.rep.closeUserId, repName: d.rep.name, repEmail: d.rep.email, leadId, meme: opts.meme?.name ?? "", emailId: created.id });
  return { draftId: created.id, to: to.email, body: text, scheduledFor, meme: opts.meme?.name ?? null, track: token, cc };
}

const greet = (name: string | null | undefined) => {
  const w = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[a-z][a-z'-]{1,}$/i.test(w) && !/^(info|sales|office|purchasing|admin|hello|contact|team)$/i.test(w) ? w[0].toUpperCase() + w.slice(1) : null;
};

/**
 * This rep's share for today: up to their daily pace (minus anything already planned today), each checked against
 * Close first. Runs from the morning job once a day per rep, or by hand from the page.
 */
export async function sendNewCard(d: Deps, opts: { max?: number } = {}) {
  const now = d.now?.() ?? new Date();
  const plan = await newCardPlan();
  if (!plan) return { planned: [] as Automation[], skipped: [] as Array<{ company: string; why: string }>, reason: "No new line card wave is planned." };
  const mine = plan.leads.filter((l) => l.repId === d.rep.closeUserId && !plan.done[l.leadId]);
  if (!mine.length) return { planned: [], skipped: [], reason: "Nothing waiting for you." };
  const today = localParts(now, d.rep.timeZone);
  const dayKey = `${today.year}-${today.month}-${today.day}`;
  const recent = await store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - DAY).toISOString());
  const plannedToday = recent.filter((a) => { const p = localParts(new Date(a.createdAt), d.rep.timeZone); return `${p.year}-${p.month}-${p.day}` === dayKey && a.status !== "failed"; }).length;
  const room = Math.max(0, Math.min(opts.max ?? Infinity, (await dailyCapFor(d)) - plannedToday));
  const planned: Automation[] = [];
  const skipped: Array<{ company: string; why: string }> = [];
  if (!room) return { planned, skipped, reason: "Today's emails are already at your pace. The rest go tomorrow." };
  const memes = await memesFor(d).catch(() => [] as Meme[]);
  const seen = await memesSeen(d);
  const picks = (await store.getSetting<Record<string, string | null>>(d.rep.closeUserId, "memePicks").catch(() => null)) ?? {};
  const finish = async (leadId: string, r: NewCardPlan["done"][string]) => { plan.done[leadId] = r; await store.putSetting("team", PLAN_KEY, plan); };
  for (const l of mine) {
    if (planned.length >= room) break;
    const base = { repId: d.rep.closeUserId, leadId: l.leadId, company: l.company, kind: "bump" as const, label: "New line card", reason: "The new line card, to everyone who only had the old one.", createdAt: now.toISOString(), checkedAt: null };
    try {
      const lead = (await d.close.lead(l.leadId).catch(() => null)) as { status_label?: string } | null;
      const mails = await d.close.leadEmails(l.leadId).catch(() => [] as LeadEmail[]);
      const why = !lead ? "Not in Close any more"
        : isOutStatus(lead.status_label) ? `${lead.status_label} in Close`
        : rfqByStatus(lead.status_label) ? "They've sent an RFQ"
        : (await coolingFor(d, l.leadId)) ? "Cooling off"
        : mails.some((e) => e.direction === "outgoing" && at(e) >= plan.since && isCard(e)) ? "Already has the new card"
        : mails.some((e) => e.direction === "incoming" && now.getTime() - Date.parse(at(e)) < REPLY_COOLDOWN_DAYS * DAY) ? "Wrote back in the last week and a half"
        : null;
      if (why) { skipped.push({ company: l.company, why }); await finish(l.leadId, { at: now.toISOString(), repId: d.rep.closeUserId, skipped: why }); continue; }
      const meme = await memeFor(d, l.leadId, { memes, seen, picks });
      const r = await writeNewCard(d, l.leadId, { meme, stagger: planned.length });
      const row: Automation = { ...base, id: r.draftId, to: r.to, subject: NEW_CARD_SUBJECT, body: r.body, scheduledFor: r.scheduledFor, status: "scheduled", statusAt: now.toISOString(), note: r.cc ? `CC ${r.cc.join(", ")}` : null, meme: r.meme, track: r.track, variant: "newcard", arm: null };
      await store.putAutomation(row);
      if (r.meme) { seen.set(l.leadId, (seen.get(l.leadId) ?? new Set()).add(r.meme)); delete picks[l.leadId]; await clearPick(d, l.leadId); }
      await finish(l.leadId, { at: now.toISOString(), repId: d.rep.closeUserId, emailId: r.draftId });
      planned.push(row);
    } catch (err) {
      const why = (err as Error).message;
      skipped.push({ company: l.company, why });
      await store.putAutomation({ ...base, id: `failed_newcard_${l.leadId}_${now.getTime()}`, to: "", subject: NEW_CARD_SUBJECT, scheduledFor: null, status: "failed", statusAt: now.toISOString(), note: why });
      await finish(l.leadId, { at: now.toISOString(), repId: d.rep.closeUserId, skipped: why });
    }
  }
  return { planned, skipped, reason: null as string | null };
}

/** The morning job: this rep's share, once a weekday, whichever server copy gets there first. */
export async function newCardMorning(d: Deps) {
  const now = d.now?.() ?? new Date();
  const p = localParts(now, d.rep.timeZone);
  if (p.weekday === 0 || p.weekday === 6 || p.hour < 3) return null;
  const plan = await newCardPlan();
  if (!plan || !plan.leads.some((l) => l.repId === d.rep.closeUserId && !plan.done[l.leadId])) return null;
  const day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  if (!(await store.once(`newcard:${d.rep.closeUserId}:${day}`, 20 * 3600 * 1000))) return null;
  return sendNewCard(d);
}
