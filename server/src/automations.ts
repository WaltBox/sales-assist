import { accountsBoard, BUMP_AFTER_BUSINESS_DAYS, type Account } from "./accounts.js";
import { reachedToday } from "./dialviews.js";
import type { Deps } from "./assistant.js";
import { config } from "./config.js";
import { bumpBodyFor, FollowUpError, greetName, writeFollowUp } from "./followup.js";
import { businessDaysBetween, isOutStatus, localParts, zonedTime } from "./rules.js";
import { store, type Automation } from "./store.js";
import { clearPick, listMemes, memeFor, memesSeen, memeTrack, type Meme } from "./memes.js";

// Automatic bumps (Walt 9/26). Each weekday morning, every account whose next step is "bump"
// gets a short reply in its thread, scheduled in Close for a random minute between 8:11 and 11am their time; Close sends it.
// The page shows what's going out today and why, what went out, and what was skipped or stopped.
// Shortly before each send, the server checks again: if they replied, sent a file, or bounced,
// the email is pulled back to a draft.

export const DAILY_CAP = 200; // Walt 10/5: the whole wave goes, not 15 a day
/**
 * The cadence, in business days between an account's automatic emails. It was a 3/5/7 test (Walt 10/2); since
 * 10/5 it's two for everyone (the stored arms from the test were cleared). Kept as a list so a new test is one edit.
 */
export const CADENCE_ARMS = [2] as const;
/** How far back the rails look for an earlier automatic email: longer than the longest cadence. */
const RAIL_LOOKBACK_DAYS = 15;
/** After this many automatic bumps an account stops getting them: it comes back as a call. */
/**
 * No automatic cap (Walt 10/6): unless someone is put on a cooling period by hand, they get an email every two
 * business days for as long as they're on the board. The only things that stop a bump on their own are a reply
 * waiting for an answer, an RFQ in, a bounce, or an email you sent by hand inside the gap.
 */
export const MAX_BUMPS = Number.POSITIVE_INFINITY;
export const UNCONFIRMED_MAX_BUMPS = Number.POSITIVE_INFINITY;

/** The account's cadence arm, dealt once at random and kept. */
export async function armFor(d: Deps, leadId: string, arms?: Record<string, number>): Promise<number> {
  const map = arms ?? (await store.getSetting<Record<string, number>>(d.rep.closeUserId, "cadenceArms").catch(() => null)) ?? {};
  if (map[leadId]) return map[leadId];
  const arm = CADENCE_ARMS[Math.floor(Math.random() * CADENCE_ARMS.length)];
  map[leadId] = arm;
  await store.putSetting(d.rep.closeUserId, "cadenceArms", map);
  return arm;
}

/** A bump is on its way: the account's rescue draft would be a second email, so it goes (Walt 10/2). */
export async function dropRescueDraft(d: Deps, leadId: string): Promise<boolean> {
  const drafts = (await store.getSetting<Record<string, string>>(d.rep.closeUserId, "rescueDrafts").catch(() => null)) ?? {};
  const id = drafts[leadId];
  if (!id) return false;
  const e = await d.close.email(id).catch(() => null);
  if (!e || e.status === "draft") await d.close.deleteEmail(id).catch(() => null);
  delete drafts[leadId];
  await store.putSetting(d.rep.closeUserId, "rescueDrafts", drafts);
  return true;
}

/** The rep emailed this account by hand (the rescue draft): any bump still queued for it is pulled back. */
export async function stopScheduledFor(d: Deps, leadId: string, note: string) {
  const rows = await store.listAutomations(d.rep.closeUserId, new Date(Date.now() - 8 * DAY).toISOString());
  for (const a of rows.filter((r) => r.status === "scheduled" && r.leadId === leadId)) {
    await d.close.unschedule(a.id).catch(() => {});
    await store.putAutomation({ ...a, status: "stopped", statusAt: new Date().toISOString(), note: `Pulled back: ${note} It's a draft in Close now.` });
  }
}
const DAY = 24 * 3600 * 1000;
const RECHECK_WITHIN = 90 * 60 * 1000; // re-check anything sending in the next 90 minutes…
const RECHECK_EVERY = 10 * 60 * 1000; // …at most every 10 minutes

export async function automationsOn(d: Deps) {
  return (await store.getSetting<boolean>(d.rep.closeUserId, "autoBumps")) === true;
}

// Test mode (Walt 10/1: "we should only test this with Test Lead Fabrication"): the morning run writes one bump, to
// the test lead only, with its meme, and no real company gets anything until test mode is turned off.
export const TEST_LEAD_NAME = /^test lead fabrication\b/i;
export async function testMode(d: Deps) {
  const set = await store.getSetting<boolean>(d.rep.closeUserId, "autoTestMode").catch(() => null);
  return set ?? config.autoTestModeDefault; // on unless turned off
}
export async function setTestMode(d: Deps, on: boolean) {
  await store.putSetting(d.rep.closeUserId, "autoTestMode", on);
  return { testMode: on };
}

