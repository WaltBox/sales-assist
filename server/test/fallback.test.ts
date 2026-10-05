import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";

// Claude down → the same request goes to OpenAI (Walt 9/29, during an Anthropic outage).
test("only outages fall back to OpenAI, not our own bad requests", async () => {
  const { claudeIsDown } = await import("../src/claude.js");
  const err = (status: number) => Anthropic.APIError.generate(status, { error: { message: "x" } }, "x", new Headers());
  for (const s of [503, 529, 500, 401, 429]) assert.equal(claudeIsDown(err(s)), true, String(s));
  assert.equal(claudeIsDown(err(400)), false, "a bad request is our bug, not an outage");
  assert.equal(claudeIsDown(new Anthropic.APIConnectionError({ message: "socket hang up" })), true);
  assert.equal(claudeIsDown(new Error("something else")), false);
});

test("the OpenAI backup gets the playbook, the turns and the schema, and its answer is checked", async () => {
  const { openaiStructured } = await import("../src/claude.js");
  const schema = z.object({ opener: z.string(), buys: z.array(z.string()) });
  const real = globalThis.fetch;
  let sent: { messages: Array<{ role: string; content: string }>; response_format: { json_schema: { schema: { properties: object } } }; reasoning_effort?: string } | null = null;
  const reply = (content: string) => (async (_u: unknown, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  }) as never;
  try {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = reply(JSON.stringify({ opener: "Hi, this is Walt with Westgate Supply.", buys: ["Threaded rod"] }));
    const r = await openaiStructured(schema, "PLAYBOOK", [{ role: "user", content: [{ type: "text", text: "lead data" }] }, { role: "assistant", content: "ok" }, { role: "user", content: "task" }], "low", "brief");
    assert.deepEqual(r.data, { opener: "Hi, this is Walt with Westgate Supply.", buys: ["Threaded rod"] });
    assert.equal(r.usage.output_tokens, 5);
    assert.deepEqual(sent!.messages, [{ role: "system", content: "PLAYBOOK" }, { role: "user", content: "lead data" }, { role: "assistant", content: "ok" }, { role: "user", content: "task" }]);
    assert.ok("opener" in sent!.response_format.json_schema.schema.properties);
    assert.equal(sent!.reasoning_effort, "low");

    globalThis.fetch = reply(JSON.stringify({ opener: 5 }));
    await assert.rejects(openaiStructured(schema, "P", [{ role: "user", content: "x" }], "low", "brief"), /couldn't read/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as never;
    await assert.rejects(openaiStructured(schema, "P", [{ role: "user", content: "x" }], "low", "brief"), /OpenAI backup failed too \(401: bad key\)/);
  } finally {
    globalThis.fetch = real;
    delete process.env.OPENAI_API_KEY;
  }
});

test("OpenAI by default (9/30): Claude's fast models map to the fast OpenAI model; an OpenAI outage is marked so Claude can step in", async () => {
  const { openaiModelFor, openaiStructured, OpenAIDown } = await import("../src/claude.js");
  const { config } = await import("../src/config.js");
  assert.equal(openaiModelFor("claude-sonnet-5"), config.openaiFastModel);
  assert.equal(openaiModelFor("claude-opus-5"), config.openaiModel);
  const real = globalThis.fetch;
  try {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 })) as never;
    await assert.rejects(openaiStructured(z.object({ a: z.string() }), "P", [{ role: "user", content: "x" }], "low", "brief", "gpt-5.1", "primary"), (e: unknown) => e instanceof OpenAIDown && /^OpenAI failed \(503/.test((e as Error).message));
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "bad schema" } }), { status: 400 })) as never;
    await assert.rejects(openaiStructured(z.object({ a: z.string() }), "P", [{ role: "user", content: "x" }], "low", "brief", "gpt-5.1", "primary"), (e: unknown) => !(e instanceof OpenAIDown), "a bad request is our bug, not an outage");
  } finally {
    globalThis.fetch = real;
    delete process.env.OPENAI_API_KEY;
  }
});
