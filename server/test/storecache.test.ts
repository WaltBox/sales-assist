import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseStore } from "../src/store.js";

// The store's short memory for reads (11/10): a screen polling every few seconds is one database read, not one per poll.

function stubbed(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ method: string; url: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ method: init.method ?? "GET", url: String(url) }); return answer(String(url), init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

test("the same read within a few seconds comes from memory; a write forgets the table; a failed read isn't kept", async () => {
  let fail = false;
  const f = stubbed((url) => {
    if (fail) return new Response("gone", { status: 503 });
    if (url.includes("/reps?")) return json([{ email: "walt@westgatesupply.com", name: "Walt", close_api_key: "k", timezone: null }]);
    if (url.includes("/settings?")) return json([{ value: { pace: 20 } }]);
    return json([]);
  });
  try {
    const s = new SupabaseStore("https://store.example", "key", 500);
    assert.equal((await s.getRep("walt@westgatesupply.com"))?.name, "Walt");
    assert.equal((await s.getRep("walt@westgatesupply.com"))?.name, "Walt");
    await s.getSetting("user_1", "pace");
    await s.getSetting("user_1", "pace");
    await s.getSetting("user_1", "pace");
    assert.equal(f.calls.filter((c) => c.method === "GET").length, 2, "one trip each for the rep and the setting");
    assert.deepEqual(s.counts, { remembered: 3, fetched: 2 });
    // A write to a setting forgets that setting's reads, and only those.
    await s.getSetting("user_1", "other");
    await s.putSetting("user_1", "pace", { pace: 10 });
    await s.getSetting("user_1", "pace");
    await s.getSetting("user_1", "other");
    await s.getRep("walt@westgatesupply.com");
    assert.equal(f.calls.filter((c) => c.method === "GET").length, 4, "pace was read again; other and the rep weren't");
    // The same for one cache key.
    await s.cacheGet("race:live:a"); await s.cacheGet("race:team");
    await s.cacheSet("race:live:a", 1, 1000);
    await s.cacheGet("race:live:a"); await s.cacheGet("race:team");
    assert.equal(f.calls.filter((c) => c.url.includes("/brief_cache?")).length, 4, "two reads, the write, and one read again");
    // Two askers at once share one trip.
    await Promise.all([s.getSetting("user_2", "pace"), s.getSetting("user_2", "pace")]);
    assert.equal(f.calls.filter((c) => c.url.includes("user_2")).length, 1);
    // A failure isn't remembered.
    fail = true;
    await assert.rejects(s.getSetting("user_3", "pace"), /503/);
    fail = false;
    await s.getSetting("user_3", "pace");
    assert.equal(f.calls.filter((c) => c.url.includes("user_3")).length, 2, "asked again after the failure");
  } finally { f.restore(); }
});

test("'since now' asked twice in a row is one read: the timestamp rounds to ten seconds; a table with no memory reads every time", async () => {
  const f = stubbed(() => json([]));
  try {
    const s = new SupabaseStore("https://store.example", "key", 500);
    await s.listReviews("user_1", new Date(Date.now() - 8 * 86_400_000).toISOString());
    await new Promise((r) => setTimeout(r, 30));
    await s.listReviews("user_1", new Date(Date.now() - 8 * 86_400_000).toISOString());
    const reviews = f.calls.filter((c) => c.url.includes("/reviews?"));
    assert.ok(reviews.length <= 2 && reviews.length >= 1);
    if (reviews.length === 2) assert.notEqual(reviews[0].url.slice(0, -12), reviews[1].url.slice(0, -12), "two trips only when the ten-second mark passed between them");
    await s.cacheGet("race:live");
    await s.cacheGet("race:live");
    assert.equal(f.calls.filter((c) => c.url.includes("/brief_cache?")).length, 1, "the race's live check: one trip for both");
    await s.rejections(5);
    await s.rejections(5);
    assert.equal(f.calls.filter((c) => c.url.includes("/draft_rejections?")).length, 2, "no memory for that table");
  } finally { f.restore(); }
});
