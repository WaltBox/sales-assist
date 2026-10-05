import fs from "node:fs";
import path from "node:path";
import type { Deps } from "./assistant.js";
import { config, ROOT } from "./config.js";
import { store } from "./store.js";

// Memes in the automatic bumps (Walt 9/30): one inline image per bump, never the same one twice to a company.
// The files live in server/memes; the server copies new ones to a public Supabase Storage bucket so email
// apps can load them. The bucket is the list of what's available.

export const MEMES_DIR = path.join(ROOT, "memes");
const BUCKET = "memes";
const IMAGE = /\.(jpe?g|png|gif|webp)$/i;
const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
export class MemeError extends Error {}

export type Meme = { name: string; url: string };

function storage() {
  if (!config.supabaseUrl || !config.supabaseKey) throw new MemeError("Memes need Supabase Storage (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY) so the images have a public link.");
  const base = config.supabaseUrl.replace(/\/$/, "");
  const headers = { apikey: config.supabaseKey, authorization: `Bearer ${config.supabaseKey}` };
  return { base, headers };
}

export const memeUrl = (name: string) => `${storage().base}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(name)}`;

let synced = 0;
/** Copy new files from server/memes to the public bucket (made on first use), then list what's there. */
export async function listMemes(opts: { sync?: boolean } = {}): Promise<Meme[]> {
  const { base, headers } = storage();
  if (opts.sync !== false && Date.now() - synced > 60_000) {
    synced = Date.now();
    await fetch(`${base}/storage/v1/bucket`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }) }).catch(() => null);
    const local = fs.existsSync(MEMES_DIR) ? fs.readdirSync(MEMES_DIR).filter((f) => IMAGE.test(f)) : [];
    const have = new Set((await bucketFiles(base, headers)).map((m) => m.name));
    for (const f of local.filter((f) => !have.has(f))) {
      const ext = f.split(".").pop()!.toLowerCase();
      const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${encodeURIComponent(f)}`, {
        method: "POST", headers: { ...headers, "content-type": TYPES[ext] ?? "application/octet-stream", "x-upsert": "true" }, body: fs.readFileSync(path.join(MEMES_DIR, f)),
      });
      if (!res.ok) console.error(`[memes] couldn't upload ${f}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      else console.info(`[memes] uploaded ${f}`);
    }
  }
  return bucketFiles(base, headers);
}

async function bucketFiles(base: string, headers: Record<string, string>): Promise<Meme[]> {
  const res = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "name", order: "asc" } }) });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ name: string }>;
  return rows.filter((r) => IMAGE.test(r.name)).map((r) => ({ name: r.name, url: `${base}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(r.name)}` }));
}

/** A meme that went out by hand (a rescue draft, or the call screen's bump): remembered per lead so they never get it twice. */
export async function rememberMeme(d: Deps, leadId: string, name: string) {
  const seen = (await store.getSetting<Record<string, string[]>>(d.rep.closeUserId, "rescueMemes").catch(() => null)) ?? {};
  seen[leadId] = [...new Set([...(seen[leadId] ?? []), name])];
  await store.putSetting(d.rep.closeUserId, "rescueMemes", seen);
}

/** Memes each company has already been sent, or has picked for a bump not yet sent. */
export async function memesSeen(d: Deps): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const a of await store.listAutomations(d.rep.closeUserId, new Date(0).toISOString())) {
    if (!a.meme || !["scheduled", "sent"].includes(a.status)) continue;
    out.set(a.leadId, (out.get(a.leadId) ?? new Set()).add(a.meme));
  }
  // Rescue drafts and call-screen bumps carry one too (10/2); they're remembered per lead when written.
  const rescue = (await store.getSetting<Record<string, string[]>>(d.rep.closeUserId, "rescueMemes").catch(() => null)) ?? {};
  for (const [leadId, names] of Object.entries(rescue)) for (const n of names) out.set(leadId, (out.get(leadId) ?? new Set()).add(n));
  return out;
}

type Picks = Record<string, string | null>; // leadId → meme name, or null for "no meme"
const picksOf = async (d: Deps) => (await store.getSetting<Picks>(d.rep.closeUserId, "memePicks").catch(() => null)) ?? {};

/** The meme for a lead's next bump: your pick, else one they haven't seen (chosen once, then kept). */
export async function memeFor(d: Deps, leadId: string, ctx?: { memes: Meme[]; seen: Map<string, Set<string>>; picks: Picks }): Promise<Meme | null> {
  const memes = ctx?.memes ?? (await listMemes().catch(() => []));
  const seen = (ctx?.seen ?? (await memesSeen(d))).get(leadId) ?? new Set<string>();
  const picks = ctx?.picks ?? (await picksOf(d));
  if (leadId in picks) {
    const p = picks[leadId];
    if (p === null) return null;
    const m = memes.find((x) => x.name === p);
    if (m && !seen.has(m.name)) return m;
  }
  const fresh = memes.filter((m) => !seen.has(m.name));
  if (!fresh.length) return null;
  const m = fresh[Math.floor(Math.random() * fresh.length)];
  picks[leadId] = m.name;
  await store.putSetting(d.rep.closeUserId, "memePicks", picks).catch(() => {});
  return m;
}

/** Set (or clear, with null) the meme for a lead's next bump. */
export async function pickMeme(d: Deps, leadId: string, name: string | null) {
  const picks = await picksOf(d);
  if (name !== null) {
    const memes = await listMemes({ sync: false });
    if (!memes.some((m) => m.name === name)) throw new MemeError(`There's no meme called "${name}".`);
    if ((await memesSeen(d)).get(leadId)?.has(name)) throw new MemeError("They've already been sent that one. Pick another.");
  }
  picks[leadId] = name;
  await store.putSetting(d.rep.closeUserId, "memePicks", picks);
  return { leadId, meme: name };
}

/** After a bump goes out with a meme, the pick is used up: the next bump gets a new one. */
export async function clearPick(d: Deps, leadId: string) {
  const picks = await picksOf(d);
  if (leadId in picks) { delete picks[leadId]; await store.putSetting(d.rep.closeUserId, "memePicks", picks).catch(() => {}); }
}

/** The email as HTML: the paragraphs, then the meme, then the name. */
export function bumpHtml(body: string, repName: string, meme: Meme | null) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = body.trim().split(/\n\s*\n/);
  const sig = paras[paras.length - 1] === repName ? paras.pop()! : null;
  const html = paras.map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`);
  if (meme) html.push(`<p><img src="${meme.url}" alt="" width="480" style="max-width:480px;width:100%;height:auto;border:0;display:block"></p>`);
  if (sig) html.push(`<p>${esc(sig)}</p>`);
  return html.join("");
}
