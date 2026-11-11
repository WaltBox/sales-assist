import assert from "node:assert/strict";
import { test } from "node:test";
import { accountEvent, boardFromRecords, flushRebuilds, leadFacts, recordFor, reconcileAccounts, saveRescan, type RecordData } from "../src/accountstate.js";
import { accountsBoard, cachedBoard, forgetBoard, markNotInterested } from "../src/accounts.js";
import type { Deps } from "../src/assistant.js";
import { parseCloseEvent, type HookContext } from "../src/closehooks.js";
import { demoLineCards, demoLlm, FakeClose, fakeCloseEvent } from "../src/demo.js";
import { DEMO_LEAD_ID, roddaCall } from "../src/fixtures.js";
import { store } from "../src/store.js";

// The account records (11/10): one row per rep and lead, kept current by Close's events; the board reads them.
const tz = "America/Los_Angeles";
const WED = new Date("2026-10-07T17:00:00Z"); // a Wednesday, 10am Pacific: the demo line cards are dated from here
const HARBOR = "lead_demoHarborFab000001";
const CREST = "lead_demoCrestMech000001";

function setup(userId: string, now = WED) {
  const close = new FakeClose({ calls: [] });
  demoLineCards(close, WED);
  for (const e of close.sentEmails) e.user_id = userId;
  for (const t of close.extraTasks) t.assigned_to = userId;
  let at = now;
  const d: Deps = { close, llm: demoLlm, now: () => at, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: userId, timeZone: tz } };
  const ctx: HookContext = { depsForUser: async (id) => (id === userId ? d : null), allDeps: async () => [d], ownerDeps: async () => d };
  // Fire an event the way the route does, then run the coalesced rebuild now instead of in a second and a half.
  const fire = async (ev: ReturnType<typeof fakeCloseEvent>) => {
    const p = accountEvent(parseCloseEvent(ev)!, ctx);
    await new Promise((r) => setTimeout(r, 20));
    await flushRebuilds();
    return p;
  };
  const rows = () => store.listAccountStates(userId);
  const until = async (ok: () => Promise<boolean>) => { for (let i = 0; i < 200 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10)); };
  return { close, d, ctx, fire, rows, until, setNow: (t: Date) => { at = t; } };
}
const reads = (close: FakeClose) => { let n = 0; const orig = close.listSince.bind(close); close.listSince = (async (...a: Parameters<typeof orig>) => { n++; return orig(...a); }) as never; return () => n; };

test("a rescan writes every account's record; from then on the board comes from the records, no rescan", async () => {
  const { close, d, rows, until } = setup("user_rec_1");
  const scans = reads(close);
  const board = await accountsBoard(d, { fresh: true });
  assert.ok(board.accounts.length >= 5);
  await until(async () => (await rows()).length >= board.accounts.length);
  const stored = await rows();
  assert.equal(stored.length, board.accounts.length);
  const harbor = stored.find((r) => r.leadId === HARBOR)!;
  assert.equal(harbor.company, "Harbor Fabrication");
  const data = harbor.data as RecordData;
  assert.equal(data.built.source, "rescan");
  assert.equal(data.account?.company, "Harbor Fabrication");
  assert.equal(data.facts.emails.length, 1, "the line card");
  assert.ok(!("body_text" in data.facts.emails[0]), "trimmed");
  const before = scans();
  forgetBoard(d.rep.closeUserId);
  const again = await accountsBoard(d);
  assert.equal(scans(), before, "no rescan: the records had it");
  assert.deepEqual(again.accounts.map((a) => [a.company, a.next.kind, a.section]), board.accounts.map((a) => [a.company, a.next.kind, a.section]), "the same board");
  assert.ok((await cachedBoard(d))?.accounts.length, "a teammate's view reads them too");
  // The records alone, with nothing in memory.
  forgetBoard(d.rep.closeUserId);
  const fromRows = await boardFromRecords(d);
  assert.equal(fromRows?.accounts.length, board.accounts.length);
});

