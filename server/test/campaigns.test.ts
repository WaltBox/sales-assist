import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { campaignBook, cloneSequence, DEFAULT_SEQUENCE, sequenceFor, STANDARD_ID } from "../src/cadence.js";
import { campaignStats, createCampaign, createCampaignFrom, deleteCampaign, listCampaigns, previewCampaign, saveCampaign, sequenceSeries, setLiveCampaign } from "../src/automations.js";
import { demoLineCards, demoLlm, FakeClose } from "../src/demo.js";
import { store, type Automation } from "../src/store.js";

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", timeZone: "America/Los_Angeles" };
const setup = (userId: string) => {
  const close = new FakeClose();
  demoLineCards(close);
  const d: Deps = { close, llm: demoLlm, rep: { ...rep, closeUserId: userId } };
  for (const e of close.sentEmails) e.user_id = userId;
  for (const t of close.extraTasks) t.assigned_to = userId;
  return { close, d };
};

test("sequences (11/10): Standard is listed first, built in, and live until another one is", async () => {
  const { d } = setup("user_cmp_a");
  const list = await listCampaigns(d);
  assert.equal(list.campaigns.length, 1);
  assert.equal(list.campaigns[0].id, STANDARD_ID);
  assert.equal(list.campaigns[0].readOnly, true);
  assert.equal(list.campaigns[0].live, true);
  assert.equal(list.campaigns[0].name, "Standard");
  assert.deepEqual(list.campaigns[0].stats, { sent: 0, rfqs: 0, stops: 0, steps: {} });
});

test("the builder's old single sequence (11/9) becomes a saved, live sequence, once", async () => {
  const { d } = setup("user_cmp_old");
  const old = cloneSequence(DEFAULT_SEQUENCE);
  old.name = "Old one";
  old.monthly.gap = 30;
  await store.putSetting(d.rep.closeUserId, "sequence", old);
  const book = await campaignBook(d.rep.closeUserId);
  assert.equal(book.campaigns.length, 1);
  assert.equal(book.campaigns[0].name, "Old one");
  assert.equal(book.liveId, book.campaigns[0].id);
  assert.equal((await sequenceFor(d.rep.closeUserId)).monthly.gap, 30, "it runs");
  const again = await campaignBook(d.rep.closeUserId);
  assert.equal(again.campaigns.length, 1, "read twice, moved once");
  assert.equal(again.campaigns[0].id, book.campaigns[0].id);
});

