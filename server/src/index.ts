import { config } from "./config.js";
import { app, reps } from "./server.js";
import { hosted, migrateOldCache } from "./store.js";

migrateOldCache();

app.listen(config.port, () => {
  console.log(`Westgate Sales Assistant server on http://localhost:${config.port} (${config.demo ? "DEMO mode" : `model ${config.model}`}, ${reps.size} rep${reps.size === 1 ? "" : "s"}${hosted ? ", Supabase" : ""})`);
  if (config.demo) console.log(`Preview the panel: http://localhost:${config.port}/preview/sidepanel.html?lead=lead_demoRoddaElectric0001&token=demo-token-demo-token-demo-token`);
});

// A long-running server doesn't need Vercel Cron: move waiting reviews along every 15 seconds.
const catchUp = app.locals.catchUp as () => Promise<unknown>;
let running = false;
setInterval(() => {
  if (running) return;
  running = true;
  catchUp().catch((err) => console.error("catch-up:", (err as Error).message)).finally(() => { running = false; });
}, 15_000);
