import type { Deps } from "./assistant.js";
import { forgetBoard } from "./accounts.js";
import { dropRescueDraft, stopScheduledFor } from "./automations.js";
import { ownerFieldId } from "./myleads.js";
import { store } from "./store.js";

/**
 * Hand-off (Walt 10/28: "I need to hand them over to Chase"): a whole heat map moves from one rep to another in one
 * go. The accounts leave the first rep's board and automatic emails (anything scheduled is pulled back, the unsent
 * rescue draft goes) and show on the second rep's board with their line card, heat and history, as if they'd sent
 * the card. Lead owner in Close becomes the new rep. The new rep's automatic emails start after their first email to
 * the account, never as a reply inside the old rep's thread. The new line card wave is separate: it still goes from
 * whoever sent the last card.
 */
export type Handoff = { from: string; fromName: string; to: string; toName: string; at: string };
const KEY = "handoffs";

export async function handoffs(): Promise<Record<string, Handoff>> {
  return (await store.getSetting<Record<string, Handoff>>("team", KEY).catch(() => null)) ?? {};
}

/**
 * Standing rules (Walt 10/29: "make sure my heat map always goes to him"): every account one rep's line cards create
 * belongs to another rep, from now on. Keyed by the sending rep's Close user id; the value is who gets them.
 */
export type HandoffRules = Record<string, { to: string; toName: string; fromName: string; since: string }>;
const RULES_KEY = "handoffRules";
export async function handoffRules(): Promise<HandoffRules> {
  return (await store.getSetting<HandoffRules>("team", RULES_KEY).catch(() => null)) ?? {};
}
export async function setHandoffRule(from: Deps, to: Deps | null) {
  const rules = await handoffRules();
  if (to) rules[from.rep.closeUserId] = { to: to.rep.closeUserId, toName: to.rep.name, fromName: from.rep.name, since: (from.now?.() ?? new Date()).toISOString() };
  else delete rules[from.rep.closeUserId];
  await store.putSetting("team", RULES_KEY, rules);
  forgetBoard(from.rep.closeUserId);
  if (to) forgetBoard(to.rep.closeUserId);
  return rules;
}

/** Whose account a line card makes it: the rep it was handed to, else the sender's standing rule, else the sender. */
export const cardOwner = (hand: Record<string, Handoff>, rules: HandoffRules, leadId: string, senderId: string) => hand[leadId]?.to ?? rules[senderId]?.to ?? senderId;

/**
 * An account that's yours only by a standing rule becomes a recorded hand-off (Lead owner in Close, a note), so it
 * reads the same as the ones handed over by hand. Runs from the new rep's board build, in the background.
 */
export async function adoptByRule(d: Deps, leads: Array<{ leadId: string; from: string; fromName: string }>) {
  if (!leads.length) return 0;
  const map = await handoffs();
  const field = await ownerFieldId(d).catch(() => null);
  const now = (d.now?.() ?? new Date()).toISOString();
  let n = 0;
  for (const l of leads) {
    if (map[l.leadId]) continue;
    try {
      if (field) await d.close.updateLead(l.leadId, { [`custom.${field}`]: d.rep.closeUserId });
      await d.close.createNote(l.leadId, `[Handed over] ${l.fromName}'s accounts go to ${d.rep.name}: this one is ${d.rep.name.split(/\s+/)[0]}'s.`, false).catch(() => undefined);
      map[l.leadId] = { from: l.from, fromName: l.fromName, to: d.rep.closeUserId, toName: d.rep.name, at: now };
      n++;
    } catch { /* next board build tries again */ }
  }
  if (n) await store.putSetting("team", KEY, map);
  return n;
}

export async function handOver(from: Deps, to: Deps, leadIds: string[], opts: { onEach?: (leadId: string, i: number) => void } = {}) {
  const now = (from.now?.() ?? new Date()).toISOString();
  const map = await handoffs();
  const field = await ownerFieldId(from).catch(() => null);
  const first = to.rep.name.split(/\s+/)[0] || to.rep.name;
  const done: string[] = [];
  const failed: Array<{ leadId: string; why: string }> = [];
  for (const [i, leadId] of leadIds.entries()) {
    try {
      await stopScheduledFor(from, leadId, `${first} has this account now.`).catch(() => undefined);
      await dropRescueDraft(from, leadId).catch(() => undefined);
      if (field) await from.close.updateLead(leadId, { [`custom.${field}`]: to.rep.closeUserId });
      await from.close.createNote(leadId, `[Handed over] ${from.rep.name} handed this account to ${to.rep.name}.`, false).catch(() => undefined);
      map[leadId] = { from: from.rep.closeUserId, fromName: from.rep.name, to: to.rep.closeUserId, toName: to.rep.name, at: now };
      done.push(leadId);
      if (done.length % 25 === 0) await store.putSetting("team", KEY, map); // a crash part-way keeps what's done
    } catch (err) { failed.push({ leadId, why: (err as Error).message }); }
    opts.onEach?.(leadId, i);
  }
  await store.putSetting("team", KEY, map);
  forgetBoard(from.rep.closeUserId);
  forgetBoard(to.rep.closeUserId);
  return { done, failed, owner: field ? to.rep.email.toLowerCase() : null };
}