test("names are unique, Standard can't change or go, the live one can't go, and a bad line or a 0-day wait is refused in plain words", async () => {
  const { d } = setup("user_cmp_b");
  const a = await createCampaign(d, { name: "A" });
  await assert.rejects(createCampaign(d, { name: " a " }), /already a sequence called "a"/);
  await assert.rejects(createCampaign(d, { name: "standard" }), /already/);
  await assert.rejects(createCampaign(d, { name: "   " }), /Give the sequence a name/);
  await assert.rejects(saveCampaign(d, STANDARD_ID, DEFAULT_SEQUENCE), /can't change/);
  await assert.rejects(deleteCampaign(d, STANDARD_ID), /stays/);
  const b = await createCampaign(d, { from: a.id, name: "B" });
  await setLiveCampaign(d, b.id);
  await assert.rejects(deleteCampaign(d, b.id), /is live/);
  assert.equal((await listCampaigns(d)).campaigns.find((c) => c.id === b.id)?.live, true);
  assert.equal((await listCampaigns(d)).campaigns.find((c) => c.id === STANDARD_ID)?.live, false);

  const bad = cloneSequence(DEFAULT_SEQUENCE);
  bad.name = "A";
  bad.cold.steps[0].line = "No pressure at all, just checking in on this one.";
  bad.talked.steps[0].gap = 0;
  const r = await saveCampaign(d, a.id, bad, { dryRun: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === "talked.steps.0.gap" && /Between 1 and 30 business days/.test(e.problem)), JSON.stringify(r.errors));
  bad.talked.steps[0].gap = 1;
  const r2 = await saveCampaign(d, a.id, bad, { dryRun: true });
  assert.ok(r2.errors.some((e) => e.path === "cold.steps.0.line"), JSON.stringify(r2.errors));
  // A name another sequence has.
  const dup = cloneSequence(DEFAULT_SEQUENCE);
  dup.name = "b";
  const r3 = await saveCampaign(d, a.id, dup);
  assert.ok(r3.errors.some((e) => e.path === "name"), JSON.stringify(r3.errors));

  await deleteCampaign(d, a.id);
  assert.equal((await listCampaigns(d)).campaigns.some((c) => c.id === a.id), false);
  await assert.rejects(saveCampaign(d, a.id, DEFAULT_SEQUENCE), /isn't there/);
});

test("each sequence's numbers, by name and by step", async () => {
  const { d } = setup("user_cmp_c");
  const now = new Date();
  const row = (id: string, extra: Partial<Automation>): Automation => ({
    id, repId: d.rep.closeUserId, leadId: `lead_${id}`, company: id, to: "x@example.com", subject: "Re: line card", kind: "bump", label: "bump", reason: "test",
    scheduledFor: now.toISOString(), createdAt: now.toISOString(), status: "sent", statusAt: new Date(now.getTime() - 864e5).toISOString(), note: null, checkedAt: null, ...extra,
  });
  await store.putAutomation(row("s1", { seq: "A", step: "talked:0" }));
  await store.putAutomation(row("s2", { seq: "A", step: "talked:0" }));
  await store.putAutomation(row("s3", { seq: "A", step: "cold:after:1" }));
  await store.putAutomation(row("s4", { seq: "A" }));
  await store.putAutomation(row("s5", { seq: null }));
  const stats = await campaignStats(d, now);
  assert.equal(stats.A.sent, 4);
  assert.equal(stats.A.steps["talked:0"].sent, 2);
  assert.equal(stats.A.steps["cold:after:1"].sent, 1);
  assert.equal(Object.keys(stats.A.steps).length, 2, "a row without a step counts in the total only");
  assert.equal(stats.Standard.sent, 1, "rows from before the builder are Standard's");
});

test("the sequence over the last weeks (11/10): sent rows land on their Monday, the weeks come in order, empty weeks are zero", async () => {
  const { d } = setup("user_cmp_series");
  const now = new Date("2026-11-10T20:00:00Z"); // a Tuesday
  const row = (id: string, statusAt: string): Automation => ({
    id, repId: d.rep.closeUserId, leadId: `lead_${id}`, company: id, to: "x@example.com", subject: "Re: line card", kind: "bump", label: "bump", reason: "test",
    scheduledFor: statusAt, createdAt: statusAt, status: "sent", statusAt, note: null, checkedAt: null,
  });
  await store.putAutomation(row("w1", "2026-11-09T16:00:00Z")); // this week
  await store.putAutomation(row("w2", "2026-11-10T16:00:00Z")); // this week
  await store.putAutomation(row("w3", "2026-10-28T16:00:00Z")); // two weeks back
  const s = await sequenceSeries(d, now, 4);
  assert.deepEqual(s.map((w) => w.week), ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
  assert.deepEqual(s.map((w) => w.sent), [0, 1, 0, 2]);
  for (const w of s) { assert.equal(typeof w.rfqs, "number"); assert.equal(typeof w.replies, "number"); assert.equal(typeof w.stops, "number"); }
});

test("a new sequence from the editor (11/10): previewed without a name it says so, created in one step once it passes, never twice under one name", async () => {
  const { d } = setup("user_cmp_new");
  const draft = cloneSequence(DEFAULT_SEQUENCE);
  draft.name = "";
  const p = await previewCampaign(d, draft);
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => e.path === "name"), JSON.stringify(p.errors));
  draft.name = "Water districts";
  const p2 = await previewCampaign(d, draft);
  assert.equal(p2.ok, true);
  assert.ok(p2.previews.length >= 5);
  assert.equal((await listCampaigns(d)).campaigns.length, 1, "a preview creates nothing");
  const made = await createCampaignFrom(d, draft);
  assert.equal(made.ok, true);
  assert.equal(made.campaign?.name, "Water districts");
  assert.equal((await listCampaigns(d)).campaigns.length, 2);
  const again = await createCampaignFrom(d, draft);
  assert.equal(again.ok, false);
  assert.ok(again.errors.some((e) => e.path === "name"));
});

test("companies put on a second sequence follow it and nothing else; everyone else follows the live one (Walt 11/10)", async () => {
  const { d } = setup("user_cmp_enroll");
  const { enrollCampaign } = await import("../src/automations.js");
  const { sequencePicker } = await import("../src/cadence.js");
  const slow = await createCampaign(d, { from: null, name: "Slow burn" });
  const list = await enrollCampaign(d, slow.id, ["lead_a", "lead_b"], true);
  assert.deepEqual(list.campaigns.find((c) => c.id === slow.id)!.enrolled, ["lead_a", "lead_b"]);
  assert.equal(list.campaigns.find((c) => c.id === STANDARD_ID)!.live, true, "Standard is still the live one");
  const pick = await sequencePicker(d.rep.closeUserId);
  assert.equal(pick.of("lead_a").name, "Slow burn");
  assert.equal(pick.of("lead_z").name, DEFAULT_SEQUENCE.name, "not put anywhere: the live one");
  assert.equal((await sequenceFor(d.rep.closeUserId, "lead_b")).name, "Slow burn");
  // Taken off: back with everyone.
  await enrollCampaign(d, slow.id, ["lead_b"], false);
  assert.equal((await sequencePicker(d.rep.closeUserId)).of("lead_b").name, DEFAULT_SEQUENCE.name);
  // Another sequence set live doesn't move a company put on Slow burn by hand.
  const fast = await createCampaign(d, { from: null, name: "Fast" });
  await setLiveCampaign(d, fast.id);
  const p2 = await sequencePicker(d.rep.closeUserId);
  assert.deepEqual([p2.of("lead_a").name, p2.of("lead_z").name], ["Slow burn", "Fast"]);
  // Deleting the sequence sends its companies back to the live one.
  await deleteCampaign(d, slow.id);
  assert.equal((await sequencePicker(d.rep.closeUserId)).of("lead_a").name, "Fast");
  await assert.rejects(enrollCampaign(d, "nope", ["lead_a"], true), /isn't there/);
  await assert.rejects(enrollCampaign(d, fast.id, [], true), /Pick a company/);
});
