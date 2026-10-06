import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

const Rep = z.object({
  token: z.string().min(24, "rep token must be at least 24 characters"),
  name: z.string(),
  email: z.string(),
  close_api_key: z.string(),
  timezone: z.string().default("America/Los_Angeles"),
});
export type Rep = z.infer<typeof Rep>;

export const config = {
  port: Number(process.env.PORT ?? 3001), // the web app, and the API the side panel talks to
  model: process.env.CLAUDE_MODEL ?? "claude-opus-5",
  // Brief and chat run while the rep is about to dial, so they favor speed.
  // Per-feature models: the brief and chat are waited on before a dial, so they default to the faster model.
  briefModel: process.env.BRIEF_MODEL ?? "claude-sonnet-5",
  chatModel: process.env.CHAT_MODEL ?? "claude-sonnet-5",
  // When the calling day ends, for the dial pace (HH:MM, rep's local time). Walt 9/29: "we end at 3:30".
  dayEnd: /^\d{1,2}:\d{2}$/.test(process.env.DAY_END ?? "") ? process.env.DAY_END! : "15:30",
  // Automatic emails start in test mode (only Test Lead Fabrication) until the rep turns it off (10/1).
  autoTestModeDefault: process.env.AUTO_TEST_MODE !== "0",
  // Which AI writes by default (Walt 9/30: "we're going to be using OpenAI by default now"). The other one is the
  // backup when the first is down. LLM_PROVIDER=claude switches back.
  provider: (process.env.LLM_PROVIDER === "claude" ? "claude" : "openai") as "openai" | "claude",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.1",
  // For the jobs that use the faster Claude model (brief, chat, after-call, email): waited on during calls.
  // gpt-5-mini needs a verified OpenAI organization (9/30); until then the fast jobs use gpt-5.1 too.
  openaiFastModel: process.env.OPENAI_FAST_MODEL ?? "gpt-5.1",
  afterCallModel: process.env.AFTER_CALL_MODEL ?? "claude-sonnet-5",
  emailModel: process.env.EMAIL_MODEL ?? "claude-sonnet-5",
  effortEmail: (process.env.EFFORT_EMAIL ?? "medium") as "low" | "medium" | "high",
  effortFast: (process.env.EFFORT_FAST ?? "low") as "low" | "medium" | "high",
  effortAfterCall: (process.env.EFFORT_AFTER_CALL ?? "low") as "low" | "medium" | "high",
  demo: process.env.DEMO === "1",
  closeBaseUrl: process.env.CLOSE_BASE_URL ?? "https://api.close.com/api/v1",
  // Comma-separated chrome-extension://<id> origins allowed to call the API.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  repsFile: process.env.REPS_FILE ?? path.join(ROOT, "reps.json"),
  // Hosted: Supabase (service-role key, server side only). Local: one JSON file. BRIEF_CACHE_FILE=off: memory only (tests).
  supabaseUrl: process.env.SUPABASE_URL ?? null,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null,
  storeFile: process.env.BRIEF_CACHE_FILE === "off" || process.env.DEMO === "1" ? null : path.join(ROOT, ".cache", "store.json"),
  // Verifies Close webhook calls (from the webhook subscription's signature_key).
  closeWebhookKey: process.env.CLOSE_WEBHOOK_SIGNATURE_KEY ?? null,
  // Signs sign-in sessions. Required when hosted; locally a random one is kept in .cache.
  sessionSecret: process.env.SESSION_SECRET ?? null,
  // Protects the scheduled catch-up job (Vercel sends it as a bearer token).
  cronSecret: process.env.CRON_SECRET ?? null,
  // How long the background builder waits for Close's transcript before building from what it has.
  // Close transcribes in about a minute; a hard stop at 3 means a call never hangs (polled every 15s).
  transcriptWaitMs: Number(process.env.TRANSCRIPT_WAIT_MS ?? (process.env.DEMO === "1" ? 6000 : 3 * 60 * 1000)),
  // Save contacts, notes, email drafts and extra tasks to Close as soon as the transcript is read
  // (drafts are never sent). AUTO_SAVE=0 goes back to approving each call in the panel.
  autoSave: process.env.AUTO_SAVE !== "0",
  lineCardTemplateId: process.env.LINE_CARD_TEMPLATE_ID ?? "tmpl_h0xbgrP8EjkmKlb5zMD8gKpHzfd8khSxYt2EpqoTeLA",
  // Bump when the brief format changes so old cached briefs are ignored. v10: openers always name 3-4 specific products.
  // v11: two short sentences, no "[crews] use for" clause (Walt 9/28).
  // v12: PVF first, with a flag and the old pitch as the alternative when they likely don't buy PVF (Walt 10/5).
  briefVersion: "v12",
};

export function loadReps(): Map<string, Rep> {
  if (config.demo) {
    return new Map([["demo-token-demo-token-demo-token", Rep.parse({
      token: "demo-token-demo-token-demo-token", name: "Walt Boxwell", email: "walt@westgatesupply.com", close_api_key: "demo",
    })]]);
  }
  // Hosted, reps come from the Supabase reps table instead; reps.json is optional. Never crash on startup
  // over it: /api/health says what's missing.
  if (!fs.existsSync(config.repsFile)) {
    if (!config.supabaseUrl) console.warn(`No ${path.basename(config.repsFile)} and no SUPABASE_URL: nobody can sign in until one is set.`);
    return new Map();
  }
  const reps = z.array(Rep).parse(JSON.parse(fs.readFileSync(config.repsFile, "utf8")));
  return new Map(reps.map((r) => [r.token, r]));
}

// Standing instructions: the sales playbook plus the Email & Product Knowledge Playbook.
export const playbook = [
  fs.readFileSync(path.join(ROOT, "playbook", "westgate-playbook.md"), "utf8"),
  fs.readFileSync(path.join(ROOT, "playbook", "westgate-email-playbook.md"), "utf8"),
].join("\n\n---\n\n");

export const competitors: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, "playbook", "competitors.json"), "utf8"));
