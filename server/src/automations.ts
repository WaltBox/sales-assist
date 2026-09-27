import { accountsBoard } from "./accounts.js";
import type { Deps } from "./assistant.js";
import { FollowUpError, writeFollowUp } from "./followup.js";
import { localParts, zonedTime } from "./rules.js";
import { store, type Automation } from "./store.js";

// Automatic bumps (Walt 9/26). Each weekday morning, every account whose next step is "bump"
// gets a short reply in its thread, scheduled in Close for 9 to 11am their time; Close sends it.
// The page shows what's going out today and why, what went out, and what was skipped or stopped.
// Shortly before each send, the server checks again: if they replied, sent a file, or bounced,
// the email is pulled back to a draft.

export const DAILY_CAP = 15;
const DAY = 24 * 3600 * 1000;
const RECHECK_WITHIN = 90 * 60 * 1000; // re-check anything sending in the next 90 minutes…
const RECHECK_EVERY = 10 * 60 * 1000; // …at most every 10 minutes

export async function automationsOn(d: Deps) {
  return (await store.getSetting<boolean>(d.rep.closeUserId, "autoBumps")) === true;
}

export async function setAutomations(d: Deps, on: boolean) {
  await store.putSetting(d.rep.closeUserId, "autoBumps", on);
  return { enabled: on };
}

/** Write and schedule today's bumps. Runs once a weekday morning (or when the rep clicks "Plan now"). */
export async function planBumps(d: Deps, opts: { force?: boolean } = {}) {
  const now = d.now?.() ?? new Date();
  if (!opts.force && !(await automationsOn(d))) return { planned: [], skipped: [], reason: "Automatic emails are off." };
  const recent = await store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - 7 * DAY).toISOString());
  const today = localDay(now, d.rep.timeZone);
  const plannedToday = recent.filter((a) => localDay(new Date(a.createdAt), d.rep.timeZone) === today && a.status !== "failed").length;
  const board = await accountsBoard(d, { fresh: true });
  const held = await heldAccounts(d);
  const due = board.accounts.filter((a) => a.next.kind === "bump" && !held.has(a.leadId)
    // One automatic email per account per week.
    && !recent.some((r) => r.leadId === a.leadId && ["scheduled", "sent"].includes(r.status)));
  const planned: Automation[] = [];
  const skipped: Array<{ company: string; why: string }> = [];
  for (const [i, a] of due.entries()) {
    if (plannedToday + planned.length >= DAILY_CAP) {
      skipped.push({ company: a.company, why: `Daily limit of ${DAILY_CAP} reached; it goes out tomorrow.` });
      continue;
    }
    const base = { repId: d.rep.closeUserId, leadId: a.leadId, company: a.company, kind: "bump" as const, label: a.next.label, reason: a.next.detail, createdAt: now.toISOString(), checkedAt: null };
    try {
      const r = await writeFollowUp(d, a.leadId, { schedule: { stagger: i * 6 } });
      if (r.status === "warn") {
        skipped.push({ company: a.company, why: r.warning.replace(/ Send anyway\?$/, "") });
        continue;
      }
      const row: Automation = { ...base, id: r.draftId, to: r.to, subject: r.subject, scheduledFor: r.scheduledFor, status: "scheduled", statusAt: now.toISOString(), note: r.warnings.join(" ") || null };
      await store.putAutomation(row);
      planned.push(row);
    } catch (err) {
      const why = err instanceof FollowUpError ? err.message : `Couldn't write it: ${(err as Error).message}`;
      await store.putAutomation({ ...base, id: `failed_${a.leadId}_${now.getTime()}`, to: a.contact.email ?? "", subject: "", scheduledFor: null, status: "failed", statusAt: now.toISOString(), note: why });
      skipped.push({ company: a.company, why });
    }
  }
  await store.putSetting(d.rep.closeUserId, "lastPlanned", today);
  return { planned, skipped, reason: null };
}

/**
 * Keep the log in step with Close (sent, or moved back to a draft by hand), and pull back anything
 * about to send if they've written in since it was planned.
 */
export async function syncAutomations(d: Deps) {
  const now = d.now?.() ?? new Date();
  const rows = await store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - 8 * DAY).toISOString());
  for (const a of rows.filter((r) => r.status === "scheduled")) {
    const e = await d.close.email(a.id).catch(() => null);
    if (!e) continue;
    if (e.status === "sent") {
      await store.putAutomation({ ...a, status: "sent", statusAt: e.date_sent ?? now.toISOString() });
      continue;
    }
    if (e.status === "draft") {
      await store.putAutomation({ ...a, status: "skipped", statusAt: now.toISOString(), note: a.note ?? "Moved back to a draft in Close." });
      continue;
    }
    if (e.status === "error") {
      await store.putAutomation({ ...a, status: "failed", statusAt: now.toISOString(), note: "Close couldn't send it. Check it in Close." });
      continue;
    }
    // Still scheduled: if it's about to go, make sure nothing changed.
    const sendAt = a.scheduledFor ? new Date(a.scheduledFor).getTime() : 0;
    const checked = a.checkedAt ? new Date(a.checkedAt).getTime() : 0;
    if (sendAt - now.getTime() > RECHECK_WITHIN || now.getTime() - checked < RECHECK_EVERY) continue;
    const emails = await d.close.leadEmails(a.leadId).catch(() => null);
    const wroteIn = emails?.find((m) => m.direction === "incoming" && (m.date_sent ?? m.date_created ?? "") > a.createdAt);
    if (wroteIn) {
      await d.close.unschedule(a.id).catch(() => {});
      await store.putAutomation({ ...a, status: "stopped", statusAt: now.toISOString(), checkedAt: now.toISOString(), note: `Pulled back: they wrote in ("${wroteIn.subject ?? ""}"). It's a draft in Close now.` });
    } else {
      await store.putAutomation({ ...a, checkedAt: now.toISOString() });
    }
  }
}

