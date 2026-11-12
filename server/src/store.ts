import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config, ROOT } from "./config.js";

// What the server keeps that Close doesn't have (Walt 9/26: "we don't need to
// store anything that's stored in Close"):
//   - reviews: call follow-ups the AI built that haven't been saved to Close yet
//     (plus a slim record of each tap for the week stats)
//   - cache:   Lead Briefs, which cost a Claude call to rebuild
//   - rejections: email drafts the pre-save checks blocked, for tuning the rules
//   - users: sign-in (email + password hash); reps: each person's Close API key
//   - automations: which emails the automation scheduled and WHY (Close has the emails themselves)
//   - settings: per-rep switches (automatic bumps on/off)
// Supabase when SUPABASE_URL is set (hosted), else JSON files in .cache (local), else memory (tests).

export type ReviewRow = { id: string; repId: string; leadId: string; callId: string | null; state: string; createdAt: string; data: unknown };

/** A person the assistant works for: their Close API key powers everything. */
export type StoredRep = { email: string; name: string; close_api_key: string; timezone: string | null };
export type User = { email: string; passwordHash: string; createdAt: string; lastLogin: string | null };

/** One email the automation scheduled: the Close email id, and why it was sent. */
export type Automation = {
  id: string; repId: string; leadId: string; company: string; to: string; subject: string;
  /** The text as written (10/8): saved with the row so the page doesn't ask Close for every body. */
  body?: string | null;
  kind: "bump"; label: string; reason: string;
  scheduledFor: string | null; createdAt: string;
  status: "scheduled" | "sent" | "skipped" | "stopped" | "failed";
  statusAt: string | null; note: string | null; checkedAt: string | null;
  /** The copy variant ("friday") and the account's cadence arm (days between bumps), for the follow-up test (10/2). */
  variant?: string | null; arm?: number | null;
  /** The meme in this bump (file name), so a company never gets the same one twice. */
  meme?: string | null;
  /** The tracking token for the meme image and link in this bump (10/6), to read loads and clicks back. */
  track?: string | null;
  /** The sequence version that wrote it (the builder's name, 11/9), so the scoreboard can compare versions. */
  seq?: string | null;
  /** Which step of that sequence it was (11/10): "talked:0" is the first intro email, "cold:after:1" the second rotating line. */
  step?: string | null;
};

/**
 * One account record per rep and lead (11/10): what Close knows about the lead (the facts the board needs, trimmed)
 * and what the app made of it (the Account row the pages read). Kept current by Close's webhooks; rebuilt from a
 * rescan nightly. `suspect` marks one an event couldn't bring up to date, so the reconcile does it first.
 */
export type AccountStateRow = { repId: string; leadId: string; company: string | null; updatedAt: string; suspect: boolean; data: unknown };

/** One scoring event (11/11): what the West Game paid, kept so seasons and bests don't re-read Close. */
export type RungEvent = { id: string; repId: string; leadId: string | null; company: string | null; kind: "dial" | "named" | "card" | "reached" | "rfq"; at: string; day: string; points: number; first: boolean; data?: unknown };

export interface Store {
  putRungEvents(rows: RungEvent[]): Promise<void>;
  /** A rep's events, oldest first; by local day when given. */
  listRungEvents(repId: string, opts?: { sinceDay?: string; untilDay?: string }): Promise<RungEvent[]>;
  /** A rep's rows for one local day, dropped before that day is written again (a rewrite is exact, never a merge). */
  deleteRungEvents(repId: string, day: string): Promise<void>;

  putAutomation(a: Automation): Promise<void>;
  /** A rep's rows since a date; with a lead, only that lead's. */
  listAutomations(repId: string, since: string, leadId?: string): Promise<Automation[]>;

