import { SIGNATURE_LINE } from "./content/lineCard.js";
import { randomUUID } from "node:crypto";
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
  // "Ever" counts what's gone out AND what's already reserved for a coming bump (10/7: without the reservations,
  // the meme with the fewest sends won every small round of reservations and piled up 56 deep).
  const ever = new Map<string, number>();
  for (const names of (ctx?.seen ?? (await memesSeen(d))).values()) for (const n of names) ever.set(n, (ever.get(n) ?? 0) + 1);
  for (const [lead, name] of Object.entries(picks)) if (name && lead !== leadId && !seen.has(name)) ever.set(name, (ever.get(name) ?? 0) + 1);
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

// ---------- tracked memes (Walt 10/6): the image and the link go through our server, so a load or a click is logged ----------

/** One tracked email: who it went to and which meme; `emailId` is filled in once Close has created the email. */
export type MemeTrack = { token: string; repId: string; repName: string; repEmail: string; leadId: string; meme: string; emailId: string | null; createdAt: string; shown: string[]; clicked: string[]; agents: string[] };
const VIEWS_REP = "memeviews"; // the store's settings table, keyed by token under this fixed "rep"
export const newToken = () => randomUUID().replace(/-/g, "");
/** Tracking is on only when PUBLIC_URL is set (a domain of ours). */
export const trackingOn = () => !!config.publicUrl;
export const memeImageUrl = (token: string, name: string) => `${config.publicUrl}/m/${token}/${encodeURIComponent(name)}`;
export const memeViewUrl = (token: string, name: string) => `${memeImageUrl(token, name)}/view`;

export async function trackMeme(t: { token: string; repId: string; repName: string; repEmail: string; leadId: string; meme: string; emailId: string | null }) {
  const row: MemeTrack = { ...t, createdAt: new Date().toISOString(), shown: [], clicked: [], agents: [] };
  await store.putSetting(VIEWS_REP, t.token, row).catch(() => undefined);
}
/** The image loaded ("shown") or the link was followed ("clicked"). Unknown tokens are ignored. */
export async function logMemeEvent(token: string, kind: "shown" | "clicked", agent: string | null): Promise<MemeTrack | null> {
  const row = await store.getSetting<MemeTrack>(VIEWS_REP, token).catch(() => null);
  if (!row) return null;
  const at = new Date().toISOString();
  row[kind] = [...row[kind], at].slice(-50);
  if (agent && !row.agents.includes(agent)) row.agents = [...row.agents, agent.slice(0, 120)].slice(-5);
  await store.putSetting(VIEWS_REP, token, row).catch(() => undefined);
  return row;
}
export async function memeTrack(token: string): Promise<MemeTrack | null> {
  return store.getSetting<MemeTrack>(VIEWS_REP, token).catch(() => null);
}

