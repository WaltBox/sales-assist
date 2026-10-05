import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { config, playbook } from "./config.js";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Org-level API keys (not scoped to a workspace) must say which workspace to use.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  client ??= new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
  return client;
}

export class ClaudeError extends Error {}

// When Claude is down (Walt 9/29: "503 credential validation failed" during an Anthropic outage), the same
// request goes to OpenAI instead, if OPENAI_API_KEY is set. Only outages fall back, not our own bad requests.
export function claudeIsDown(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (!(err instanceof Anthropic.APIError)) return false;
  const status = err.status ?? 0;
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

type Usage = Anthropic.Beta.BetaUsage;

/** Claude's turns as plain chat messages (text only; this app never sends images). */
export function toChatMessages(system: string, messages: Anthropic.Beta.BetaMessageParam[]) {
  const text = (c: Anthropic.Beta.BetaMessageParam["content"]) =>
    typeof c === "string" ? c : c.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n\n");
  return [{ role: "system" as const, content: system }, ...messages.map((m) => ({ role: m.role, content: text(m.content) }))];
}

/** The OpenAI model for a job: Claude's faster models (Sonnet, Haiku) map to the fast one, the rest to the main one. */
export const openaiModelFor = (claudeModel: string | undefined) => (/sonnet|haiku/i.test(claudeModel ?? config.model) ? config.openaiFastModel : config.openaiModel);

/** An OpenAI failure that's an outage (no connection, rate limit, a 5xx, a rejected key), not a bad answer. */
export class OpenAIDown extends ClaudeError {}

/** The same structured call, answered by OpenAI. */
export async function openaiStructured<S extends z.ZodType>(schema: S, system: string, messages: Anthropic.Beta.BetaMessageParam[], effort: "low" | "medium" | "high", task: string, model = config.openaiModel, role: "backup" | "primary" = "backup"): Promise<{ data: z.infer<S>; usage: Usage }> {
  const who = role === "backup" ? "Claude is down and the OpenAI backup" : "OpenAI";
  const started = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: toChatMessages(system, messages),
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: z.toJSONSchema(schema), strict: false } },
      max_completion_tokens: 16000,
      ...(/^(gpt-5|o\d)/.test(model) ? { reasoning_effort: effort } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch((e: Error) => { throw new OpenAIDown(`${who} couldn't be reached (${e.message}).`); });
  const body = await res.json().catch(() => ({})) as {
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string };
  };
  if (!res.ok) {
    const msg = `${who} failed${role === "backup" ? " too" : ""} (${res.status}: ${body.error?.message ?? "no details"}).`;
    // 404: the model isn't open to this account (e.g. "organization must be verified"): also Claude's turn.
    throw [401, 403, 404, 429].includes(res.status) || res.status >= 500 ? new OpenAIDown(msg) : new ClaudeError(msg);
  }
  const choice = body.choices?.[0];
  console.log(`[openai ${model}${role === "backup" ? " · backup" : ""}] ${task.slice(0, 40).replace(/\s+/g, " ")}… ${((Date.now() - started) / 1000).toFixed(1)}s, ${body.usage?.prompt_tokens ?? "?"} in / ${body.usage?.completion_tokens ?? "?"} out`);
  if (choice?.message?.refusal) throw new ClaudeError(`${role === "backup" ? "The OpenAI backup" : "OpenAI"} declined this request.`);
  if (choice?.finish_reason === "length") throw new ClaudeError(`${role === "backup" ? "The OpenAI backup's" : "OpenAI's"} answer was cut off. Try again.`);
  let parsed: unknown;
  try { parsed = JSON.parse(choice?.message?.content ?? ""); } catch { parsed = undefined; }
  const ok = schema.safeParse(parsed);
  if (!ok.success) throw new ClaudeError(`${role === "backup" ? "The OpenAI backup" : "OpenAI"} returned an answer the app couldn't read. Try again.`);
  return { data: ok.data, usage: { input_tokens: body.usage?.prompt_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0 } as Usage };
}

