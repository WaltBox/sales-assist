import type { Deps } from "./assistant.js";
import { background } from "./background.js";
import { formatPhone } from "./rules.js";
import { store } from "./store.js";

/**
 * My leads (Walt 10/19): every lead whose "Lead owner" field in Close is you, with where each one stands: its
 * status, who to call, the last call and email, whether they opened or wrote back, and your next task on it.
 * Shown in the Chrome extension. Read-only: nothing here writes to Close.
 *
 * The calls and emails come from two bulk reads of the last 45 days (Close has no per-lead "last touched" field),
 * so the list is kept in the store and served at once; a fresh one is built behind it when it's over 10 minutes old.
 */
export const OWNER_FIELD = "Lead owner";
const WINDOW_DAYS = 45;
const STALE_MS = 10 * 60_000;
const DAY = 86_400_000;

export type MyLead = {
  leadId: string; company: string; status: string;
  contact: { name: string | null; phone: string | null; email: string | null };
  calls: number; lastCall: { at: string; by: string | null; outcome: string | null; talked: boolean } | null;
  lastEmail: { at: string; subject: string | null; opens: number; lastOpen: string | null } | null;
  repliedAt: string | null;
  task: { text: string; due: string; overdue: boolean } | null;
  /** Nobody has called or emailed them in the last 45 days. */
  untouched: boolean;
};
export type MyLeads = { at: string; field: boolean; leads: MyLead[] };

export async function ownerFieldId(d: Deps): Promise<string | null> {
  const cached = await store.getSetting<string>("team", "leadOwnerFieldId").catch(() => null);
  if (cached) return cached;
  const f = (await d.close.leadCustomFields()).find((x) => x.name.trim().toLowerCase() === OWNER_FIELD.toLowerCase());
  if (f) await store.putSetting("team", "leadOwnerFieldId", f.id).catch(() => undefined);
  return f?.id ?? null;
}

const building = new Set<string>();
export async function myLeads(d: Deps, opts: { fresh?: boolean } = {}): Promise<MyLeads> {
  const key = `myleads:${d.rep.closeUserId}`;
  if (!opts.fresh) {
    const saved = await store.cacheGet<MyLeads>(key).catch(() => null);
    if (saved) {
      if (Date.now() - Date.parse(saved.at) > STALE_MS && !building.has(key)) {
        building.add(key);
        background(buildMyLeads(d).finally(() => building.delete(key)), "my leads");
      }
      return saved;
    }
  }
  return buildMyLeads(d);
}

type RawLead = { id: string; display_name: string; status_label: string; contacts?: Array<{ name?: string | null; display_name?: string | null; title?: string | null; phones?: Array<{ phone: string }>; emails?: Array<{ email: string }> }> };

async function buildMyLeads(d: Deps): Promise<MyLeads> {
  const me = d.rep.closeUserId;
  const now = d.now?.() ?? new Date();
  const fieldId = await ownerFieldId(d);
  if (!fieldId) return { at: now.toISOString(), field: false, leads: [] };
  const raw: RawLead[] = [];
  for (let skip = 0; skip < 5000; skip += 200) {
    const page = await d.close.searchLeads<RawLead>(`"custom.${fieldId}":"${me}"`, { skip, limit: 200, fields: "id,display_name,status_label,contacts" });
    raw.push(...page.data);
    if (!page.has_more) break;
  }
  const ids = new Set(raw.map((l) => l.id));
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY).toISOString();
  const [calls, emails, tasks, users] = await Promise.all([
    ids.size ? d.close.calls({ since, withTranscripts: false, max: 6000 }).catch(() => []) : [],
    ids.size ? d.close.listSince<{ lead_id: string; direction: string; status: string; subject: string | null; date_sent: string | null; date_created: string; opens: Array<{ opened_at: string; opened_by: string | null }> | null }>("email", { since, fields: "lead_id,direction,status,subject,date_sent,date_created,opens", max: 6000 }).catch(() => []) : [],
    d.close.openTasksFor(me).catch(() => []),
    d.close.users().catch(() => [] as Array<{ id: string; first_name: string }>),
  ]);
  const who = new Map(users.map((u) => [u.id, u.first_name]));
  const byLead = <T extends { lead_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (ids.has(r.lead_id)) m.set(r.lead_id, [...(m.get(r.lead_id) ?? []), r]);
    return m;
  };
  const callsOf = byLead(calls), emailsOf = byLead(emails), tasksOf = byLead(tasks);
  const when = (e: { date_sent: string | null; date_created: string }) => e.date_sent ?? e.date_created;
  const ours = (s: string | null) => !s || /@westgatesupply\.com$/i.test(s);

  const leads: MyLead[] = raw.map((l) => {
    const c = (l.contacts ?? []).find((x) => x.phones?.length || x.emails?.length) ?? l.contacts?.[0];
    const name = c?.name || c?.display_name || null;
    const cs = callsOf.get(l.id) ?? [];
    const last = cs[0] ?? null; // calls() comes back newest first
    const out = (emailsOf.get(l.id) ?? []).filter((e) => e.direction === "outgoing" && e.status === "sent").sort((a, b) => when(b).localeCompare(when(a)));
    const lastOut = out[0] ?? null;
    const opens = lastOut ? (lastOut.opens ?? []).filter((o) => !ours(o.opened_by) || !o.opened_by).map((o) => o.opened_at).sort() : [];
    const replies = (emailsOf.get(l.id) ?? []).filter((e) => e.direction === "incoming").map(when).sort();
    const t = (tasksOf.get(l.id) ?? []).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
    return {
      leadId: l.id, company: l.display_name, status: l.status_label,
      contact: { name: name && name !== "Main Office" ? name : null, phone: c?.phones?.[0]?.phone ? formatPhone(c.phones[0].phone) : null, email: c?.emails?.[0]?.email ?? null },
      calls: cs.length,
      lastCall: last ? { at: last.date_created, by: who.get(last.user_id) ?? null, outcome: last.disposition ?? null, talked: (last.duration ?? 0) >= 60 } : null,
      lastEmail: lastOut ? { at: when(lastOut), subject: lastOut.subject, opens: opens.length, lastOpen: opens.at(-1) ?? null } : null,
      repliedAt: replies.at(-1) ?? null,
      task: t ? { text: t.text, due: t.date, overdue: t.date.slice(0, 10) < now.toISOString().slice(0, 10) } : null,
      untouched: !cs.length && !out.length,
    };
  });
  // They wrote back, then tasks due, then opened, then the rest by how long since anyone touched them.
  const touched = (l: MyLead) => [l.lastCall?.at, l.lastEmail?.at].filter(Boolean).sort().at(-1) ?? "";
  const today = now.toISOString().slice(0, 10);
  const rank = (l: MyLead) => (l.repliedAt && (!l.lastCall || l.repliedAt > l.lastCall.at) ? 0 : l.task && l.task.due.slice(0, 10) <= today ? 1 : l.lastEmail?.opens ? 2 : 3);
  leads.sort((a, b) => rank(a) - rank(b) || touched(a).localeCompare(touched(b)) || a.company.localeCompare(b.company));
  const value: MyLeads = { at: now.toISOString(), field: true, leads };
  await store.cacheSet(`myleads:${me}`, value, 3 * DAY).catch(() => undefined);
  return value;
}
