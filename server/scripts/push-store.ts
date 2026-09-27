// One-time copy of the local store (.cache/store.json) into Supabase, before switching to hosting:
// your sign-in, settings (like which rescue drafts already exist in Close, so they aren't made twice),
// recent call reviews, automatic-email log, and cached briefs. Close data isn't copied: it stays in Close.
//   npm run push-store
import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "../src/config.js";
import { SupabaseStore, type Automation, type User } from "../src/store.js";

if (!config.supabaseUrl || !config.supabaseKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.");
  process.exit(1);
}
const file = path.join(ROOT, ".cache", "store.json");
const m = JSON.parse(fs.readFileSync(file, "utf8")) as {
  users: Record<string, User>; settings: Record<string, unknown>; automations: Record<string, Automation>;
  reviews: Record<string, { data: { id: string; repId: string; leadId: string; callId: string | null; state: string; createdAt: string } }>;
  cache: Record<string, { expires: number; value: unknown }>;
};
const sb = new SupabaseStore(config.supabaseUrl.replace(/\/$/, ""), config.supabaseKey);

let n = { users: 0, settings: 0, reviews: 0, automations: 0, cache: 0 };
for (const u of Object.values(m.users ?? {})) { await sb.putUser(u); n.users++; }
for (const [k, v] of Object.entries(m.settings ?? {})) {
  const i = k.indexOf(":");
  await sb.putSetting(k.slice(0, i), k.slice(i + 1), v);
  n.settings++;
}
const since = new Date(Date.now() - 8 * 86400e3).toISOString();
for (const r of Object.values(m.reviews ?? {})) {
  if (r.data.createdAt < since && r.data.state !== "ready") continue;
  await sb.putReview(r.data);
  n.reviews++;
}
for (const a of Object.values(m.automations ?? {})) { await sb.putAutomation(a); n.automations++; }
for (const [k, v] of Object.entries(m.cache ?? {})) {
  const left = v.expires - Date.now();
  if (left <= 0) continue;
  await sb.cacheSet(k, v.value, left);
  n.cache++;
}
console.log(`Copied to Supabase: ${n.users} sign-in, ${n.settings} settings, ${n.reviews} reviews, ${n.automations} automatic emails, ${n.cache} cached briefs/names.`);
