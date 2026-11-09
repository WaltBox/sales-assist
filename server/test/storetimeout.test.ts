import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseStore } from "../src/store.js";

test("a store call that gets no answer fails in the time allowed, not when Vercel gives up five minutes later (11/9)", async () => {
  const realFetch = globalThis.fetch;
  // Supabase on a bad afternoon: the connection opens and nothing ever comes back.
  globalThis.fetch = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;
  try {
    const s = new SupabaseStore("https://store.example", "key", 50);
    const t0 = Date.now();
    await assert.rejects(s.getRep("walt@westgatesupply.com"), /Supabase GET reps: no answer in 50ms/);
    assert.ok(Date.now() - t0 < 2_000, "gave up on time");
    await assert.rejects(s.cacheGet("race:team"), /Supabase GET brief_cache: no answer/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the store's time limit is ten seconds unless STORE_TIMEOUT_MS says otherwise", () => {
  const was = process.env.STORE_TIMEOUT_MS;
  try {
    delete process.env.STORE_TIMEOUT_MS;
    assert.equal((new SupabaseStore("https://store.example", "key") as unknown as { timeoutMs: number }).timeoutMs, 10_000);
    process.env.STORE_TIMEOUT_MS = "2500";
    assert.equal((new SupabaseStore("https://store.example", "key") as unknown as { timeoutMs: number }).timeoutMs, 2_500);
  } finally {
    if (was === undefined) delete process.env.STORE_TIMEOUT_MS; else process.env.STORE_TIMEOUT_MS = was;
  }
});