/** Test mode: one bump to Test Lead Fabrication, scheduled like a real one. */
async function planTestBump(d: Deps, now: Date) {
  const lead = (await d.close.findLeads('name:"Test Lead Fabrication"').catch(() => [])).find((l) => TEST_LEAD_NAME.test(l.display_name));
  if (!lead) return { planned: [], skipped: [{ company: "Test Lead Fabrication", why: "Test mode is on, but there's no Test Lead Fabrication lead in Close." }], reason: "Test mode." };
  const memes = await listMemes().catch(() => [] as Meme[]);
  const seen = await memesSeen(d);
  const picks = (await store.getSetting<Record<string, string | null>>(d.rep.closeUserId, "memePicks").catch(() => null)) ?? {};
  // The test lead can see every meme again: it's for checking how each one looks.
  seen.delete(lead.id);
  const meme = await memeFor(d, lead.id, { memes, seen, picks });
  const base = { repId: d.rep.closeUserId, leadId: lead.id, company: lead.display_name, kind: "bump" as const, label: "Test bump", reason: "Test mode: only Test Lead Fabrication gets automatic emails.", createdAt: now.toISOString(), checkedAt: null };
  // Only ever to the test lead's own contact (waltboxwell@gmail.com), never whoever else is on its threads.
  const contactEmail = (await d.close.lead(lead.id)).contacts.flatMap((c) => /main|office/i.test(c.name) ? [] : c.emails.map((e) => e.email))[0];
  if (!contactEmail) return { planned: [], skipped: [{ company: lead.display_name, why: "Test Lead Fabrication has no contact with an email." }], reason: "Test mode." };
  const out = await writeFollowUp(d, lead.id, { force: true, schedule: { stagger: 0 }, template: { meme, nth: 0 }, onlyTo: contactEmail });
  if (out.status === "drafted" && out.to.toLowerCase() !== contactEmail.toLowerCase()) throw new Error(`Test bump addressed to ${out.to}, not ${contactEmail}: stopped.`);
  if (out.status !== "drafted") return { planned: [], skipped: [{ company: lead.display_name, why: out.warning }], reason: "Test mode." };
  const row: Automation = { ...base, id: out.draftId, to: out.to, subject: out.subject, scheduledFor: out.scheduledFor, status: "scheduled", statusAt: now.toISOString(), note: "Test mode", meme: out.meme ?? null };
  await store.putAutomation(row);
  await clearPick(d, lead.id);
  return { planned: [row], skipped: [], reason: "Test mode: only Test Lead Fabrication." };
}

export async function setAutomations(d: Deps, on: boolean) {
  await store.putSetting(d.rep.closeUserId, "autoBumps", on);
  return { enabled: on };
}

/** Write and schedule today's bumps. Runs once a weekday morning (or when the rep clicks "Plan now"). */
export async function planBumps(d: Deps, opts: { force?: boolean } = {}) {
  const now = d.now?.() ?? new Date();
  if (!opts.force && !(await automationsOn(d))) return { planned: [], skipped: [], reason: "Automatic emails are off." };
  if (await testMode(d)) {
    await store.putSetting(d.rep.closeUserId, "lastPlanned", localDay(now, d.rep.timeZone));
    return planTestBump(d, now);
  }
  // One planning run at a time per rep: two overlapping runs would each write the same bumps.
  if (planning.has(d.rep.closeUserId)) return { planned: [], skipped: [], reason: "Already planning today's emails." };
  planning.add(d.rep.closeUserId);
  try {
    return await planDay(d, now);
  } finally {
    planning.delete(d.rep.closeUserId);
  }
}

const planning = new Set<string>();

/**
 * Safety rails on the day's list (Walt 10/2, after Mercer Tech got two bumps six minutes apart): one bump per
 * account and per email address today, nobody who already has one scheduled, and nobody sooner than their own
 * gap after the last one (their cadence in business days, a business week if they have none), on any account.
 * Walt 10/5: this was "never a second one within 7 calendar days", which cancelled every 3- and 5-day bump.
 */
