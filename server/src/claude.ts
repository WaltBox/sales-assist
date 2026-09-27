import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod/v4";
import { config, playbook } from "./config.js";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Org-level API keys (not scoped to a workspace) must say which workspace to use.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  client ??= new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
  return client;
}

export class ClaudeError extends Error {}

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