  getAccountState(repId: string, leadId: string): Promise<AccountStateRow | null>;
  /** A rep's records; with `since`, only those written after that moment (the board's incremental read). */
  listAccountStates(repId: string, opts?: { since?: string; select?: "full" | "meta" }): Promise<AccountStateRow[]>;
  /** Every rep's record for one lead (an event on a lead updates each rep who has it). */
  accountStatesForLead(leadId: string): Promise<AccountStateRow[]>;
  putAccountState(row: AccountStateRow): Promise<void>;
  deleteAccountState(repId: string, leadId: string): Promise<void>;
  getSetting<T>(repId: string, key: string): Promise<T | null>;
  putSetting<T>(repId: string, key: string, value: T): Promise<void>;

  getUser(email: string): Promise<User | null>;
  putUser(u: User): Promise<void>;
  /** Remove a login (a password reset, 10/19): the rep and their Close key stay; they make a new password at sign-in. */
  deleteUser(email: string): Promise<void>;
  getRep(email: string): Promise<StoredRep | null>;
  putRep(r: StoredRep): Promise<void>;
  listReps(): Promise<StoredRep[]>;

  getReview<T>(id: string): Promise<T | null>;
  putReview<T extends { id: string; repId: string; leadId: string; callId: string | null; state: string; createdAt: string }>(it: T): Promise<void>;
  /** A rep's reviews created after `since`, plus any still waiting on them. */
  listReviews<T>(repId: string, since: string): Promise<T[]>;
  reviewsForCall<T>(callId: string): Promise<T[]>;
  /** Everything still building, for the catch-up job. */
  buildingReviews<T>(): Promise<T[]>;
  deleteReviewsBefore(before: string): Promise<void>;
  /** One worker per review: true if this caller got it until `untilMs`. */
  claim(id: string, untilMs: number): Promise<boolean>;
  /** True for the first caller only, across every server copy (10/8: two copies planned the same morning). */
  once(key: string, ttlMs: number): Promise<boolean>;
  release(id: string): Promise<void>;

  cacheGet<T>(key: string): Promise<T | null>;
  cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void>;
  cacheDelete(key: string): Promise<void>;

  logRejection(entry: Record<string, unknown>): Promise<void>;
  rejections(limit: number): Promise<Array<Record<string, unknown>>>;
}

const KEEP = ["building", "ready", "failed"];

// ---------- memory (tests), optionally mirrored to .cache files (local dev) ----------

type Mem = {
  automations: Record<string, Automation>;
  accountStates: Record<string, AccountStateRow>;
  rungEvents: Record<string, RungEvent>;
  settings: Record<string, unknown>;
  users: Record<string, User>;
  reps: Record<string, StoredRep>;
  reviews: Record<string, ReviewRow & { lease: number }>;
  cache: Record<string, { expires: number; value: unknown }>;
  rejections: Array<Record<string, unknown>>;
};