export function dedupeDue<T extends { leadId: string; company: string; contact: { email: string | null } }>(
  due: T[],
  recent: Array<{ leadId: string; to: string; status: string; statusAt?: string | null; scheduledFor?: string | null; createdAt?: string }>,
  opts: { now?: Date; tz?: string; arms?: Record<string, number> } = {},
): { keep: T[]; dropped: Array<{ company: string; why: string }> } {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? "America/Los_Angeles";
  const live = recent.filter((r) => ["scheduled", "sent"].includes(r.status));
  // A row with no date on it is treated as just sent: when in doubt, don't send.
  const sentAt = (r: (typeof live)[number]) => new Date(r.statusAt ?? r.scheduledFor ?? r.createdAt ?? now.toISOString());
  const todayLeads = new Set<string>();
  const todayMails = new Set<string>();
  const keep: T[] = [];
  const dropped: Array<{ company: string; why: string }> = [];
  for (const a of due) {
    const mail = a.contact.email?.trim().toLowerCase() ?? "";
    const gap = opts.arms?.[a.leadId] ?? BUMP_AFTER_BUSINESS_DAYS;
    const tooSoon = (r: (typeof live)[number]) => r.status === "scheduled" || businessDaysBetween(sentAt(r), now, tz) < gap;
    const mine = live.filter((r) => r.leadId === a.leadId);
    const shared = mail ? live.filter((r) => r.leadId !== a.leadId && r.to.trim().toLowerCase() === mail) : [];
    if (mine.some((r) => r.status === "scheduled")) { dropped.push({ company: a.company, why: "Already has an automatic email scheduled." }); continue; }
    if (mine.some(tooSoon)) { dropped.push({ company: a.company, why: `Already got an automatic email in the last ${gap} business days.` }); continue; }
    if (shared.some(tooSoon)) { dropped.push({ company: a.company, why: `${mail} already got an automatic email on another account in the last ${gap} business days.` }); continue; }
    if (todayLeads.has(a.leadId) || (mail && todayMails.has(mail))) { dropped.push({ company: a.company, why: "Listed twice today; one bump is enough." }); continue; }
    todayLeads.add(a.leadId);
    if (mail) todayMails.add(mail);
    keep.push(a);
  }
  return { keep, dropped };
}