/** Skip one: it stays in Close as a draft, and doesn't send. */
export async function skipAutomation(d: Deps, id: string) {
  const rows = await store.listAutomations(d.rep.closeUserId, new Date(Date.now() - 8 * DAY).toISOString());
  const a = rows.find((r) => r.id === id);
  if (!a) throw new Error("That email isn't in your list anymore.");
  if (a.status !== "scheduled") return a;
  await d.close.unschedule(id);
  const next: Automation = { ...a, status: "skipped", statusAt: new Date().toISOString(), note: "You skipped it. It's a draft in Close." };
  await store.putAutomation(next);
  return next;
}

// ---------- holds: accounts that never get an automatic email ----------

async function heldAccounts(d: Deps): Promise<Set<string>> {
  return new Set((await store.getSetting<string[]>(d.rep.closeUserId, "held")) ?? []);
}

export async function holdAccount(d: Deps, leadId: string, hold: boolean) {
  const held = await heldAccounts(d);
  if (hold) held.add(leadId); else held.delete(leadId);
  await store.putSetting(d.rep.closeUserId, "held", [...held]);
  return { leadId, held: hold };
}

// ---------- the forecast: who gets an automatic email, and when, if nothing changes ----------

export type Forecast = { leadId: string; company: string; to: string | null; sendOn: string; label: string; reason: string; held: boolean };

/** Every account whose next step turns into an automatic email in the next two weeks. */
export async function forecast(d: Deps, days = 14): Promise<Forecast[]> {
  const now = d.now?.() ?? new Date();
  const [board, held, recent] = await Promise.all([
    accountsBoard(d),
    heldAccounts(d),
    store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - 7 * DAY).toISOString()),
  ]);
  const scheduled = new Set(recent.filter((a) => a.status === "scheduled").map((a) => a.leadId));
  const horizon = now.getTime() + days * DAY;
  const out: Forecast[] = [];
  for (const a of board.accounts) {
    if (scheduled.has(a.leadId)) continue; // already on its way: it's in the scheduled list
    // Bumps due now go out the next weekday morning; waiting ones on their due date.
    const autoWaiting = a.next.kind === "waiting" && a.next.due && /· bump |· email |^Quote out/.test(a.next.label);
    if (a.next.kind !== "bump" && !autoWaiting) continue;
    const due = new Date(Math.max(new Date(a.next.due ?? now.toISOString()).getTime(), now.getTime()));
    const sendOn = morningOf(due, d.rep.timeZone);
    if (sendOn.getTime() > horizon) continue;
    const what = /promised|owes an RFQ/.test(a.next.label) ? "Email asking for their RFQ" : /quote/i.test(a.next.label) ? "Follow-up on the quote" : "Bump in the line card thread";
    out.push({ leadId: a.leadId, company: a.company, to: a.contact.email, sendOn: sendOn.toISOString(), label: what, reason: a.next.detail, held: held.has(a.leadId) });
  }
  return out.sort((x, y) => x.sendOn.localeCompare(y.sendOn));
}

/** The weekday morning an automatic email would go out on: 9am that day if it's a weekday before 11, else the next weekday. */
export function morningOf(at: Date, tz: string): Date {
  let p = localParts(at, tz);
  let day = zonedTime(p.year, p.month, p.day, 9, 0, tz);
  if (p.hour >= 11) day = new Date(day.getTime() + DAY);
  for (let i = 0; i < 7; i++) {
    p = localParts(new Date(day.getTime() + 3600 * 1000), tz); // noon-safe weekday check
    if (p.weekday >= 1 && p.weekday <= 5) return zonedTime(p.year, p.month, p.day, 9, 0, tz);
    day = new Date(day.getTime() + DAY);
  }
  return day;
}

/** What the Emails section shows: on/off, what's going out, what went out, what didn't. */
export async function automationsView(d: Deps) {
  await syncAutomations(d).catch((err) => console.error("sync automations:", (err as Error).message));
  const now = d.now?.() ?? new Date();
  const rows = await store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - 7 * DAY).toISOString());
  const withBody = await Promise.all(rows.map(async (a) => {
    if (a.status === "failed") return { ...a, body: null };
    const e = await d.close.email(a.id).catch(() => null);
    return { ...a, body: e?.body_text ?? null };
  }));
  const future = await forecast(d).catch(() => [] as Forecast[]);
  return {
    enabled: await automationsOn(d),
    future: future.filter((f) => !f.held),
    held: future.filter((f) => f.held),
    lastPlanned: await store.getSetting<string>(d.rep.closeUserId, "lastPlanned"),
    dailyCap: DAILY_CAP,
    upcoming: withBody.filter((a) => a.status === "scheduled").sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "")),
    sent: withBody.filter((a) => a.status === "sent").sort((a, b) => (b.statusAt ?? "").localeCompare(a.statusAt ?? "")),
    other: withBody.filter((a) => ["skipped", "stopped", "failed"].includes(a.status)),
  };
}

/** The morning run: once per weekday, from 7am the rep's time, for every rep with automations on. */
export async function morningRun(d: Deps) {
  const now = d.now?.() ?? new Date();
  const p = localParts(now, d.rep.timeZone);
  if (p.weekday === 0 || p.weekday === 6 || p.hour < 7) return null;
  if (!(await automationsOn(d))) return null;
  if ((await store.getSetting<string>(d.rep.closeUserId, "lastPlanned")) === localDay(now, d.rep.timeZone)) return null;
  return planBumps(d);
}

function localDay(at: Date, tz: string) {
  const p = localParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
