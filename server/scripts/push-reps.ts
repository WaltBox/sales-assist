// Copy reps.json into the Supabase reps table (the old side-panel tokens are stored hashed).
// People who sign up with their email and Close API key are added on their own.
// Run after SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are in .env:
//   npm run push-reps
import fs from "node:fs";
import { config } from "../src/config.js";
import { hashToken } from "../src/store.js";

if (!config.supabaseUrl || !config.supabaseKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.");
  process.exit(1);
}
const reps = JSON.parse(fs.readFileSync(config.repsFile, "utf8")) as Array<{ token: string; name: string; email: string; close_api_key: string; timezone?: string }>;
const rows = reps.map((r) => ({ email: r.email.trim().toLowerCase(), token_hash: hashToken(r.token), name: r.name, close_api_key: r.close_api_key, timezone: r.timezone ?? null, active: true }));
const res = await fetch(`${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/reps?on_conflict=email`, {
  method: "POST",
  headers: { apikey: config.supabaseKey, authorization: `Bearer ${config.supabaseKey}`, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify(rows),
});
if (!res.ok) {
  console.error(`Supabase said ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log(`Pushed ${rows.length} rep${rows.length === 1 ? "" : "s"}: ${reps.map((r) => r.name).join(", ")}. They sign in with their email.`);
