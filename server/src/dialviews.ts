import { accountsBoard, type Account } from "./accounts.js";
import type { Deps } from "./assistant.js";
import { localParts } from "./rules.js";
import { store } from "./store.js";

/**
 * The call lists in Close (Walt 10/6): Smart Views of accounts we've talked to with no RFQ yet, split by warmth,
 * rebuilt each morning from the board. Each view also drops any lead you've reached today (see REACHED_FIELD); a
 * no-answer or a voicemail keeps them on the list, since you still owe them the call. The names are stable, so the
 * views stay pinned in Close and only their contents change.
 */
export const DIAL_VIEWS: Array<{ key: string; name: string; pick: (a: Account) => boolean }> = [
  { key: "hot", name: "Dial: Hot · talked before, no RFQ", pick: (a) => a.warmth.bucket === "hot" },
  { key: "warm", name: "Dial: Warm · talked before, no RFQ", pick: (a) => a.warmth.bucket === "warm" },
  { key: "cool", name: "Dial: Cool & cold · talked before, no RFQ", pick: (a) => a.warmth.bucket === "cool" || a.warmth.bucket === "cold" },
  { key: "all", name: "Dial: Everyone talked to, no RFQ", pick: () => true },
];

/**
 * "Last reached" on the lead in Close (10/6): the day you last had a real conversation with them, set by the
 * assistant when you tap Reached buyer / Got a name, or when the transcript shows they talked. Close's own call
 * disposition can't tell a 55-second voicemail from a person, so the lists go by this field instead.
 */
export const REACHED_FIELD = "Last reached (assistant)";
export async function reachedFieldId(d: Deps): Promise<string> {
  const key = "reachedFieldId";
  const cached = await store.getSetting<string>(d.rep.closeUserId, key).catch(() => null);
  if (cached) return cached;
  const fields = await d.close.leadCustomFields();
  const found = fields.find((f) => f.name === REACHED_FIELD) ?? await d.close.createLeadCustomField({ name: REACHED_FIELD, type: "date" });
  await store.putSetting(d.rep.closeUserId, key, found.id).catch(() => undefined);
  return found.id;
}
export function localDate(now: Date, tz: string) {
  const p = localParts(now, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
/** You reached them: today's date on the lead, so today's call lists drop them. Never throws. */
export async function markReached(d: Deps, leadId: string): Promise<boolean> {
  try {
    const id = await reachedFieldId(d);
    await d.close.updateLead(leadId, { [`custom.${id}`]: localDate(d.now?.() ?? new Date(), d.rep.timeZone) });
    return true;
  } catch (err) { console.error(`[reached] ${leadId}:`, (err as Error).message); return false; }
}

/** The Close query: these leads, minus anyone whose "Last reached" is today. */
export function dialQuery(leadIds: string[], fieldId: string, tz: string, now: Date) {
  // Close wants a local calendar date here ("fixed_local_date"), not an instant; an ISO timestamp is rejected.
  const today = localDate(now, tz);
  return {
    query: {
      negate: false, type: "and",
      queries: [
        { negate: false, object_type: "lead", type: "object_type" },
        { negate: false, type: "or", queries: leadIds.map((id) => ({ negate: false, type: "id", value: id })) },
        { negate: true, type: "field_condition", field: { type: "custom_field", custom_field_id: fieldId }, condition: { type: "moment_range", on_or_after: { type: "fixed_local_date", which: "start", value: today }, before: null } },
      ],
    },
    results_limit: null, sort: [],
  };
}

export async function syncDialViews(d: Deps): Promise<Array<{ name: string; leads: number; id: string; created: boolean }>> {
  const now = d.now?.() ?? new Date();
  const fieldId = await reachedFieldId(d);
  const board = await accountsBoard(d);
  const talked = board.accounts.filter((a) => !a.rfq && a.seen !== "bounced" && a.touches.talked > 0);
  const existing = await d.close.savedSearches();
  const out: Array<{ name: string; leads: number; id: string; created: boolean }> = [];
  for (const v of DIAL_VIEWS) {
    const ids = talked.filter(v.pick).map((a) => a.leadId);
    const s_query = dialQuery(ids.length ? ids : ["lead_none"], fieldId, d.rep.timeZone, now);
    const old = existing.find((x) => x.name === v.name || x.name.startsWith(`${v.name} (`));
    const r = old
      ? await d.close.updateSavedSearch(old.id, { name: v.name, s_query })
      : await d.close.createSavedSearch({ name: v.name, type: "lead", is_shared: true, s_query });
    out.push({ name: v.name, leads: ids.length, id: r.id, created: !old });
  }
  return out;
}