test("a call completed in Close updates that lead's record and the board within the event, and nothing else is read again", async () => {
  const { close, d, fire, rows, until } = setup("user_rec_2");
  await accountsBoard(d, { fresh: true });
  await until(async () => (await rows()).length >= 5);
  const scans = reads(close);
  const harborBefore = (await accountsBoard(d)).accounts.find((a) => a.leadId === HARBOR)!;
  assert.equal(harborBefore.touches.dials, 0);
  assert.equal(harborBefore.touchedToday, null);
  // Walt dials Harbor Fabrication and reaches Dana.
  const call = roddaCall({ id: "acti_rec_harbor", lead_id: HARBOR, user_id: d.rep.closeUserId, date_created: new Date(WED.getTime() - 5 * 60_000).toISOString(), duration: 90, recording_transcript: null });
  close.calls_.push(call);
  const said = await fire(fakeCloseEvent({ object_type: "activity.call", action: "completed", lead_id: HARBOR, user_id: d.rep.closeUserId, data: { id: call.id, lead_id: HARBOR, user_id: d.rep.closeUserId, duration: 90, disposition: "answered" } }));
  assert.match(String(said), /rebuilt for Walt/);
  assert.ok(!/light/.test(String(said)), "on the board: the whole record");
  const rec = (await recordFor(d, HARBOR))!;
  assert.equal(rec.built.source, "event");
  assert.deepEqual(rec.facts.calls.map((c) => c.id), ["acti_rec_harbor"]);
  assert.ok(!("recording_transcript" in rec.facts.calls[0]), "no transcripts in a record");
  const harbor = (await accountsBoard(d)).accounts.find((a) => a.leadId === HARBOR)!;
  assert.equal(harbor.touches.dials, 1);
  assert.equal(harbor.touches.talked, 1);
  assert.ok(harbor.touchedToday, "touched today");
  assert.equal(harbor.section, "today");
  assert.equal(scans(), 0, "no rescan of 45 days: one lead's facts were read");
});

test("a dial on a lead with no line card makes a light record (the lead and its calls) that the board doesn't show", async () => {
  const { d, fire, rows, until } = setup("user_rec_3");
  await accountsBoard(d, { fresh: true });
  await until(async () => (await rows()).length >= 5);
  const said = await fire(fakeCloseEvent({ object_type: "activity.call", action: "created", lead_id: DEMO_LEAD_ID, user_id: d.rep.closeUserId, data: { id: "acti_rec_fresh", lead_id: DEMO_LEAD_ID, status: "in-progress" } }));
  assert.match(String(said), /Walt \(light\)/);
  const rec = (await recordFor(d, DEMO_LEAD_ID))!;
  assert.equal(rec.account, null);
  assert.equal(rec.facts.lead?.display_name, "Rodda Electric, Inc.");
  assert.deepEqual(rec.facts.emails, []);
  assert.ok(!(await accountsBoard(d)).accounts.some((a) => a.leadId === DEMO_LEAD_ID));
  // Nothing for a draft, a Say line, or a note autosave on a call.
  assert.equal(await fire(fakeCloseEvent({ object_type: "activity.email", action: "created", lead_id: HARBOR, data: { id: "acti_draft", status: "draft" } })), "draft");
  assert.equal(await fire(fakeCloseEvent({ object_type: "activity.note", action: "created", lead_id: HARBOR, data: { id: "note_say", note: "Opener: Hi Dana, this is Walt" } })), "a Say line");
  const ev = fakeCloseEvent({ object_type: "activity.call", action: "updated", lead_id: HARBOR, data: { id: "acti_x" } });
  (ev.event as { changed_fields: string[] }).changed_fields = ["note", "date_updated"];
  assert.equal(await fire(ev), "note autosave");
  // Someone who isn't in the app: nobody to rebuild for.
  assert.equal(await fire(fakeCloseEvent({ object_type: "activity.note", action: "created", lead_id: "lead_nobodys00000000001", user_id: "user_stranger", data: { id: "n1", note: "x" } })), "nobody in the app");
});

test("the record holds the facts, the board holds the clock: the same record reads differently the next day", async () => {
  const { close, d, fire, rows, until, setNow } = setup("user_rec_4");
  await accountsBoard(d, { fresh: true });
  await until(async () => (await rows()).length >= 5);
  close.calls_.push(roddaCall({ id: "acti_rec_clock", lead_id: CREST, user_id: d.rep.closeUserId, date_created: new Date(WED.getTime() - 60_000).toISOString(), duration: 40, recording_transcript: null }));
  await fire(fakeCloseEvent({ object_type: "activity.call", action: "completed", lead_id: CREST, user_id: d.rep.closeUserId, data: { id: "acti_rec_clock", lead_id: CREST } }));
  const today = (await accountsBoard(d)).accounts.find((a) => a.leadId === CREST)!;
  assert.ok(today.touchedToday);
  setNow(new Date(WED.getTime() + 86_400_000));
  forgetBoard(d.rep.closeUserId);
  const tomorrow = (await accountsBoard(d)).accounts.find((a) => a.leadId === CREST)!;
  assert.equal(tomorrow.touchedToday, null, "yesterday's call isn't today's touch");
  assert.ok(tomorrow.touchedLastDay, "it rests the account instead");
  assert.equal(tomorrow.touches.dials, 1, "the call itself is still there");
});