async function planDay(d: Deps, now: Date) {
  const recent = await store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - RAIL_LOOKBACK_DAYS * DAY).toISOString());
  const today = localDay(now, d.rep.timeZone);
  const plannedToday = recent.filter((a) => localDay(new Date(a.createdAt), d.rep.timeZone) === today && a.status !== "failed").length;
  const board = await accountsBoard(d, { fresh: true });
  const held = await heldAccounts(d);
  // Anyone who's sent an RFQ is past the line card stage: out of automatic emails for good (Walt 9/28).
  const arms = (await store.getSetting<Record<string, number>>(d.rep.closeUserId, "cadenceArms").catch(() => null)) ?? {};
  // Due: the board says bump, or the cadence says so even though a callback is on the books (Walt 10/5).
  const { keep: due, dropped } = dedupeDue(board.accounts.filter((a) => (a.next.kind === "bump" || a.bumpDue) && !a.rfq && !held.has(a.leadId)), recent, { now, tz: d.rep.timeZone, arms });
  const planned: Automation[] = [];
  const skipped: Array<{ company: string; why: string }> = [...dropped];
  // Memes (9/30): one per bump, never one the company has already had.
  const memes = await listMemes().catch((e) => { console.error("[memes]", (e as Error).message); return [] as Meme[]; });
  const seen = await memesSeen(d);
  const picks = (await store.getSetting<Record<string, string | null>>(d.rep.closeUserId, "memePicks").catch(() => null)) ?? {};
  const everSent = await store.listAutomations(d.rep.closeUserId, new Date(0).toISOString());
  for (const [i, a] of due.entries()) {
    if (plannedToday + planned.length >= DAILY_CAP) {
      skipped.push({ company: a.company, why: `Daily limit of ${DAILY_CAP} reached; it goes out tomorrow.` });
      continue;
    }
    const nth = everSent.filter((x) => x.leadId === a.leadId && x.status === "sent").length;
    if (nth >= MAX_BUMPS) {
      skipped.push({ company: a.company, why: `${MAX_BUMPS} automatic emails already; call them.` });
      continue;
    }
    const unconfirmed = a.seen === "not_opened" || a.seen === "maybe";
    if (unconfirmed && nth >= UNCONFIRMED_MAX_BUMPS) {
      skipped.push({ company: a.company, why: `${UNCONFIRMED_MAX_BUMPS} automatic emails and no sign they got any of it; call to confirm the address.` });
      continue;
    }
    const onCadence = a.next.kind !== "bump";
    const base = {
      repId: d.rep.closeUserId, leadId: a.leadId, company: a.company, kind: "bump" as const,
      label: onCadence ? `Get a first RFQ from ${a.contact.name?.split(/\s+/)[0] || a.company}` : a.next.label,
      reason: unconfirmed ? `No open or reply yet (bump ${nth + 1}). (${a.next.tag}: ${a.next.label} stays on the books.)`
        : onCadence ? `On the two-business-day cadence: they have the line card and no RFQ yet. (${a.next.tag}: ${a.next.label} stays on the books.)` : a.next.detail,
      createdAt: now.toISOString(), checkedAt: null,
    };
    try {
      const meme = await memeFor(d, a.leadId, { memes, seen, picks });
      const r = await writeFollowUp(d, a.leadId, { schedule: { stagger: i * 6 }, template: { meme, nth, variant: unconfirmed ? "landed" : null } });
      if (r.status === "warn") {
        skipped.push({ company: a.company, why: r.warning.replace(/ Send anyway\?$/, "") });
        continue;
      }
      const row: Automation = { ...base, id: r.draftId, to: r.to, subject: r.subject, scheduledFor: r.scheduledFor, status: "scheduled", statusAt: now.toISOString(), note: r.warnings.join(" ") || null, meme: r.meme ?? null, track: r.track ?? null, variant: unconfirmed ? "landed" : null, arm: await armFor(d, a.leadId, arms) };
      await store.putAutomation(row);
      await dropRescueDraft(d, a.leadId);
      if (r.meme) { seen.set(a.leadId, (seen.get(a.leadId) ?? new Set()).add(r.meme)); delete picks[a.leadId]; await clearPick(d, a.leadId); }
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
 * An approved same-day send (Walt 10/2): the given accounts, in order, a couple of minutes apart, with the
 * named copy and a meme each, through the same rails as the morning run. `test` sends one to Test Lead
 * Fabrication only, to check the email in an inbox first.
 */
export async function sendBumpsNow(d: Deps, opts: { leadIds: string[]; variant?: string | null; stagger?: number; test?: boolean; memes?: Meme[] }) {
  const now = d.now?.() ?? new Date();
  const stagger = opts.stagger ?? 2;
  const memes = opts.memes ?? (await listMemes().catch((e) => { console.error("[memes]", (e as Error).message); return [] as Meme[]; }));
  const seen = await memesSeen(d);
  const picks = (await store.getSetting<Record<string, string | null>>(d.rep.closeUserId, "memePicks").catch(() => null)) ?? {};
  const planned: Automation[] = [];
  const skipped: Array<{ company: string; why: string }> = [];
  if (opts.test) {
    const lead = (await d.close.findLeads('name:"Test Lead Fabrication"').catch(() => [])).find((l) => TEST_LEAD_NAME.test(l.display_name));
    if (!lead) return { planned, skipped: [{ company: "Test Lead Fabrication", why: "There's no Test Lead Fabrication lead in Close." }] };
    seen.delete(lead.id); // the test lead can see every meme again
    const meme = await memeFor(d, lead.id, { memes, seen, picks });
    const contactEmail = (await d.close.lead(lead.id)).contacts.flatMap((c) => /main|office/i.test(c.name) ? [] : c.emails.map((e) => e.email))[0];
    if (!contactEmail) return { planned, skipped: [{ company: lead.display_name, why: "Test Lead Fabrication has no contact with an email." }] };
    const out = await writeFollowUp(d, lead.id, { force: true, schedule: { stagger: 0, now: true }, template: { meme, nth: 0, variant: opts.variant ?? null }, onlyTo: contactEmail });
    if (out.status !== "drafted") return { planned, skipped: [{ company: lead.display_name, why: out.warning }] };
    if (out.to.toLowerCase() !== contactEmail.toLowerCase()) throw new Error(`Test bump addressed to ${out.to}, not ${contactEmail}: stopped.`);
    const row: Automation = { repId: d.rep.closeUserId, leadId: lead.id, company: lead.display_name, kind: "bump", label: "Test send", reason: `Checking the ${opts.variant ?? "standard"} email with its meme in an inbox.`, createdAt: now.toISOString(), checkedAt: null, id: out.draftId, to: out.to, subject: out.subject, scheduledFor: out.scheduledFor, status: "scheduled", statusAt: now.toISOString(), note: "Test send", meme: out.meme ?? null, variant: opts.variant ?? null, arm: null };
    await store.putAutomation(row);
    return { planned: [row], skipped };
  }
  const board = await accountsBoard(d, { fresh: true });
  const held = await heldAccounts(d);
  const recent = await store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - RAIL_LOOKBACK_DAYS * DAY).toISOString());
  const everSent = await store.listAutomations(d.rep.closeUserId, new Date(0).toISOString());
  const arms = (await store.getSetting<Record<string, number>>(d.rep.closeUserId, "cadenceArms").catch(() => null)) ?? {};
  const wanted = opts.leadIds.map((id) => board.accounts.find((a) => a.leadId === id)).filter((a): a is NonNullable<typeof a> => !!a);
  for (const id of opts.leadIds) if (!wanted.some((a) => a.leadId === id)) skipped.push({ company: id, why: "Not on the accounts board." });
  const eligible = wanted.filter((a) => {
    const why = a.rfq ? "RFQ received" : held.has(a.leadId) ? "On hold" : a.seen === "bounced" ? "Email bounced" : a.next.kind === "reply" ? "Their reply needs an answer first" : !a.contact.email ? "No email address" : null;
    if (why) skipped.push({ company: a.company, why });
    return !why;
  });
  const { keep, dropped } = dedupeDue(eligible, recent, { now, tz: d.rep.timeZone, arms });
  skipped.push(...dropped);
  for (const [i, a] of keep.entries()) {
    const nth = everSent.filter((x) => x.leadId === a.leadId && x.status === "sent").length;
    if (nth >= MAX_BUMPS) { skipped.push({ company: a.company, why: `${MAX_BUMPS} automatic emails already; call them.` }); continue; }
    const base = { repId: d.rep.closeUserId, leadId: a.leadId, company: a.company, kind: "bump" as const, label: a.next.label, reason: a.next.detail, createdAt: now.toISOString(), checkedAt: null };
    try {
      const meme = await memeFor(d, a.leadId, { memes, seen, picks });
      const r = await writeFollowUp(d, a.leadId, { force: true, schedule: { stagger: i * stagger, now: true }, template: { meme, nth, variant: opts.variant ?? null } });
      if (r.status === "warn") { skipped.push({ company: a.company, why: r.warning.replace(/ Send anyway\?$/, "") }); continue; }
      const row: Automation = { ...base, id: r.draftId, to: r.to, subject: r.subject, scheduledFor: r.scheduledFor, status: "scheduled", statusAt: now.toISOString(), note: r.warnings.join(" ") || null, meme: r.meme ?? null, track: r.track ?? null, variant: opts.variant ?? null, arm: await armFor(d, a.leadId, arms) };
      await store.putAutomation(row);
      await dropRescueDraft(d, a.leadId);
      if (r.meme) { seen.set(a.leadId, (seen.get(a.leadId) ?? new Set()).add(r.meme)); delete picks[a.leadId]; await clearPick(d, a.leadId); }
      planned.push(row);
    } catch (err) {
      const why = err instanceof FollowUpError ? err.message : `Couldn't write it: ${(err as Error).message}`;
      await store.putAutomation({ ...base, id: `failed_${a.leadId}_${now.getTime()}`, to: a.contact.email ?? "", subject: "", scheduledFor: null, status: "failed", statusAt: now.toISOString(), note: why });
      skipped.push({ company: a.company, why });
    }
  }
  return { planned, skipped };
}