/** The page the link opens: the meme, who it's from, and the ask. */
export function memeLanding(meme: Meme, repName: string, repEmail: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>From ${esc(repName)} at Westgate Supply</title>
<style>body{margin:0;background:#e5e0d1;color:#111114;font-family:Arial,Helvetica,sans-serif}main{max-width:560px;margin:0 auto;padding:32px 16px}img{width:100%;height:auto;display:block;border:1px solid #111114;background:#fff}h1{font-size:18px;margin:0 0 12px;letter-spacing:.04em;text-transform:uppercase}p{font-size:16px;line-height:1.5}a.btn{display:inline-block;margin-top:8px;padding:12px 18px;background:#dc0025;color:#fff;text-decoration:none;font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:13px}small{color:#53524f}</style></head>
<body><main><h1>Westgate Supply</h1><img src="${meme.url}" alt=""><p>That one's from ${esc(repName)}. If there's an RFQ on your desk, send it over and I'll price it.</p>
<a class="btn" href="mailto:${esc(repEmail)}?subject=RFQ%20for%20Westgate">Send an RFQ</a><p><small>Pipe, valves, fittings, flanges, plate and bolting. Mill certs included, counts match.</small></p></main></body></html>`;
}

/** The email as HTML: the paragraphs, then the meme, then the name. With a token, the image and the link are tracked. */
export function bumpHtml(body: string, repName: string, meme: Meme | null, token?: string | null) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = body.trim().split(/\n\s*\n/);
  // The keyword line (10/7) sits under the name; a meme goes above both.
  const keywords = paras[paras.length - 1] === SIGNATURE_LINE ? paras.pop()! : null;
  const sig = paras[paras.length - 1] === repName ? paras.pop()! : null;
  const link = (t: string) => t.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  const html = paras.map((p) => `<p>${link(esc(p)).replace(/\n/g, "<br>")}</p>`);
  if (meme) {
    const tracked = !!token && trackingOn();
    const src = tracked ? memeImageUrl(token!, meme.name) : meme.url;
    const link = tracked ? memeViewUrl(token!, meme.name) : meme.url;
    html.push(`<p><img src="${src}" alt="" width="480" style="max-width:480px;width:100%;height:auto;border:0;display:block"></p>`);
    // A lot of mail apps hide images until the reader clicks "show": the link gets them the meme anyway (Walt 10/6).
    html.push(`<p style="font-size:12px;color:#6b6b70">There's a hilarious meme in here. If it didn't come through, <a href="${link}" style="color:#1a4fa3;text-decoration:underline">here it is</a>.</p>`);
  }
  if (sig) html.push(`<p>${esc(sig)}</p>`);
  if (keywords) html.push(`<p style="font-size:12px;color:#6b6b70">${esc(keywords)}</p>`);
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
export type MemeStats = Record<string, { sent: number; opened: number; replied: number; rfq: number; shown: number; clicked: number; tracked: number }>;
export async function memeStats(d: Deps, accounts: Array<{ leadId: string; opens: { last: string | null }; events: Array<{ at: string; kind: string }>; rfq: { at: string } | null }>): Promise<MemeStats> {
  const DAY = 86_400_000;
  const out: MemeStats = {};
  const row = (n: string) => (out[n] ??= { sent: 0, opened: 0, replied: 0, rfq: 0, shown: 0, clicked: 0, tracked: 0 });
  const byLead = new Map(accounts.map((a) => [a.leadId, a]));
  const autos = (await store.listAutomations(d.rep.closeUserId, new Date(0).toISOString())).filter((a) => a.meme && a.status === "sent" && a.statusAt);
  // Newest bump first per lead, so a reply is credited to the bump right before it.
  autos.sort((a, b) => b.statusAt!.localeCompare(a.statusAt!));
  const credited = new Set<string>();
  const tracks = new Map(await Promise.all(autos.filter((a) => a.track).map(async (a) => [a.track!, await memeTrack(a.track!)] as const)));
  for (const au of autos) {
    const r = row(au.meme!);
    r.sent++;
    const t = au.track ? tracks.get(au.track) : null;
    if (t) { r.tracked++; if (t.shown.length) r.shown++; if (t.clicked.length) r.clicked++; }
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

/** How many companies each meme has gone to (sent, by Close) and how many it's queued for (scheduled, not yet sent). */
export async function memeCounts(d: Deps): Promise<Record<string, { sent: number; queued: number }>> {
  const out: Record<string, { sent: number; queued: number }> = {};
  const row = (n: string) => (out[n] ??= { sent: 0, queued: 0 });
  const sentTo = new Map<string, Set<string>>();
  for (const a of await store.listAutomations(d.rep.closeUserId, new Date(0).toISOString())) {
    if (!a.meme || !["scheduled", "sent"].includes(a.status)) continue;
    const key = `${a.leadId}:${a.meme}`;
    if (sentTo.get(a.meme)?.has(a.leadId)) continue;
    (sentTo.get(a.meme) ?? sentTo.set(a.meme, new Set()).get(a.meme)!).add(a.leadId);
    if (a.status === "sent") row(a.meme).sent++; else row(a.meme).queued++;
    void key;
  }
  // Rescue drafts and call-screen bumps went by hand: those count as sent.
  const rescue = (await store.getSetting<Record<string, string[]>>(d.rep.closeUserId, "rescueMemes").catch(() => null)) ?? {};
  for (const [leadId, names] of Object.entries(rescue)) for (const n of names) if (!sentTo.get(n)?.has(leadId)) { row(n).sent++; (sentTo.get(n) ?? sentTo.set(n, new Set()).get(n)!).add(leadId); }
  return out;
}
