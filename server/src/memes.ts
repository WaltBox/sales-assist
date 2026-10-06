import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
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
export async function memeFor(d: Deps, leadId: string, ctx?: { memes: Meme[]; seen: Map<string, Set<string>>; picks: Picks; dealt?: Map<string, number> }): Promise<Meme | null> {
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
  // Dealt evenly (Walt 10/5): every wave is split across all the memes, so each one gets a same-size sample fast and
  // the results compare. First by how often it's been dealt in this wave (the shared tally), then by how many
  // companies it's gone to overall, ties at random. A brand-new meme joins the rotation; it doesn't take over a wave.
  const now = ctx ? (ctx.dealt ??= new Map<string, number>()) : new Map<string, number>();
  const ever = new Map<string, number>();
  for (const names of (ctx?.seen ?? (await memesSeen(d))).values()) for (const n of names) ever.set(n, (ever.get(n) ?? 0) + 1);
  const key = (m: Meme) => (now.get(m.name) ?? 0) * 1e6 + (ever.get(m.name) ?? 0);
  const low = Math.min(...fresh.map(key));
  const pool = fresh.filter((m) => key(m) === low);
  const m = pool[Math.floor(Math.random() * pool.length)];
  now.set(m.name, (now.get(m.name) ?? 0) + 1);
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

// ---------- the meme library (Walt 10/5): upload a file or a zip, rename, retire, from the Automatic emails page ----------

/** A safe file name: lowercase, dashes for spaces, the extension kept. "Walter White (1).JPG" → "walter-white-1.jpg". */
export function memeName(raw: string): string {
  const base = path.basename(raw).replace(/\\/g, "/").split("/").pop() ?? raw;
  const m = base.match(/^(.*)\.([a-z0-9]+)$/i);
  if (!m || !IMAGE.test(base)) throw new MemeError(`${base}: not an image (jpg, png, gif or webp).`);
  const stem = m[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!stem) throw new MemeError(`${base}: needs a name.`);
  return `${stem}.${m[2].toLowerCase()}`;
}

/** The images inside an upload: the file itself, or everything in a zip (folders flattened, junk skipped). */
export function unpackUpload(filename: string, body: Buffer): Array<{ name: string; data: Buffer }> {
  if (/\.zip$/i.test(filename) || (body[0] === 0x50 && body[1] === 0x4b && !IMAGE.test(filename))) {
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(new Uint8Array(body)); } catch { throw new MemeError("That zip couldn't be opened."); }
    const out: Array<{ name: string; data: Buffer }> = [];
    for (const [entry, data] of Object.entries(files)) {
      const base = entry.split("/").pop() ?? "";
      if (!base || base.startsWith(".") || entry.includes("__MACOSX") || !IMAGE.test(base) || !data.length) continue;
      out.push({ name: memeName(base), data: Buffer.from(data) });
    }
    if (!out.length) throw new MemeError("No images in that zip (jpg, png, gif or webp).");
    return out;
  }
  return [{ name: memeName(filename), data: body }];
}

async function putObject(name: string, data: Buffer) {
  const { base, headers } = storage();
  const ext = name.split(".").pop()!.toLowerCase();
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`, { method: "POST", headers: { ...headers, "content-type": TYPES[ext] ?? "application/octet-stream", "x-upsert": "true" }, body: data });
  if (!res.ok) throw new MemeError(`Couldn't upload ${name}: ${res.status} ${(await res.text()).slice(0, 120)}`);
  // Keep the local folder in step when it's writable (it isn't on Vercel; the bucket is what counts).
  try { if (fs.existsSync(MEMES_DIR)) fs.writeFileSync(path.join(MEMES_DIR, name), data); } catch { /* read-only host */ }
}

/** Upload one image or a zip of them. Returns the names that went in (existing names are overwritten). */
export async function uploadMemes(filename: string, body: Buffer): Promise<string[]> {
  if (body.length > 25 * 1024 * 1024) throw new MemeError("That upload is over 25 MB.");
  const files = unpackUpload(filename, body);
  for (const f of files) {
    if (f.data.length > 5 * 1024 * 1024) throw new MemeError(`${f.name} is over 5 MB; email apps won't load it.`);
    await putObject(f.name, f.data);
  }
  synced = Date.now();
  return files.map((f) => f.name);
}