/**
 * Keep the log in step with Close (sent, or moved back to a draft by hand), and pull back anything
 * about to send if they've written in since it was planned.
 */
export async function syncAutomations(d: Deps) {
  const now = d.now?.() ?? new Date();
  const rows = await store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - RAIL_LOOKBACK_DAYS * DAY).toISOString());
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
    // Test mode is a hard stop: anything real still queued from before it was turned on is pulled back.
    if ((await testMode(d)) && !TEST_LEAD_NAME.test(a.company)) {
      await d.close.unschedule(a.id).catch(() => {});
      await store.putAutomation({ ...a, status: "stopped", statusAt: now.toISOString(), checkedAt: now.toISOString(), note: "Pulled back: test mode is on, so only the test lead gets automatic emails. It's a draft in Close now." });
      continue;
    }
    // Shot down, or marked Not Interested / Bad Fit / Disqualified in Close since it was planned: it doesn't go (Walt 10/5).
    const leadNow = await d.close.lead(a.leadId).catch(() => null);
    if (leadNow && isOutStatus(leadNow.status_label)) {
      await d.close.unschedule(a.id).catch(() => {});
      await store.putAutomation({ ...a, status: "stopped", statusAt: now.toISOString(), checkedAt: now.toISOString(), note: `Pulled back: the lead is marked ${leadNow.status_label} in Close. It's a draft in Close now.` });
      continue;
    }
    // Never a second one inside the account's gap (its cadence in business days, a business week if it has none):
    // same account or same address, however it got scheduled. Walt 10/5: this was 7 calendar days, which would
    // have pulled back every 3- and 5-day bump.
    // (The test lead is exempt: it exists to get sent to, as often as we need to check an email.)
    const gap = a.arm ?? BUMP_AFTER_BUSINESS_DAYS;
    const goesAt = a.scheduledFor ? new Date(a.scheduledFor) : now;
    const isTestLead = TEST_LEAD_NAME.test(a.company);
    const twin = isTestLead ? undefined : rows.find((r) => r.id !== a.id && r.status === "sent"
      && businessDaysBetween(new Date(r.statusAt ?? r.createdAt), goesAt, d.rep.timeZone) < gap
      && (r.leadId === a.leadId || r.to.trim().toLowerCase() === a.to.trim().toLowerCase()));
    if (twin) {
      console.warn(`[sync] pulling back ${a.company}: twin ${twin.id} sent ${twin.statusAt ?? twin.createdAt}, goes ${goesAt.toISOString()}, gap ${gap}, days ${businessDaysBetween(new Date(twin.statusAt ?? twin.createdAt), goesAt, d.rep.timeZone)}`);
      await d.close.unschedule(a.id).catch(() => {});
      // The note carries the numbers (10/6): a pull-back that looks wrong can then be read off the row, whichever copy ran it.
      const twinAt = twin.statusAt ?? twin.createdAt;
      await store.putAutomation({ ...a, status: "stopped", statusAt: now.toISOString(), checkedAt: now.toISOString(), note: `Pulled back: they already got an automatic email on ${twinAt.slice(0, 10)}. It's a draft in Close now. [twin ${twin.id} at ${twinAt}, this one at ${goesAt.toISOString()}, ${businessDaysBetween(new Date(twinAt), goesAt, d.rep.timeZone)} business days apart in ${d.rep.timeZone}, gap ${gap}]` });
      continue;
    }
    const emails = await d.close.leadEmails(a.leadId).catch(() => null);
    // The rep emailed them by hand since this was planned (a rescue draft, say): that was the email.
    const byHand = isTestLead ? undefined : emails?.find((m) => m.direction === "outgoing" && m.id !== a.id && m.status === "sent" && (m.date_sent ?? "") > a.createdAt);
    if (byHand) {
      await d.close.unschedule(a.id).catch(() => {});
      await store.putAutomation({ ...a, status: "stopped", statusAt: now.toISOString(), checkedAt: now.toISOString(), note: `Pulled back: you emailed them yourself on ${(byHand.date_sent ?? "").slice(0, 10)} ("${byHand.subject ?? ""}"). It's a draft in Close now.` });
      continue;
    }
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