test("a lead handed to a teammate (Lead owner changed in Close) leaves one board and lands on the other on the event", async () => {
  const A = "user_rec_5a", B = "user_rec_5b";
  const { close, d, rows, until } = setup(A);
  const dB: Deps = { ...d, rep: { ...d.rep, name: "Chase Rep", email: "chase@westgatesupply.com", closeUserId: B } };
  const ctx: HookContext = { depsForUser: async (id) => (id === A ? d : id === B ? dB : null), allDeps: async () => [d, dB], ownerDeps: async () => d };
  await accountsBoard(d, { fresh: true });
  await until(async () => (await rows()).length >= 5);
  assert.ok(!(await accountsBoard(dB)).accounts.length, "nothing on Chase's board");
  // The hand-off, as the app records it and as Close then reports the Lead owner change.
  await store.putSetting("team", "handoffs", { [HARBOR]: { from: A, fromName: "Walt Boxwell", to: B, toName: "Chase Rep", at: WED.toISOString() } });
  await store.putSetting("team", "leadOwnerFieldId", "cf_owner");
  const p = accountEvent(parseCloseEvent(fakeCloseEvent({ object_type: "lead", action: "updated", lead_id: HARBOR, user_id: A, data: { id: HARBOR, "custom.cf_owner": B } }))!, ctx);
  await new Promise((r) => setTimeout(r, 20));
  await flushRebuilds();
  assert.match(String(await p), /Walt.*Chase|Chase.*Walt/);
  forgetBoard(A); forgetBoard(B);
  assert.ok(!(await accountsBoard(d)).accounts.some((a) => a.leadId === HARBOR), "off Walt's board");
  const chase = (await accountsBoard(dB)).accounts.find((a) => a.leadId === HARBOR)!;
  assert.ok(chase, "on Chase's");
  assert.equal(chase.handedFrom, "Walt Boxwell");
  assert.equal(chase.cadence.eligible, false);
  await store.putSetting("team", "handoffs", {});
  await store.putSetting("team", "leadOwnerFieldId", null);
  void close;
});

test("Shot down (10/5) refreshes the record at once: off the board before any event lands", async () => {
  const { d, rows, until } = setup("user_rec_6");
  await accountsBoard(d, { fresh: true });
  await until(async () => (await rows()).length >= 5);
  const mesa = (await accountsBoard(d)).accounts.find((a) => a.company === "Mesa Pipe & Supply")!;
  await markNotInterested(d, mesa.leadId, "They said no");
  assert.ok(!(await accountsBoard(d)).accounts.some((a) => a.leadId === mesa.leadId));
  assert.equal((await recordFor(d, mesa.leadId))?.built.source, "refresh");
});

test("the reconcile: once a day a rescan rewrites every record and drops the ones no longer on the board", async () => {
  const { close, d, rows, until } = setup("user_rec_7");
  await accountsBoard(d, { fresh: true });
  await until(async () => (await rows()).length >= 5);
  const n = (await rows()).length;
  // Just reconciled by that rescan: not again today.
  assert.equal((await reconcileAccounts(d)).ran, false);
  // A line card that's no longer in Close (deleted), and a light record from a dial two days ago.
  close.sentEmails = close.sentEmails.filter((e) => e.lead_id !== HARBOR);
  await store.putAccountState({ repId: d.rep.closeUserId, leadId: "lead_demoOld000000000001", company: "Old", updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), suspect: false, data: { v: 1, facts: leadFacts({ leadId: "lead_demoOld000000000001", lead: null, emails: [], notes: [], tasks: [], calls: [], at: WED }), account: null, built: { at: "", source: "event", cardSenderId: null, repEmailed: false } } });
  const r = await reconcileAccounts(d, { force: true });
  assert.ok(r.ran);
  await until(async () => !(await rows()).some((x) => x.leadId === HARBOR));
  const after = await rows();
  assert.equal(after.length, n - 1);
  assert.ok(!after.some((x) => x.leadId === "lead_demoOld000000000001"), "the old light record is gone");
  assert.ok(after.every((x) => (x.data as RecordData).built.source === "rescan"));
  void saveRescan;
});