export class FileStore implements Store {
  private m: Mem = { automations: {}, accountStates: {}, rungEvents: {}, settings: {}, users: {}, reps: {}, reviews: {}, cache: {}, rejections: [] };
  constructor(private file: string | null) {
    if (!file) return;
    try {
      this.m = { ...this.m, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {}
    // Anything still building when the server stopped gets picked up again by the catch-up job.
    for (const r of Object.values(this.m.reviews)) r.lease = 0;
  }
  private save() {
    if (!this.file) return;
    const now = Date.now();
    for (const [k, v] of Object.entries(this.m.cache)) if (v.expires < now) delete this.m.cache[k];
    this.m.rejections = this.m.rejections.slice(-2000);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.m));
    } catch (err) {
      console.error("store write failed", err);
    }
  }
  async putAutomation(a: Automation) { this.m.automations[a.id] = structuredClone(a); this.save(); }
  async listAutomations(repId: string, since: string, leadId?: string) {
    return Object.values(this.m.automations).filter((a) => a.repId === repId && a.createdAt >= since && (!leadId || a.leadId === leadId)).map((a) => structuredClone(a)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getAccountState(repId: string, leadId: string) { return structuredClone(this.m.accountStates[`${repId}:${leadId}`]) ?? null; }
  async listAccountStates(repId: string, opts: { since?: string; select?: "full" | "meta" } = {}) {
    return Object.values(this.m.accountStates).filter((r) => r.repId === repId && (!opts.since || r.updatedAt > opts.since))
      .map((r) => structuredClone(opts.select === "meta" ? { ...r, data: null } : r));
  }
  async accountStatesForLead(leadId: string) { return Object.values(this.m.accountStates).filter((r) => r.leadId === leadId).map((r) => structuredClone(r)); }
  async putAccountState(row: AccountStateRow) { this.m.accountStates[`${row.repId}:${row.leadId}`] = structuredClone(row); this.save(); }
  async deleteAccountState(repId: string, leadId: string) { delete this.m.accountStates[`${repId}:${leadId}`]; this.save(); }
  async putRungEvents(rows: RungEvent[]) { for (const r of rows) this.m.rungEvents[r.id] = structuredClone(r); this.save(); }
  async deleteRungEvents(repId: string, day: string) { for (const [id, r] of Object.entries(this.m.rungEvents)) if (r.repId === repId && r.day === day) delete this.m.rungEvents[id]; this.save(); }
  async listRungEvents(repId: string, opts: { sinceDay?: string; untilDay?: string } = {}) {
    return Object.values(this.m.rungEvents).filter((r) => r.repId === repId && (!opts.sinceDay || r.day >= opts.sinceDay) && (!opts.untilDay || r.day <= opts.untilDay))
      .sort((a, b) => a.at.localeCompare(b.at)).map((r) => structuredClone(r));
  }
  async getSetting<T>(repId: string, key: string) { return (structuredClone(this.m.settings[`${repId}:${key}`]) as T) ?? null; }
  async putSetting<T>(repId: string, key: string, value: T) { this.m.settings[`${repId}:${key}`] = structuredClone(value); this.save(); }
  async getUser(email: string) { return structuredClone(this.m.users[email]) ?? null; }
  async putUser(u: User) { this.m.users[u.email] = structuredClone(u); this.save(); }
  async deleteUser(email: string) { delete this.m.users[email]; this.save(); }
  async getRep(email: string) { return structuredClone(this.m.reps[email]) ?? null; }
  async putRep(r: StoredRep) { this.m.reps[r.email] = structuredClone(r); this.save(); }
  async listReps() { return Object.values(this.m.reps).map((r) => structuredClone(r)); }

  async getReview<T>(id: string) { return (structuredClone(this.m.reviews[id]?.data) as T) ?? null; }
  async putReview<T extends { id: string; repId: string; leadId: string; callId: string | null; state: string; createdAt: string }>(it: T) {
    const lease = this.m.reviews[it.id]?.lease ?? 0;
    this.m.reviews[it.id] = { id: it.id, repId: it.repId, leadId: it.leadId, callId: it.callId, state: it.state, createdAt: it.createdAt, data: structuredClone(it), lease };
    this.save();
  }
  async listReviews<T>(repId: string, since: string) {
    return Object.values(this.m.reviews)
      .filter((r) => r.repId === repId && (r.createdAt >= since || KEEP.includes(r.state)))
      .map((r) => structuredClone(r.data) as T);
  }
  async reviewsForCall<T>(callId: string) { return Object.values(this.m.reviews).filter((r) => r.callId === callId).map((r) => structuredClone(r.data) as T); }
  async buildingReviews<T>() { return Object.values(this.m.reviews).filter((r) => r.state === "building").map((r) => structuredClone(r.data) as T); }
  async deleteReviewsBefore(before: string) {
    for (const [k, r] of Object.entries(this.m.reviews)) if (r.createdAt < before && r.state !== "ready") delete this.m.reviews[k];
    this.save();
  }
  async claim(id: string, untilMs: number) {
    const r = this.m.reviews[id];
    if (!r || r.lease > Date.now()) return false;
    r.lease = untilMs;
    return true;
  }
  async release(id: string) { const r = this.m.reviews[id]; if (r) r.lease = 0; }

  async cacheGet<T>(key: string) {
    const hit = this.m.cache[key];
    return hit && hit.expires > Date.now() ? (hit.value as T) : null;
  }
  async cacheSet<T>(key: string, value: T, ttlMs: number) { this.m.cache[key] = { expires: Date.now() + ttlMs, value }; this.save(); }
  async once(key: string, ttlMs: number) {
    const k = `once:${key}`, hit = this.m.cache[k];
    if (hit && hit.expires > Date.now()) return false;
    this.m.cache[k] = { expires: Date.now() + ttlMs, value: true }; this.save();
    return true;
  }
  async cacheDelete(key: string) { if (key in this.m.cache) { delete this.m.cache[key]; this.save(); } }

  async logRejection(entry: Record<string, unknown>) { this.m.rejections.push(entry); this.save(); }
  async rejections(limit: number) { return this.m.rejections.slice(-limit).reverse(); }
  /** Tests only. */
  resetRejections() { this.m.rejections = []; }
}

// ---------- Supabase (hosted) ----------

/**
 * Talks to Supabase's REST API with the service-role key, server side only.
 * Tables are in supabase/schema.sql; row-level security is on with no policies,
 * so nothing but this server can read them.
 */
// A short memory for reads (11/10). Every open screen polls the server every few seconds, and each poll was a
// handful of database reads: 70,000 in three hours, against a small Postgres that answered in half a second and
// then not at all. The same read asked again within a few seconds is answered from here instead. A write to a
// table forgets that table's reads, so a copy of the server never serves what it just changed as old news; another
// copy can be behind by at most the table's few seconds. Reads in flight are shared, so a burst of the same read
// is one request.
const READ_TTL_MS: Record<string, number> = { reps: 60_000, settings: 10_000, brief_cache: 5_000, reviews: 5_000, automations: 5_000, users: 10_000, account_state: 3_000, rung_events: 0 };
/** Timestamps in a query rounded down to ten seconds, so "since now" asked twice in a row is the same read. */
const readKey = (pathAndQuery: string) => pathAndQuery.replace(/(\d{4}-\d{2}-\d{2}T\d{2}(?::|%3A)\d{2}(?::|%3A))(\d)\d(?:\.\d{1,3})?Z/g, "$10.000Z");
// The last good answer to each read, kept a while past its memory (11/10, evening: Supabase's REST layer stalled for
// ten minutes after a deploy, every read waited ten seconds and failed, and every screen went blank). When a read
// fails and there's a copy from the last few minutes, the copy is the answer, and for a few seconds after a failure
// reads with a copy don't knock at all, so a stalled database isn't buried under retries.
const STALE_OK_MS = 10 * 60_000;
const BACKOFF_MS = 15_000;

export class SupabaseStore implements Store {
  /** How long one store call may take. Without a limit (11/9) a slow afternoon at Supabase held every request open
   * until Vercel killed it at five minutes, and the pile of hung requests kept the store slow. */
  constructor(private url: string, private key: string, private timeoutMs = Number(process.env.STORE_TIMEOUT_MS) || 10_000) {}

  private reads = new Map<string, { at: number; value: Promise<unknown> }>();
  private lastGood = new Map<string, { at: number; value: unknown }>();
  private failedAt = 0;
  /** How many reads the memory answered, how many went to Supabase, and how many were an old copy because Supabase didn't answer. */
  readonly counts = { remembered: 0, fetched: 0, stale: 0 };

  private async req<T>(method: string, pathAndQuery: string, body?: unknown, prefer?: string): Promise<T> {
    const table = pathAndQuery.split("?")[0];
    const ttl = READ_TTL_MS[table] ?? 0;
    if (method !== "GET") {
      // A write forgets the reads it could change: one setting, one cache key (a write to settings lands every few
      // seconds, and forgetting the whole table each time left the memory with nothing to answer from).
      const b = (body ?? {}) as Record<string, unknown>;
      const only = table === "settings" && typeof b.rep_id === "string" && typeof b.key === "string" ? `settings?${this.q({ rep_id: `eq.${b.rep_id}`, key: `eq.${b.key}` })}`
        : table === "brief_cache" && typeof b.key === "string" ? `brief_cache?${this.q({ key: `eq.${b.key}` })}`
          : table === "brief_cache" && method === "DELETE" && pathAndQuery.includes("key=eq.") ? pathAndQuery.split("&")[0]
            // One account record written: the rep's record reads are what it changes (a lead's, and the rep's lists).
            : table === "account_state" && typeof b.rep_id === "string" ? `account_state?${this.q({ rep_id: `eq.${b.rep_id}` })}`
              : null;
      for (const k of this.reads.keys()) if (only ? k.startsWith(only) : k.startsWith(`${table}?`) || k === table) this.reads.delete(k);
      return this.fetchJson<T>(method, pathAndQuery, body, prefer);
    }
    if (!ttl) { this.counts.fetched++; return this.fetchJson<T>(method, pathAndQuery, body, prefer); }
    // Every asker gets its own copy: callers change what they read (a list's rows, a setting) before saving it
    // back, and a shared object would carry one caller's half-done edits into another's.
    const key = readKey(pathAndQuery);
    const hit = this.reads.get(key);
    if (hit && Date.now() - hit.at < ttl) { this.counts.remembered++; return (hit.value as Promise<T>).then((v) => structuredClone(v)); }
    const good = this.lastGood.get(key);
    const copy = good && Date.now() - good.at < STALE_OK_MS ? good : null;
    // Supabase just failed: for a few seconds, the copy, without knocking again.
    if (copy && Date.now() - this.failedAt < BACKOFF_MS) { this.counts.stale++; return structuredClone(copy.value) as T; }
    this.counts.fetched++;
    const value = this.fetchJson<T>(method, pathAndQuery, body, prefer).then((v) => {
      this.lastGood.set(key, { at: Date.now(), value: v });
      if (this.lastGood.size > 2000) { const oldest = this.lastGood.keys().next().value; if (oldest !== undefined) this.lastGood.delete(oldest); }
      return v;
    }, (e: Error) => {
      this.failedAt = Date.now();
      if (!copy) throw e;
      this.counts.stale++;
      console.warn(`[store] ${e.message}; answered from the copy of ${Math.round((Date.now() - copy.at) / 1000)}s ago`);
      return copy.value as T;
    });
    this.reads.set(key, { at: Date.now(), value });
    // A failed read with no copy to fall back on isn't remembered: the next asker tries again.
    value.catch(() => { if (this.reads.get(key)?.value === value) this.reads.delete(key); });
    if (this.reads.size > 2000) { const oldest = this.reads.keys().next().value; if (oldest !== undefined) this.reads.delete(oldest); }
    return value.then((v) => structuredClone(v));
  }

  private async fetchJson<T>(method: string, pathAndQuery: string, body?: unknown, prefer?: string): Promise<T> {
    const what = `Supabase ${method} ${pathAndQuery.split("?")[0]}`;
    let res: Response;
    try {
      res = await fetch(`${this.url}/rest/v1/${pathAndQuery}`, {
        method,
        headers: {
          apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json",
          ...(prefer ? { prefer } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new Error(`${what}: no answer in ${this.timeoutMs >= 1000 ? `${Math.round(this.timeoutMs / 1000)}s` : `${this.timeoutMs}ms`}`);
      throw e;
    }
    if (!res.ok) throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }
  private q(params: Record<string, string>) { return new URLSearchParams(params).toString(); }

  async putAutomation(a: Automation) {
    await this.req("POST", "automations?on_conflict=id", { id: a.id, rep_id: a.repId, lead_id: a.leadId, created_at: a.createdAt, status: a.status, data: a }, "resolution=merge-duplicates,return=minimal");
  }
  async listAutomations(repId: string, since: string, leadId?: string) {
    const rows = await this.req<Array<{ data: Automation }>>("GET", `automations?${this.q({ rep_id: `eq.${repId}`, created_at: `gte.${since}`, ...(leadId ? { lead_id: `eq.${leadId}` } : {}), select: "data", order: "created_at.desc", limit: "500" })}`);
    return rows.map((r) => r.data);
  }

  private asState = (r: { rep_id: string; lead_id: string; company: string | null; updated_at: string; suspect: boolean; data?: unknown }): AccountStateRow =>
    ({ repId: r.rep_id, leadId: r.lead_id, company: r.company, updatedAt: r.updated_at, suspect: !!r.suspect, data: r.data ?? null });
  async getAccountState(repId: string, leadId: string) {
    const rows = await this.req<Array<Parameters<typeof this.asState>[0]>>("GET", `account_state?${this.q({ rep_id: `eq.${repId}`, lead_id: `eq.${leadId}`, select: "*" })}`);
    return rows[0] ? this.asState(rows[0]) : null;
  }
  async listAccountStates(repId: string, opts: { since?: string; select?: "full" | "meta" } = {}) {
    // Supabase hands back at most a thousand rows a read; a rep with more is read in pages.
    const out: AccountStateRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const rows = await this.req<Array<Parameters<typeof this.asState>[0]>>("GET", `account_state?${this.q({
        rep_id: `eq.${repId}`, ...(opts.since ? { updated_at: `gt.${opts.since}` } : {}), select: opts.select === "meta" ? "rep_id,lead_id,company,updated_at,suspect" : "*",
        order: "updated_at.asc,lead_id.asc", limit: "1000", offset: String(offset),
      })}`);
      out.push(...rows.map(this.asState));
      if (rows.length < 1000) break;
    }
    return out;
  }
  async accountStatesForLead(leadId: string) {
    const rows = await this.req<Array<Parameters<typeof this.asState>[0]>>("GET", `account_state?${this.q({ lead_id: `eq.${leadId}`, select: "*" })}`);
    return rows.map(this.asState);
  }
  async putAccountState(row: AccountStateRow) {
    await this.req("POST", "account_state?on_conflict=rep_id,lead_id", { rep_id: row.repId, lead_id: row.leadId, company: row.company, updated_at: row.updatedAt, suspect: row.suspect, data: row.data }, "resolution=merge-duplicates,return=minimal");
  }
  async putRungEvents(rows: RungEvent[]) {
    for (let i = 0; i < rows.length; i += 500) {
      const body = rows.slice(i, i + 500).map((r) => ({ id: r.id, rep_id: r.repId, lead_id: r.leadId, company: r.company, kind: r.kind, at: r.at, day: r.day, points: r.points, first: r.first, data: r.data ?? null }));
      await this.req("POST", "rung_events?on_conflict=id", body, "resolution=merge-duplicates,return=minimal");
    }
  }
  async deleteRungEvents(repId: string, day: string) {
    await this.req("DELETE", `rung_events?${this.q({ rep_id: `eq.${repId}`, day: `eq.${day}` })}`, { rep_id: repId }, "return=minimal");
  }
  async listRungEvents(repId: string, opts: { sinceDay?: string; untilDay?: string } = {}) {
    const out: RungEvent[] = [];
    const span = [opts.sinceDay ? `day.gte.${opts.sinceDay}` : null, opts.untilDay ? `day.lte.${opts.untilDay}` : null].filter(Boolean);
    for (let offset = 0; ; offset += 1000) {
      const rows = await this.req<Array<{ id: string; rep_id: string; lead_id: string | null; company: string | null; kind: RungEvent["kind"]; at: string; day: string; points: number; first: boolean; data?: unknown }>>("GET",
        `rung_events?${this.q({ rep_id: `eq.${repId}`, ...(span.length ? { and: `(${span.join(",")})` } : {}), order: "at.asc,id.asc", limit: "1000", offset: String(offset) })}`);
      out.push(...rows.map((r) => ({ id: r.id, repId: r.rep_id, leadId: r.lead_id, company: r.company, kind: r.kind, at: r.at, day: r.day, points: r.points, first: r.first, data: r.data })));
      if (rows.length < 1000) break;
    }
    return out;
  }
  async deleteAccountState(repId: string, leadId: string) {
    // The write-forget keys on rep_id in the body; a delete has none, so the rep's reads are dropped by hand.
    await this.req("DELETE", `account_state?${this.q({ rep_id: `eq.${repId}`, lead_id: `eq.${leadId}` })}`, { rep_id: repId }, "return=minimal");
  }
  async getSetting<T>(repId: string, key: string) {
    const rows = await this.req<Array<{ value: T }>>("GET", `settings?${this.q({ rep_id: `eq.${repId}`, key: `eq.${key}`, select: "value" })}`);
    return rows[0]?.value ?? null;
  }
  async putSetting<T>(repId: string, key: string, value: T) {
    await this.req("POST", "settings?on_conflict=rep_id,key", { rep_id: repId, key, value }, "resolution=merge-duplicates,return=minimal");
  }

  async getUser(email: string) {
    const rows = await this.req<Array<{ email: string; password_hash: string; created_at: string; last_login: string | null }>>("GET", `users?${this.q({ email: `eq.${email}`, select: "*" })}`);
    const r = rows[0];
    return r ? { email: r.email, passwordHash: r.password_hash, createdAt: r.created_at, lastLogin: r.last_login } : null;
  }
  async deleteUser(email: string) {
    await this.req("DELETE", `users?${this.q({ email: `eq.${email}` })}`, undefined, "return=minimal");
  }
  async putUser(u: User) {
    await this.req("POST", "users?on_conflict=email", { email: u.email, password_hash: u.passwordHash, created_at: u.createdAt, last_login: u.lastLogin }, "resolution=merge-duplicates,return=minimal");
  }
  async getRep(email: string) {
    const rows = await this.req<StoredRep[]>("GET", `reps?${this.q({ email: `eq.${email}`, active: "eq.true", select: "email,name,close_api_key,timezone" })}`);
    return rows[0] ?? null;
  }
  async putRep(r: StoredRep) {
    await this.req("POST", "reps?on_conflict=email", { ...r, active: true }, "resolution=merge-duplicates,return=minimal");
  }
  async listReps() {
    return this.req<StoredRep[]>("GET", `reps?${this.q({ active: "eq.true", select: "email,name,close_api_key,timezone" })}`);
  }

  async getReview<T>(id: string) {
    const rows = await this.req<Array<{ data: T }>>("GET", `reviews?${this.q({ id: `eq.${id}`, select: "data" })}`);
    return rows[0]?.data ?? null;
  }
  async putReview<T extends { id: string; repId: string; leadId: string; callId: string | null; state: string; createdAt: string }>(it: T) {
    await this.req("POST", "reviews?on_conflict=id", {
      id: it.id, rep_id: it.repId, lead_id: it.leadId, call_id: it.callId, state: it.state, created_at: it.createdAt, data: it, updated_at: new Date().toISOString(),
    }, "resolution=merge-duplicates,return=minimal");
  }
  async listReviews<T>(repId: string, since: string) {
    const rows = await this.req<Array<{ data: T }>>("GET", `reviews?${this.q({
      rep_id: `eq.${repId}`, or: `(created_at.gte.${since},state.in.(${KEEP.join(",")}))`, select: "data", order: "created_at.desc", limit: "500",
    })}`);
    return rows.map((r) => r.data);
  }
  async reviewsForCall<T>(callId: string) {
    const rows = await this.req<Array<{ data: T }>>("GET", `reviews?${this.q({ call_id: `eq.${callId}`, select: "data" })}`);
    return rows.map((r) => r.data);
  }
  async buildingReviews<T>() {
    const rows = await this.req<Array<{ data: T }>>("GET", `reviews?${this.q({ state: "eq.building", select: "data", limit: "100" })}`);
    return rows.map((r) => r.data);
  }
  async deleteReviewsBefore(before: string) {
    await this.req("DELETE", `reviews?${this.q({ created_at: `lt.${before}`, state: "neq.ready" })}`, undefined, "return=minimal");
  }
  async claim(id: string, untilMs: number) {
    // Conditional update: only one caller flips an expired lease.
    const rows = await this.req<unknown[]>("PATCH", `reviews?${this.q({ id: `eq.${id}`, lease_until: `lt.${new Date().toISOString()}`, select: "id" })}`,
      { lease_until: new Date(untilMs).toISOString() }, "return=representation");
    return rows.length > 0;
  }
  async release(id: string) {
    await this.req("PATCH", `reviews?${this.q({ id: `eq.${id}` })}`, { lease_until: new Date(0).toISOString() }, "return=minimal");
  }

  async cacheGet<T>(key: string) {
    const rows = await this.req<Array<{ value: T }>>("GET", `brief_cache?${this.q({ key: `eq.${key}`, expires_at: `gt.${new Date().toISOString()}`, select: "value" })}`);
    return rows[0]?.value ?? null;
  }
  async once(key: string, ttlMs: number) {
    // A plain insert: the primary key makes a second one fail (409), so exactly one caller wins.
    try {
      await this.req("POST", "brief_cache", { key: `once:${key}`, value: true, expires_at: new Date(Date.now() + ttlMs).toISOString() }, "return=minimal");
      return true;
    } catch (e) {
      if (/: 409 /.test((e as Error).message)) return false;
      throw e;
    }
  }
  async cacheSet<T>(key: string, value: T, ttlMs: number) {
    await this.req("POST", "brief_cache?on_conflict=key", { key, value, expires_at: new Date(Date.now() + ttlMs).toISOString() }, "resolution=merge-duplicates,return=minimal");
  }
  async cacheDelete(key: string) { await this.req("DELETE", `brief_cache?${this.q({ key: `eq.${key}` })}`, undefined, "return=minimal"); }

  async logRejection(entry: Record<string, unknown>) {
    await this.req("POST", "draft_rejections", { at: entry.at, lead_id: entry.leadId ?? null, data: entry }, "return=minimal");
  }
  async rejections(limit: number) {
    const rows = await this.req<Array<{ data: Record<string, unknown> }>>("GET", `draft_rejections?${this.q({ select: "data", order: "at.desc", limit: String(limit) })}`);
    return rows.map((r) => r.data);
  }

  /** The side panel's old per-rep token (stored hashed), until everyone signs in with email. */
  async repByTokenHash(hash: string) {
    const rows = await this.req<StoredRep[]>("GET", `reps?${this.q({ token_hash: `eq.${hash}`, active: "eq.true", select: "email,name,close_api_key,timezone" })}`);
    return rows[0] ?? null;
  }
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const store: Store = config.supabaseUrl && config.supabaseKey
  ? new SupabaseStore(config.supabaseUrl.replace(/\/$/, ""), config.supabaseKey)
  : new FileStore(config.storeFile);

export const hosted = store instanceof SupabaseStore;

/** One-time move of the old .cache/queue.json and briefs-v10.json into the local store file. */
export function migrateOldCache(fs_ = fs) {
  if (!(store instanceof FileStore) || !config.storeFile || fs_.existsSync(config.storeFile)) return;
  const dir = path.join(ROOT, ".cache");
  try {
    const items = JSON.parse(fs_.readFileSync(path.join(dir, "queue.json"), "utf8")) as Array<{ id: string; repId: string; leadId: string; callId: string | null; state: string; createdAt: string }>;
    for (const it of items) if (!it.leadId.startsWith("lead_demo")) void store.putReview({ ...it, transcript: null });
  } catch {}
  try {
    const briefs = JSON.parse(fs_.readFileSync(path.join(dir, "briefs-v10.json"), "utf8")) as Record<string, { at: number; value: unknown }>;
    for (const [k, v] of Object.entries(briefs)) {
      const left = v.at + 7 * 24 * 3600 * 1000 - Date.now();
      if (left > 0) void store.cacheSet(`brief:${config.briefVersion}:${k}`, v.value, left);
    }
  } catch {}
}