/**
 * One structured call to Claude with the Westgate playbook as the standing
 * instructions. The playbook is a frozen prefix so it's cached across every
 * request from every rep; per-lead data goes in the user turn.
 */
export async function structured<S extends z.ZodType>(opts: {
  schema: S;
  task: string; // which job: brief / after-call / chat
  context: string; // lead data, wrapped as untrusted data
  messages?: Anthropic.Beta.BetaMessageParam[]; // prior chat turns
  effort: "low" | "medium" | "high";
  model?: string; // defaults to CLAUDE_MODEL
}): Promise<{ data: z.infer<S>; usage: Anthropic.Beta.BetaUsage }> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: opts.context },
    ...(opts.messages ?? []),
  ];
  // The API needs the last turn to be the user's; for brief/after-call the
  // task instruction is appended to the context turn.
  const last = messages[messages.length - 1];
  if (last.role === "user" && typeof last.content === "string") {
    messages[messages.length - 1] = { role: "user", content: `${last.content}\n\n${opts.task}` };
  } else {
    messages.push({ role: "user", content: opts.task });
  }

  // OpenAI first (the default since 9/30); Claude only if OpenAI is down and there's a Claude key.
  if (config.provider === "openai" && process.env.OPENAI_API_KEY) {
    try {
      return await openaiStructured(opts.schema, playbook, messages, opts.effort, opts.task, openaiModelFor(opts.model), "primary");
    } catch (err) {
      if (!(err instanceof OpenAIDown) || !process.env.ANTHROPIC_API_KEY) throw err;
      console.warn(`[openai] ${(err as Error).message} Using Claude as the backup.`);
    }
  }

  let response;
  const started = Date.now();
  try {
    const model = opts.model ?? config.model;
    const format = betaZodOutputFormat(opts.schema);
    // Haiku takes no thinking/effort settings; server-side refusal fallback is an Opus/Fable feature.
    const tuning = /haiku/.test(model)
      ? { output_config: { format } }
      : { thinking: { type: "adaptive" as const }, output_config: { effort: opts.effort, format } };
    const fallback = /opus|fable/.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
    response = await getClient().beta.messages.parse({
      model,
      max_tokens: 16000,
      ...fallback,
      ...tuning,
      system: [{ type: "text", text: playbook, cache_control: { type: "ephemeral" } }],
      messages,
    });
  } catch (err) {
    if (config.provider === "claude" && process.env.OPENAI_API_KEY && claudeIsDown(err)) {
      console.warn(`[claude] ${err instanceof Anthropic.APIError ? `${err.status ?? "no connection"}: ${err.message}` : String(err)}; using the OpenAI backup`);
      return openaiStructured(opts.schema, playbook, messages, opts.effort, opts.task);
    }
    if (err instanceof Anthropic.RateLimitError) throw new ClaudeError("Claude is rate limited right now. Try again in a few seconds.");
    if (err instanceof Anthropic.AuthenticationError) throw new ClaudeError("The server's Claude API key is invalid.");
    if (err instanceof Anthropic.APIError) throw new ClaudeError(`Claude API error ${err.status}: ${err.message}`);
    throw err;
  }

  console.log(`[claude ${opts.model ?? config.model}] ${opts.task.slice(0, 40).replace(/\s+/g, " ")}… ${((Date.now() - started) / 1000).toFixed(1)}s, ${response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0)} in / ${response.usage.output_tokens} out`);
  if (response.stop_reason === "refusal") throw new ClaudeError("Claude declined this request.");
  if (response.stop_reason === "max_tokens") throw new ClaudeError("Claude's answer was cut off. Try again.");
  if (!response.parsed_output) throw new ClaudeError("Claude returned an answer the app couldn't read. Try again.");
  return { data: response.parsed_output as z.infer<S>, usage: response.usage };
}

/** Wrap outside text so the model treats it as data, not instructions. */
export function untrusted(label: string, text: string): string {
  const safe = text.replaceAll("</untrusted", "<\\/untrusted");
  return `<untrusted source="${label}">\n${safe}\n</untrusted>`;
}