/** Rename a meme: the file in the bucket, the local copy, and every place its name is remembered (sent bumps, picks, rescue sends). */
export async function renameMeme(repId: string, from: string, to: string): Promise<string> {
  const { base, headers } = storage();
  const next = memeName(to.includes(".") ? to : `${to}.${from.split(".").pop()}`);
  if (next === from) return from;
  const have = new Set((await bucketFiles(base, headers)).map((m) => m.name));
  if (!have.has(from)) throw new MemeError(`${from} isn't in the library.`);
  if (have.has(next)) throw new MemeError(`There's already a meme called ${next}.`);
  const res = await fetch(`${base}/storage/v1/object/move`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ bucketId: BUCKET, sourceKey: from, destinationKey: next }) });
  if (!res.ok) throw new MemeError(`Couldn't rename: ${res.status} ${(await res.text()).slice(0, 120)}`);
  try { if (fs.existsSync(path.join(MEMES_DIR, from))) fs.renameSync(path.join(MEMES_DIR, from), path.join(MEMES_DIR, next)); } catch { /* read-only host */ }
  await moveMemeRefs(repId, from, next);
  return next;
}

/** Every record that names a meme follows a rename, so "already sent to them" stays true. */
export async function moveMemeRefs(repId: string, from: string, to: string) {
  for (const a of await store.listAutomations(repId, new Date(0).toISOString())) if (a.meme === from) await store.putAutomation({ ...a, meme: to });
  const rescue = (await store.getSetting<Record<string, string[]>>(repId, "rescueMemes").catch(() => null)) ?? {};
  let touched = false;
  for (const [lead, names] of Object.entries(rescue)) if (names.includes(from)) { rescue[lead] = [...new Set(names.map((n) => (n === from ? to : n)))]; touched = true; }
  if (touched) await store.putSetting(repId, "rescueMemes", rescue);
  const picks = (await store.getSetting<Picks>(repId, "memePicks").catch(() => null)) ?? {};
  let picked = false;
  for (const [lead, name] of Object.entries(picks)) if (name === from) { picks[lead] = to; picked = true; }
  if (picked) await store.putSetting(repId, "memePicks", picks);
}

/** Take a meme out of the rotation. What was already sent stays on record. */
export async function deleteMeme(name: string) {
  const { base, headers } = storage();
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ prefixes: [name] }) });
  if (!res.ok) throw new MemeError(`Couldn't delete ${name}: ${res.status}`);
  try { if (fs.existsSync(path.join(MEMES_DIR, name))) fs.unlinkSync(path.join(MEMES_DIR, name)); } catch { /* read-only host */ }
  synced = Date.now();
}

/**
 * How each meme is doing (Walt 10/5): companies it went to, and of those, how many opened the email, wrote back,
 * or sent an RFQ within two weeks of getting it. Attribution is per bump: a reply after a bump counts for the meme
 * in that bump, and only the first bump before the reply gets it.
 */
export type MemeStats = Record<string, { sent: number; opened: number; replied: number; rfq: number }>;
export async function memeStats(d: Deps, accounts: Array<{ leadId: string; opens: { last: string | null }; events: Array<{ at: string; kind: string }>; rfq: { at: string } | null }>): Promise<MemeStats> {
  const DAY = 86_400_000;
  const out: MemeStats = {};
  const row = (n: string) => (out[n] ??= { sent: 0, opened: 0, replied: 0, rfq: 0 });
  const byLead = new Map(accounts.map((a) => [a.leadId, a]));
  const autos = (await store.listAutomations(d.rep.closeUserId, new Date(0).toISOString())).filter((a) => a.meme && a.status === "sent" && a.statusAt);
  // Newest bump first per lead, so a reply is credited to the bump right before it.
  autos.sort((a, b) => b.statusAt!.localeCompare(a.statusAt!));
  const credited = new Set<string>();
  for (const au of autos) {
    const r = row(au.meme!);
    r.sent++;
    const a = byLead.get(au.leadId);
    if (!a) continue;
    const t0 = new Date(au.statusAt!).getTime(), t1 = t0 + 14 * DAY;
    const within = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() > t0 && new Date(iso).getTime() <= t1;
    if (within(a.opens.last) && !credited.has(`${au.leadId}:open:${a.opens.last}`)) { r.opened++; credited.add(`${au.leadId}:open:${a.opens.last}`); }
    const reply = a.events.find((e) => e.kind === "reply" && within(e.at));
    if (reply && !credited.has(`${au.leadId}:reply:${reply.at}`)) { r.replied++; credited.add(`${au.leadId}:reply:${reply.at}`); }
    if (a.rfq && within(a.rfq.at) && !credited.has(`${au.leadId}:rfq`)) { r.rfq++; credited.add(`${au.leadId}:rfq`); }
  }
  return out;
}

/** How many companies each meme has gone to (sent bumps, rescue sends, call-screen bumps). */
export async function memeCounts(d: Deps): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const names of (await memesSeen(d)).values()) for (const n of names) out[n] = (out[n] ?? 0) + 1;
  return out;
}