// ---------- holds and cooling periods: accounts out of the automatic emails, for good or for a while ----------

/** A cooling period (Walt 10/6, after Vicki at Hupp asked for fewer emails): out of the sequence until `until` (null = for good). */
export type Cooling = { since: string; until: string | null; why: string | null };
async function coolings(d: Deps): Promise<Record<string, Cooling>> {
  const map = (await store.getSetting<Record<string, Cooling>>(d.rep.closeUserId, "cooling").catch(() => null)) ?? {};
  // The older on/off list: a hold with no end.
  for (const id of (await store.getSetting<string[]>(d.rep.closeUserId, "held").catch(() => null)) ?? []) map[id] ??= { since: new Date(0).toISOString(), until: null, why: null };
  return map;
}
/** Who's out of the sequence right now: a cooling period that hasn't ended, or a hold. Expired ones are back in on their own. */
async function heldAccounts(d: Deps): Promise<Set<string>> {
  const now = (d.now?.() ?? new Date()).toISOString();
  return new Set(Object.entries(await coolings(d)).filter(([, c]) => !c.until || c.until > now).map(([id]) => id));
}
export async function coolingFor(d: Deps, leadId: string): Promise<Cooling | null> {
  const c = (await coolings(d))[leadId];
  const now = (d.now?.() ?? new Date()).toISOString();
  return c && (!c.until || c.until > now) ? c : null;
}
/**
 * Put an account on a cooling period (`days`; omit for a hold with no end) or take it off. Either way it's written
 * to the lead in Close as a note, so the reason is on the record.
 */
export async function holdAccount(d: Deps, leadId: string, hold: boolean, opts: { days?: number | null; why?: string | null } = {}) {
  const now = d.now?.() ?? new Date();
  const map = await coolings(d);
  const legacy = ((await store.getSetting<string[]>(d.rep.closeUserId, "held").catch(() => null)) ?? []).filter((id) => id !== leadId);
  let until: string | null = null;
  if (hold) {
    until = opts.days ? new Date(now.getTime() + opts.days * DAY).toISOString() : null;
    map[leadId] = { since: now.toISOString(), until, why: opts.why ?? null };
    await d.close.createNote(leadId, `[Cooling] Out of the automatic emails ${until ? `until ${until.slice(0, 10)}` : "until further notice"}${opts.why ? ` · ${opts.why}` : ""}`, false).catch(() => undefined);
  } else {
    delete map[leadId];
    await d.close.createNote(leadId, "[Cooling] Back in the automatic emails.", false).catch(() => undefined);
  }
  await store.putSetting(d.rep.closeUserId, "cooling", map);
  await store.putSetting(d.rep.closeUserId, "held", legacy);
  return { leadId, held: hold, until };
}

// ---------- the forecast: who gets an automatic email, and when, if nothing changes ----------

export type Forecast = { leadId: string; company: string; to: string | null; sendOn: string; label: string; reason: string; held: boolean; heldUntil?: string | null; heldWhy?: string | null; meme: Meme | null; preview: string | null };

