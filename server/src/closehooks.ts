import { createHmac, timingSafeEqual } from "node:crypto";
import type { Deps } from "./assistant.js";
import type { CloseWebhook, CloseWebhookEvent } from "./close.js";
import { config } from "./config.js";
import { advance, reviewsForCall } from "./queue.js";
import { store } from "./store.js";

/**
 * Close tells the app what happened (11/10). Until now the app rebuilt each rep's whole board by rescanning 45 days
 * of Close every ten minutes, and nothing was live: a call made in Close showed up on the next rebuild. Now one
 * webhook subscription (made with the owner's key, so it covers the whole organization) posts each call, email,
 * note, status change, lead change and finished task to /api/close/webhook within a second or two of it happening.
 * This file is the feed: what we subscribe to, how a delivery is checked, and where each event goes.
 */

/** The events that move something on a board or in the game. `activity.call updated` is how the transcript lands. */
export const WANTED_EVENTS: CloseWebhookEvent[] = [
  { object_type: "activity.call", action: "created" },
  { object_type: "activity.call", action: "answered" },
  { object_type: "activity.call", action: "completed" },
  { object_type: "activity.call", action: "updated" },
  { object_type: "activity.email", action: "created" },
  { object_type: "activity.email", action: "sent" },
  { object_type: "activity.note", action: "created" },
  { object_type: "activity.lead_status_change", action: "created" },
  { object_type: "lead", action: "updated" },
  { object_type: "task.lead", action: "created" },
  { object_type: "task.lead", action: "updated" },
  { object_type: "task.lead", action: "completed" },
];
export const WEBHOOK_PATH = "/api/close/webhook";

