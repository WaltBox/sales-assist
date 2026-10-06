import assert from "node:assert/strict";
import { test } from "node:test";
import { askNext, confirmAnswers, extractPurchasing, mergePurchasing, purchasingNote, rfqsPerWeek, tierFromPurchasing, type Purchasing } from "../src/purchasing.js";
import { loadProfiles, recordPurchasing, tierFor, emptyProfile } from "../src/potential.js";
import { store } from "../src/store.js";
import type { Deps } from "../src/assistant.js";
import { FakeClose } from "../src/demo.js";

const T1 = "2026-10-01T16:00:00Z", T2 = "2026-10-05T16:00:00Z";
const a = (value: string, confirmed = false, at = T1, quote: string | null = null) => ({ value, quote, at, confirmed });

test("RFQs per week from what buyers say", () => {
  assert.equal(rfqsPerWeek("~15/week"), 15);
  assert.equal(rfqsPerWeek("2-3/month"), 0.6);
  assert.equal(rfqsPerWeek("a few a year"), 0);
  assert.equal(rfqsPerWeek("once a week, every couple weeks"), 0.5);
  assert.equal(rfqsPerWeek("3 a day"), 15);
  assert.equal(rfqsPerWeek(null), null);
  assert.equal(rfqsPerWeek("whenever"), null);
});

test("the tier from the answers: volume first, a locked-in vendor beats everything", () => {
  assert.equal(tierFromPurchasing({ rfq_volume: a("~15/week") }), "steady");
  assert.equal(tierFromPurchasing({ rfq_volume: a("once a week, every couple weeks") }), "project");
  assert.equal(tierFromPurchasing({ rfq_volume: a("a few a year") }), "occasional");
  assert.equal(tierFromPurchasing({ rfq_volume: a("~15/week"), vendor_policy: a("contract elsewhere") }), "occasional");
  assert.equal(tierFromPurchasing({ buying_mode: a("project") }), "project");
  assert.equal(tierFromPurchasing({ incumbent: a("McJunkin") }), null);
  assert.equal(tierFromPurchasing(null), null);
  // On the profile, what was heard beats the site read and the quick tap.
  assert.equal(tierFor({ ...emptyProfile(null), type: "plant", repSaid: "projects", heard: { rfq_volume: a("20/week") } }), "steady");
});

test("ask next: volume, then the vendor list, then how to get on it (only when there is one)", () => {
  assert.equal(askNext(null)!.field, "rfq_volume");
  assert.equal(askNext({ rfq_volume: a("5/week") })!.field, "vendor_policy");
  assert.equal(askNext({ rfq_volume: a("5/week"), vendor_policy: a("open bid") })!.field, "buying_mode");
  assert.equal(askNext({ rfq_volume: a("5/week"), vendor_policy: a("preferred list") })!.field, "how_to_get_on_list");
  const full: Purchasing = { rfq_volume: a("5"), vendor_policy: a("open bid"), buying_mode: a("both"), incumbent: a("x"), works_through: a("GC"), buyer_count: a("2") };
  assert.equal(askNext(full), null);
});

test("merging: newer wins, but a confirmed answer isn't overwritten by a later unconfirmed read of the same day", () => {
  const prev: Purchasing = { rfq_volume: a("10/week", true, T1), incumbent: a("Ferguson", false, T1) };
  const next: Purchasing = { rfq_volume: a("15/week", false, T1), incumbent: a("McJunkin", false, T2), buyer_count: a("3", false, T2) };
  const m = mergePurchasing(prev, next);
  assert.equal(m.rfq_volume!.value, "10/week");
  assert.equal(m.incumbent!.value, "McJunkin");
  assert.equal(m.buyer_count!.value, "3");
});

test("the rep's confirmation: given fields become confirmed, empty clears, the quote is kept when the value didn't change", () => {
  const prev: Purchasing = { rfq_volume: a("15/week", false, T1, "fifteen or so"), incumbent: a("Ferguson", false, T1, "we use Ferguson") };
  const c = confirmAnswers(prev, { rfq_volume: "15/week", incumbent: "", buyer_count: "2" }, {}, T2);
  assert.equal(c.rfq_volume!.confirmed, true);
  assert.equal(c.rfq_volume!.quote, "fifteen or so");
  assert.equal(c.incumbent, undefined);
  assert.equal(c.buyer_count!.value, "2");
  assert.match(purchasingNote(c), /^\[Purchasing\] RFQs per week: 15\/week — “fifteen or so”\nBuyers on the team: 2$/);
});

test("from a transcript: only what the buyer said, each with their words; a short call gives nothing", async () => {
  const close = new FakeClose();
  const llm = (async () => ({ data: {
    rfq_volume: { value: "~15/week", quote: "we probably push out fifteen or so a week" }, rfq_timing: null, buying_mode: { value: "project", quote: "it's all job by job" },
    vendor_policy: null, how_to_get_on_list: { value: " ", quote: "" }, works_through: null, buyer_count: null, incumbent: { value: "McJunkin", quote: "McJunkin mostly" }, cycle_notes: null,
  }, usage: {} })) as unknown as Deps["llm"];
  const d: Deps = { close, llm, now: () => new Date(T2), rep: { name: "Walt", email: "walt@westgatesupply.com", closeUserId: "user_purch_test", timeZone: "America/Los_Angeles" } };
  const long = "buyer words ".repeat(80);
  const p = await extractPurchasing(d, "Acme", long, T2);
  assert.deepEqual(Object.keys(p).sort(), ["buying_mode", "incumbent", "rfq_volume"]);
  assert.equal(p.rfq_volume!.quote, "we probably push out fifteen or so a week");
  assert.equal(p.rfq_volume!.confirmed, false);
  assert.deepEqual(await extractPurchasing(d, "Acme", "too short", T2), {});

  // Saved as heard: the tier moves now; the rep's confirmation writes the Close note and keeps the quotes.
  await store.putSetting(d.rep.closeUserId, "profiles", {});
  const heard = await recordPurchasing(d, "lead_p", p);
  assert.equal(heard.tier, "steady");
  assert.equal(heard.ask!.field, "vendor_policy");
  assert.ok(!close.writes.some((w) => w.op === "note"), "no note until the rep confirms");
  const confirmed = await recordPurchasing(d, "lead_p", confirmAnswers(heard.profile.heard, { rfq_volume: "~15/week", vendor_policy: "preferred list" }, {}, T2), { note: true, replace: true });
  assert.equal(confirmed.ask!.field, "how_to_get_on_list");
  assert.equal((await loadProfiles(d.rep.closeUserId)).lead_p.heard!.rfq_volume!.confirmed, true);
  const note = close.writes.find((w) => w.op === "note");
  assert.ok(note && /\[Purchasing\] RFQs per week: ~15\/week — “we probably push out fifteen/.test((note.body as { note: string }).note));
});