/** Every account whose next step turns into an automatic email in the next two weeks. */
export async function forecast(d: Deps, days = 14): Promise<Forecast[]> {
  const now = d.now?.() ?? new Date();
  const [board, held, cool, recent] = await Promise.all([
    accountsBoard(d),
    heldAccounts(d),
    coolings(d),
    store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - 7 * DAY).toISOString()),
  ]);
  const scheduled = new Set(recent.filter((a) => a.status === "scheduled").map((a) => a.leadId));
  // The meme each one will carry (picked once, so the page and the send agree) and the text it'll say.
  const memes = await listMemes().catch(() => [] as Meme[]);
  const seen = await memesSeen(d);
  const picks = (await store.getSetting<Record<string, string | null>>(d.rep.closeUserId, "memePicks").catch(() => null)) ?? {};
  const everSent = await store.listAutomations(d.rep.closeUserId, new Date(0).toISOString());
  const horizon = now.getTime() + days * DAY;
  const out: Forecast[] = [];
  for (const a of board.accounts) {
    if (scheduled.has(a.leadId)) continue; // already on its way: it's in the scheduled list
    if (a.rfq) continue; // sent an RFQ: out of the sequence; following up on the quote is the rep's job
    // Bumps due now go out the next weekday morning; waiting ones on their due date.
    const autoWaiting = a.next.kind === "waiting" && a.next.due && /· bump |· email /.test(a.next.label);
    // The cadence can say "due" when the board shows a call or a rescue (10/5): same rule as the planner.
    if (a.next.kind !== "bump" && !autoWaiting && !a.bumpDue) continue;
    const nth = everSent.filter((x) => x.leadId === a.leadId && x.status === "sent").length;
    const unconfirmed = a.seen === "not_opened" || a.seen === "maybe";
    if (nth >= MAX_BUMPS || (unconfirmed && nth >= UNCONFIRMED_MAX_BUMPS)) continue;
    const due = new Date(Math.max(new Date(a.next.kind === "bump" || autoWaiting ? a.next.due ?? now.toISOString() : now.toISOString()).getTime(), now.getTime()));
    const sendOn = morningOf(due, d.rep.timeZone);
    if (sendOn.getTime() > horizon) continue;
    const what = unconfirmed ? "Bump (not confirmed)" : /promised|owes an RFQ/.test(a.next.label) ? "Email asking for their RFQ" : /quote/i.test(a.next.label) ? "Follow-up on the quote" : "Bump in the line card thread";
    const reason = unconfirmed ? `No open or reply yet (bump ${nth + 1}). ${a.next.tag}: ${a.next.label} stays on the books.`
      : a.next.kind === "bump" || autoWaiting ? a.next.detail : `On the two-business-day cadence: they have the line card and no RFQ yet. ${a.next.tag}: ${a.next.label} stays on the books.`;
    const meme = memes.length ? await memeFor(d, a.leadId, { memes, seen, picks }) : null;
    const first = greetName(a.contact.name);
    out.push({ leadId: a.leadId, company: a.company, to: a.contact.email, sendOn: sendOn.toISOString(), label: what, reason, held: held.has(a.leadId), heldUntil: held.has(a.leadId) ? cool[a.leadId]?.until ?? null : null, heldWhy: held.has(a.leadId) ? cool[a.leadId]?.why ?? null : null, meme, preview: bumpBodyFor(first, d.rep.name, nth, unconfirmed ? "landed" : null) });
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
    testMode: await testMode(d),
    future: future.filter((f) => !f.held),
    held: future.filter((f) => f.held),
    lastPlanned: await store.getSetting<string>(d.rep.closeUserId, "lastPlanned"),
    dailyCap: DAILY_CAP,
    upcoming: withBody.filter((a) => a.status === "scheduled").sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "")),
    sent: withBody.filter((a) => a.status === "sent").sort((a, b) => (b.statusAt ?? "").localeCompare(a.statusAt ?? "")),
    other: withBody.filter((a) => ["skipped", "stopped", "failed"].includes(a.status)),
  };
}

/**
 * The side panel's Emails tab (Walt 10/6): what went out and what's queued, newest first, each with whether the
 * buyer opened or replied since. No bodies (that's a Close call per row); the lead opens in Close for the rest.
 */
