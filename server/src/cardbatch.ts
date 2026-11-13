import type { Deps } from "./assistant.js";
import { buyerOf } from "./ladder.js";
import { sendLineCard } from "./linecard.js";
import { memeFor } from "./memes.js";
import { localParts, prospectTimeZone, zonedTime } from "./rules.js";
import { LINE_CARD } from "./stats.js";

/**
 * Line cards to a list of named buyers, spaced out (Walt 11/13: "lets send out some line cards ... Can u have 30 sent
 * out"). Each one is scheduled in Close for its own time inside that buyer's business hours, east first, a few
 * minutes apart, with a meme; Close sends them. A buyer without their own address, or who already has the card, is
 * skipped. dryRun lays out the plan and sends nothing.
 */
export type CardPlan = { leadId: string; company: string; to: string | null; name: string | null; tz: string | null; at: string | null; skip: string | null; id?: string; error?: string };
const GENERIC = /^(info|sales|accounting|accounts|ap|ar|office|main|admin|purchasing|procurement|contact|hello|support|frontdesk|billing|estimating|reception|general|service|orders|shop|quotes?|bids?|inquiries|mail|team)@/i;
const OFFSET: Record<string, number> = { "America/New_York": 0, "America/Detroit": 0, "America/Indiana/Indianapolis": 0, "America/Chicago": 1, "America/Denver": 2, "America/Phoenix": 2, "America/Boise": 2, "America/Los_Angeles": 3 };

export async function cardBatch(d: Deps, leadIds: string[], opts: { dryRun?: boolean; startAt?: string; gapMinutes?: number; perSlot?: number } = {}): Promise<{ plan: CardPlan[]; scheduled: number; skipped: number }> {
  const now = d.now?.() ?? new Date();
  // Two every ten minutes by default (Walt 11/13: "Can these go out in batches? like 1 every 15 mins? Or two every 10?").
  const gap = Math.max(2, Math.min(30, opts.gapMinutes ?? 10)) * 60_000;
  const perSlot = Math.max(1, Math.min(5, opts.perSlot ?? 2));
  let inSlot = 0;
  const plan: CardPlan[] = [];
  for (const leadId of leadIds) {
    const lead = await d.close.lead(leadId).catch(() => null);
    if (!lead) { plan.push({ leadId, company: leadId, to: null, name: null, tz: null, at: null, skip: "lead not found" }); continue; }
    const buyer = buyerOf(lead.contacts);
    const tz = prospectTimeZone(lead.description, lead.addresses?.[0]?.state ?? null) ?? "America/Chicago";
    const base = { leadId, company: lead.display_name, to: buyer?.email ?? null, name: buyer?.name ?? null, tz, at: null };
    if (!buyer) { plan.push({ ...base, skip: "nobody named" }); continue; }
    if (!buyer.email || GENERIC.test(buyer.email)) { plan.push({ ...base, skip: "no address of their own" }); continue; }
    const emails = await d.close.leadEmails(leadId).catch(() => []);
    const had = emails.some((e) => e.direction === "outgoing" && ["sent", "outbox", "scheduled"].includes(e.status) && (e.attachments ?? []).some((a) => a.filename === LINE_CARD) && (e.to ?? []).some((t) => t.toLowerCase().includes(buyer.email!.toLowerCase())));
    if (had) { plan.push({ ...base, skip: "already has the card" }); continue; }
    plan.push({ ...base, skip: null });
  }
  // East first, so the slots run with the clock across the country.
  const go = plan.filter((p) => !p.skip).sort((a, b) => (OFFSET[a.tz ?? ""] ?? 1) - (OFFSET[b.tz ?? ""] ?? 1));
  let t = Math.max(Date.parse(opts.startAt ?? "") || 0, now.getTime() + 10 * 60_000);
  for (const p of go) {
    let at = new Date(t);
    const lp = localParts(at, p.tz!);
    const mins = lp.hour * 60 + lp.minute;
    // Inside 8:30 to 4:30 their time; after that, the next weekday at 8:30 plus the slot's spacing.
    if (mins >= 16 * 60 + 30 || lp.weekday === 0 || lp.weekday === 6) {
      let day = new Date(zonedTime(lp.year, lp.month, lp.day, 12, 0, p.tz!).getTime() + 24 * 3600e3);
      while ([0, 6].includes(localParts(day, p.tz!).weekday)) day = new Date(day.getTime() + 24 * 3600e3);
      const q = localParts(day, p.tz!);
      at = new Date(zonedTime(q.year, q.month, q.day, 8, 30, p.tz!).getTime() + go.indexOf(p) * 60_000);
    } else if (mins < 8 * 60 + 30) {
      at = zonedTime(lp.year, lp.month, lp.day, 8, 30, p.tz!);
    } else if (++inSlot >= perSlot) { t += gap; inSlot = 0; }
    p.at = at.toISOString();
  }
  if (!opts.dryRun) {
    for (const p of go) {
      try {
        const meme = await memeFor(d, p.leadId).catch(() => null);
        const r = await sendLineCard(d, p.leadId, { to: p.to!, name: p.name, cold: true, meme, scheduleAt: p.at });
        p.id = r.id;
      } catch (err) { p.error = (err as Error).message; }
    }
  }
  return { plan, scheduled: opts.dryRun ? 0 : go.filter((p) => p.id).length, skipped: plan.filter((p) => p.skip).length };
}