/** One delivery, as Close posts it, read into the few fields the handlers use. */
export type CloseEvent = {
  id: string | null; at: string; objectType: string; action: string; objectId: string | null;
  leadId: string | null; userId: string | null;
  data: Record<string, unknown> | null; previousData: Record<string, unknown> | null; changedFields: string[];
};
export function parseCloseEvent(body: unknown): CloseEvent | null {
  const ev = (body as { event?: Record<string, unknown> } | null)?.event;
  if (!ev || typeof ev !== "object" || typeof ev.object_type !== "string" || typeof ev.action !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  return {
    id: str(ev.id), at: str(ev.date_created) ?? new Date().toISOString(), objectType: ev.object_type, action: ev.action, objectId: str(ev.object_id),
    leadId: str(ev.lead_id) ?? str(obj(ev.data)?.lead_id), userId: str(ev.user_id) ?? str(obj(ev.data)?.user_id),
    data: obj(ev.data), previousData: obj(ev.previous_data), changedFields: Array.isArray(ev.changed_fields) ? ev.changed_fields.filter((f): f is string => typeof f === "string") : [],
  };
}
export const eventKind = (ev: Pick<CloseEvent, "objectType" | "action">) => `${ev.objectType}.${ev.action}`;

// ---------- the signature ----------

/** Close signs each delivery: HMAC-SHA256 over the timestamp header and the raw body, keyed with the hex signature key. */
export function signatureMatches(raw: Buffer, ts: string, sig: string, keys: string[]): boolean {
  if (!ts || !sig || !raw) return false;
  for (const key of keys) {
    if (!/^[0-9a-f]+$/i.test(key) || key.length % 2) continue;
    const want = createHmac("sha256", Buffer.from(key, "hex")).update(ts).update(raw).digest("hex");
    if (want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return true;
  }
  return false;
}
/** A delivery signed more than five minutes ago (or dated in the future) is a replay or a clock gone wrong. */
export const MAX_SKEW_S = 5 * 60;
export const timestampFresh = (ts: string, now = Date.now()) => /^\d+$/.test(ts) && Math.abs(now / 1000 - Number(ts)) <= MAX_SKEW_S;

/** The subscription the app made, kept in the team settings with its signature key (Close shows the key once). */
export type StoredWebhook = { id: string; url: string; signatureKey: string; events: CloseWebhookEvent[]; createdAt: string; by: string };
const SUB_KEY = "closeWebhook";
export async function storedWebhook(): Promise<StoredWebhook | null> {
  const v = await store.getSetting<StoredWebhook>("team", SUB_KEY).catch(() => null);
  return v && typeof v.signatureKey === "string" ? v : null;
}
let keysMem: { at: number; keys: string[] } | null = null;
/** Every key a delivery may be signed with: the app's subscription, and the older one set by hand in the environment. */
export async function webhookKeys(): Promise<string[]> {
  if (keysMem && Date.now() - keysMem.at < 60_000) return keysMem.keys;
  const sub = await storedWebhook();
  const keys = [sub?.signatureKey, config.closeWebhookKey].filter((k): k is string => !!k);
  keysMem = { at: Date.now(), keys };
  return keys;
}
export function forgetWebhookKeys() { keysMem = null; }

// ---------- replays ----------

const seen = new Set<string>();
/** True the first time an event id is seen, on this server and (through the store) on every other copy. */
export async function firstTime(ev: CloseEvent): Promise<boolean> {
  if (!ev.id) return true;
  if (seen.has(ev.id)) return false;
  seen.add(ev.id);
  if (seen.size > 5000) seen.delete(seen.values().next().value!);
  return store.once(`close-ev:${ev.id}`, 15 * 60_000).catch(() => true);
}

// ---------- the subscription ----------

/** Where Close should post: APP_URL, else Vercel's production URL, else the tracking domain (the same app). */
export function appUrl(): string | null {
  const raw = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null) || config.publicUrl;
  return raw ? raw.replace(/\/$/, "") : null;
}
const sameEvents = (a: CloseWebhookEvent[], b: CloseWebhookEvent[]) => {
  const key = (e: CloseWebhookEvent) => `${e.object_type}.${e.action}`;
  const x = new Set(a.map(key)), y = new Set(b.map(key));
  return x.size === y.size && [...x].every((k) => y.has(k));
};
export type WebhookStatus = { ok: boolean; url: string | null; id: string | null; status: string | null; made: boolean; renewed: boolean; problem: string | null; close: CloseWebhook[] };
let ensuredAt = 0;
/**
 * Make sure Close has one active subscription for this app, with the events above, and that we hold its key. Made
 * once with the owner's key; a paused one (Close pauses after three days of failed deliveries) is switched back on;
 * one whose key we've lost (a redeploy without the setting, a subscription made by hand) is replaced. Runs from
 * the cron and from the owner's Team page; at most once an hour on its own.
 */
export async function ensureCloseWebhook(owner: Deps, opts: { force?: boolean; url?: string | null } = {}): Promise<WebhookStatus> {
  const base = opts.url ?? appUrl();
  const out: WebhookStatus = { ok: false, url: base ? `${base}${WEBHOOK_PATH}` : null, id: null, status: null, made: false, renewed: false, problem: null, close: [] };
  if (!base) { out.problem = "No APP_URL (or Vercel production URL) to subscribe with."; return out; }
  if (!opts.force && Date.now() - ensuredAt < 60 * 60_000) { out.ok = true; out.problem = "checked within the hour"; return out; }
  ensuredAt = Date.now();
  const stored = await storedWebhook();
  const list = await owner.close.webhooks();
  out.close = list;
  const ours = list.filter((w) => w.url === out.url);
  let keep = stored ? ours.find((w) => w.id === stored.id) ?? null : null;
  // Doubles, and one we can't verify (no key for it): gone, so a single known subscription is the feed.
  for (const w of ours) if (w !== keep) await owner.close.deleteWebhook(w.id).catch((e) => console.warn(`[close hooks] couldn't delete ${w.id}: ${(e as Error).message}`));
  if (keep) {
    if (keep.status !== "active") { keep = await owner.close.updateWebhook(keep.id, { status: "active" }); out.renewed = true; }
    if (!sameEvents(keep.events ?? [], WANTED_EVENTS)) { keep = await owner.close.updateWebhook(keep.id, { events: WANTED_EVENTS }); out.renewed = true; }
    if (out.renewed) await store.putSetting("team", SUB_KEY, { ...stored!, events: WANTED_EVENTS });
  } else {
    const made = await owner.close.createWebhook({ url: out.url!, events: WANTED_EVENTS });
    await store.putSetting("team", SUB_KEY, { id: made.id, url: out.url!, signatureKey: made.signature_key, events: WANTED_EVENTS, createdAt: new Date().toISOString(), by: owner.rep.email } satisfies StoredWebhook);
    forgetWebhookKeys();
    keep = made; out.made = true;
  }
  out.id = keep.id; out.status = keep.status; out.ok = keep.status === "active";
  if (out.made || out.renewed) console.info(`${new Date().toISOString()} [close hooks] subscription ${keep.id} ${out.made ? "made" : "renewed"} for ${out.url}`);
  return out;
}

// ---------- what each event does ----------

export type HookContext = {
  /** The rep whose Close user acted, mapped through the reps table; null for someone who isn't in the app. */
  depsForUser: (closeUserId: string) => Promise<Deps | null>;
  allDeps: () => Promise<Deps[]>;
  ownerDeps: () => Promise<Deps | null>;
};
/** What this server has seen since it started, for the owner's status page. */
export const hookStats = { received: 0, duplicates: 0, rejected: 0, byKind: {} as Record<string, number>, lastAt: null as string | null, lastKind: null as string | null, lastError: null as string | null };

type Sink = (ev: CloseEvent, ctx: HookContext) => Promise<string | void>;
const sinks: Array<{ name: string; on: Sink }> = [];
/** Something that reacts to events (the account records, the West Game): registered by its own module. */
export function onCloseEvent(name: string, on: Sink) {
  if (!sinks.some((s) => s.name === name)) sinks.push({ name, on });
}

/** One event, already verified: every sink gets it, and one line says what happened. */
export async function handleCloseEvent(ev: CloseEvent, ctx: HookContext): Promise<void> {
  const kind = eventKind(ev);
  hookStats.received++;
  hookStats.byKind[kind] = (hookStats.byKind[kind] ?? 0) + 1;
  hookStats.lastAt = new Date().toISOString(); hookStats.lastKind = kind;
  const t0 = Date.now();
  const notes: string[] = [];
  // Side by side: the records take a moment (they wait for the burst to end), the game shouldn't wait on them.
  await Promise.all(sinks.map(async (s) => {
    try {
      const said = await s.on(ev, ctx);
      if (said) notes.push(`${s.name}: ${said}`);
    } catch (e) {
      hookStats.lastError = `${kind} ${s.name}: ${(e as Error).message}`;
      notes.push(`${s.name} failed: ${(e as Error).message}`);
    }
  }));
  console.info(`${new Date().toISOString()} [close] ${kind} ${ev.leadId ?? "-"} by ${ev.userId ?? "-"} (${Date.now() - t0}ms)${notes.length ? `: ${notes.join("; ")}` : ""}`);
}

// A call changed (its transcript landed, or it ended): the review waiting on it builds now. This is what the older
// /api/webhooks/close subscription did; the feed does it for every call event it gets.
onCloseEvent("reviews", async (ev, ctx) => {
  if (ev.objectType !== "activity.call" || !ev.objectId) return;
  let n = 0;
  for (const it of await reviewsForCall(ev.objectId)) {
    if (it.state !== "building") continue;
    const d = await ctx.depsForUser(it.repId);
    if (d) { await advance(d, it.id); n++; }
  }
  return n ? `advanced ${n} review${n === 1 ? "" : "s"}` : undefined;
});