export type SentEmail = {
  id: string; leadId: string; company: string; to: string; subject: string; status: Automation["status"];
  at: string | null; variant: string | null; meme: string | null; opened: boolean; replied: boolean; rfq: boolean;
  /**
   * How likely it is they've seen it (Walt 10/6), when there's no tracked open: open tracking is a pixel, and a lot
   * of buyers' mail apps block it. "opened" is tracked or proven (a reply). "likely": they've said they get our
   * emails, or you've talked since it went. "unlikely": their mail app does report opens (it has before) and there's
   * none on this one. "unsure": no open has ever shown for them, so the pixel may just be blocked.
   */
  seen: { level: "opened" | "likely" | "unsure" | "unlikely"; chance: number; why: string };
  /** You already called them today: "reached" (a real conversation) or "tried" (no answer or voicemail). */
  calledToday: { at: string; reached: boolean } | null;
  /** Our own tracking (10/6): when the meme image first loaded in their mail app, and when they followed the link. */
  shown: string | null; clicked: string | null;
};
function seenGuess(a: Account | undefined, sent: boolean, at: string | null, opened: boolean, replied: boolean, rfq: boolean, now: Date): SentEmail["seen"] {
  if (!sent || !at) return { level: "unsure", chance: 0, why: "Not sent yet." };
  if (rfq || replied) return { level: "opened", chance: 100, why: replied ? "They replied to it." : "They sent an RFQ after it." };
  if (opened) return { level: "opened", chance: 100, why: `Opened${a?.opens.app ? ` in ${a.opens.app}` : ""} (tracked).` };
  if (!a) return { level: "unsure", chance: 40, why: "No open tracked." };
  const talkedAfter = !!a.touches.lastTalk && new Date(a.touches.lastTalk).getTime() > new Date(at).getTime();
  if (a.seen === "confirmed" || talkedAfter) return { level: "likely", chance: 70, why: talkedAfter ? "You talked after it went; no open tracked (their mail app may hide opens)." : "They've said they get your emails; no open tracked on this one." };
  const hours = (now.getTime() - new Date(at).getTime()) / 3_600_000;
  if (a.opens.person > 0) return { level: hours < 24 ? "unsure" : "unlikely", chance: hours < 24 ? 45 : 15, why: `Their mail app reports opens (${a.opens.person} on earlier emails) and there's none on this one${hours < 24 ? " yet" : ""}.` };
  if (a.opens.filter > 0 && !a.opens.maybe) return { level: "unsure", chance: 35, why: "Only their spam filter has ever touched our emails: it may be landing in junk, or their app hides opens." };
  return { level: "unsure", chance: 40, why: "No open has ever shown for this buyer, so the tracking pixel is probably blocked. A call is the only way to know." };
}
export async function sentEmailsView(d: Deps, days = 7): Promise<SentEmail[]> {
  const now = d.now?.() ?? new Date();
  const [rows, board] = await Promise.all([
    store.listAutomations(d.rep.closeUserId, new Date(now.getTime() - days * DAY).toISOString()),
    accountsBoard(d, { maxAgeMs: 10 * 60_000 }).catch(() => ({ accounts: [] as Account[] })),
  ]);
  const byLead = new Map(board.accounts.map((a) => [a.leadId, a]));
  const kept = rows.filter((r) => r.status === "sent" || r.status === "scheduled");
  const tracks = new Map(await Promise.all(kept.filter((r) => r.track).map(async (r) => [r.track!, await memeTrack(r.track!)] as const)));
  return kept.map((r) => {
    const a = byLead.get(r.leadId);
    const at = r.status === "sent" ? r.statusAt ?? r.createdAt : r.scheduledFor ?? r.createdAt;
    const after = (iso: string | null | undefined) => !!iso && !!at && new Date(iso).getTime() > new Date(at).getTime();
    const opened = !!a && r.status === "sent" && after(a.opens.last);
    const replied = !!a && r.status === "sent" && a.events.some((e) => e.kind === "reply" && after(e.at));
    const rfq = !!a && !!a.rfq && r.status === "sent" && after(a.rfq.at);
    return {
      id: r.id, leadId: r.leadId, company: r.company, to: r.to, subject: r.subject, status: r.status, at, variant: r.variant ?? null, meme: r.meme ?? null,
      opened: opened || !!(r.track && tracks.get(r.track)?.shown.length), replied, rfq,
      seen: seenGuess(a, r.status === "sent", at, opened || !!(r.track && tracks.get(r.track)?.shown.length), replied, rfq, now),
      shown: (r.track && tracks.get(r.track)?.shown[0]) ?? null, clicked: (r.track && tracks.get(r.track)?.clicked[0]) ?? null,
      calledToday: (() => {
        if (!a) return null;
        if (reachedToday(a.leadId, d.rep.timeZone, now)) return { at: now.toISOString(), reached: true };
        const today = new Date(now.toLocaleDateString("en-CA", { timeZone: d.rep.timeZone }) + "T00:00:00");
        const calls = a.events.filter((e) => e.kind === "call" && new Date(e.at).toLocaleDateString("en-CA", { timeZone: d.rep.timeZone }) === now.toLocaleDateString("en-CA", { timeZone: d.rep.timeZone }));
        if (!calls.length) return null;
        void today;
        return { at: calls[0].at, reached: reachedToday(a.leadId, d.rep.timeZone, now) || (!!a.touches.lastTalk && calls.some((c) => c.at === a.touches.lastTalk)) };
      })(),
    };
  }).sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));
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
