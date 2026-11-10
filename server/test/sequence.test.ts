import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { accountsBoard } from "../src/accounts.js";
import { cadenceFor, cloneSequence, DEFAULT_SEQUENCE, isDefaultSequence, sequenceFor } from "../src/cadence.js";
import { checkSequence, resetSequence, sequencePreview, setAutomations, planBumps } from "../src/automations.js";
import { demoLineCards, demoLlm, FakeClose } from "../src/demo.js";
import { bumpBodyFor, bumpLine, sendSlot } from "../src/followup.js";
import { store } from "../src/store.js";

const rep = { name: "Walt Boxwell", email: "walt@westgatesupply.com", timeZone: "America/Los_Angeles" };
const setup = (userId: string) => {
  const close = new FakeClose();
  demoLineCards(close);
  const d: Deps = { close, llm: demoLlm, rep: { ...rep, closeUserId: userId } };
  for (const e of close.sentEmails) e.user_id = userId;
  for (const t of close.extraTasks) t.assigned_to = userId;
  return { close, d };
};

test("the sequence builder (11/9): a custom sequence changes the gaps, the step count, when it goes monthly and the click hold", () => {
  const seq = cloneSequence(DEFAULT_SEQUENCE);
  seq.talked.steps = [{ gap: 1, line: "First. Please send me over an RFQ." }, { gap: 4, line: "Second. Please send me over an RFQ." }];
  seq.monthly = { after: 3, gap: 10 };
  seq.rhythm.gaps.steady = 2;
  const talked = (nth: number, more = {}) => cadenceFor({ track: "talked", round: 1, nth, ...more }, seq);
  assert.deepEqual([0, 1].map((n) => talked(n).gap), [1, 4]);
  assert.equal(talked(1).phase, "intro");
  assert.equal(talked(2).phase, "rhythm", "two intro emails, then the rhythm");
  assert.equal(talked(2).callFlag, true);
  assert.equal(talked(2, { tier: "steady" }).gap, 2);
  assert.equal(talked(3).phase, "monthly", "monthly after 3 now");
  assert.equal(talked(3).gap, 10);
  assert.match(talked(3).why, /every 10 business days/);
  // The default is untouched.
  assert.equal(cadenceFor({ track: "talked", round: 1, nth: 3 }).phase, "rhythm");
  assert.equal(isDefaultSequence(seq), false);
  assert.equal(isDefaultSequence(cloneSequence(DEFAULT_SEQUENCE)), true);
});

test("the sequence builder: the lines come from the sequence, the special cases stay (when, round 2, shared mailbox)", () => {
  const seq = cloneSequence(DEFAULT_SEQUENCE);
  seq.talked.steps = [{ gap: 1, line: "Good to talk {when}! Send me over an RFQ." }, { gap: 3, line: "Second one here. Send me over an RFQ." }];
  seq.talked.after = ["Rotating A. Send me over an RFQ.", "Rotating B. Send me over an RFQ."];
  seq.cold.steps = [{ gap: 2, line: "Cold one. Send me over an RFQ." }];
  seq.cold.after = ["Cold after. Send me over an RFQ."];
  seq.wrap = { greeting: "Hey {name},", cardLine: "Card here: {url}", siteLine: "Site: {url}", signoff: "Best," };
  assert.equal(bumpLine({ nth: 0, track: "talked", talkedDaysAgo: 0, seq }), "Good to talk yesterday! Send me over an RFQ.");
  assert.equal(bumpLine({ nth: 0, track: "talked", talkedDaysAgo: 3, seq }), "Good to talk the other day! Send me over an RFQ.");
  assert.match(bumpLine({ nth: 0, track: "talked", round: 2, talkedDaysAgo: 1, seq }), /good talking to you again/);
  assert.match(bumpLine({ nth: 0, track: "talked", talkedDaysAgo: 30, seq }), /hope your week's going good/, "weeks later the {when} line reads wrong");
  assert.equal(bumpLine({ nth: 1, track: "talked", seq }), "Second one here. Send me over an RFQ.");
  assert.equal(bumpLine({ nth: 2, track: "talked", seq }), "Rotating A. Send me over an RFQ.");
  assert.equal(bumpLine({ nth: 3, track: "talked", seq }), "Rotating B. Send me over an RFQ.");
  assert.equal(bumpLine({ nth: 4, track: "talked", seq }), "Rotating A. Send me over an RFQ.");
  assert.equal(bumpLine({ nth: 0, track: "cold", seq }), "Cold one. Send me over an RFQ.");
  assert.equal(bumpLine({ nth: 1, track: "cold", seq }), "Cold after. Send me over an RFQ.");
  assert.match(bumpLine({ nth: 1, track: "cold", generic: true, seq }), /whoever handles/, "a shared mailbox still gets the question every other email");
  assert.equal(bumpBodyFor("Sam", "Walt Boxwell", { nth: 1, track: "cold", seq, cardUrl: "https://x/card", siteUrl: "https://x/site" }),
    "Hey Sam,\n\nCold after. Send me over an RFQ.\n\nCard here: https://x/card\n\nSite: https://x/site\n\nBest,\nWalt Boxwell");
  // No sequence given: exactly what went out before the builder.
  assert.equal(bumpLine({ nth: 1, track: "talked" }), DEFAULT_SEQUENCE.talked.steps[1].line);
  assert.equal(bumpLine({ nth: 2, track: "cold" }), DEFAULT_SEQUENCE.cold.after[0]);
});

test("the sequence builder: the send window is the sequence's", () => {
  const tz = "America/Chicago";
  const lo = () => 0;
  const win = { from: 9 * 60, to: 9 * 60 + 30, mondayFrom: 13 * 60, mondayTo: 13 * 60 + 20 };
  assert.equal(sendSlot(tz, new Date("2026-09-29T12:00:00Z"), 0, lo, win), "2026-09-29T09:00:00-05:00", "Tuesday 7am → 9:00");
  assert.equal(sendSlot(tz, new Date("2026-09-28T12:00:00Z"), 0, lo, win), "2026-09-28T13:00:00-05:00", "Monday 7am → 1pm");
});

test("the sequence builder: the check names the field for a bad gap, a hedging line, too many steps, a missing {url}", () => {
  const bad = cloneSequence(DEFAULT_SEQUENCE);
  bad.talked.steps[0].gap = 0;
  bad.cold.steps[1].line = "No pressure at all, just send one over when something comes up.";
  bad.cold.after.push("Spam folder check, did this land?");
  bad.wrap.cardLine = "The line card's attached.";
  bad.rhythm.gaps.occasional = 45;
  const { seq, errors } = checkSequence(bad);
  assert.equal(seq, null);
  const paths = errors.map((e) => e.path);
  assert.ok(paths.includes("talked.steps.0.gap"), `gap: ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("wrap.cardLine"), "needs {url}");
  assert.ok(paths.includes("rhythm.gaps.occasional"));
  // Wording checks run once the shape is right.
  const shaped = cloneSequence(bad);
  shaped.talked.steps[0].gap = 1; shaped.wrap.cardLine = DEFAULT_SEQUENCE.wrap.cardLine; shaped.rhythm.gaps.occasional = 15;
  const r2 = checkSequence(shaped);
  assert.equal(r2.seq, null);
  assert.ok(r2.errors.some((e) => e.path === "cold.steps.1.line" && /Hedges/.test(e.problem)), JSON.stringify(r2.errors));
  assert.ok(r2.errors.some((e) => e.path === `cold.after.${shaped.cold.after.length - 1}` && /junk-folder/.test(e.problem)), JSON.stringify(r2.errors));
  const seven = cloneSequence(DEFAULT_SEQUENCE);
  while (seven.talked.steps.length < 7) seven.talked.steps.push({ gap: 2, line: "Another one. Please send me over an RFQ." });
  assert.ok(checkSequence(seven).errors.some((e) => e.path === "talked.steps"));
  assert.ok(checkSequence(DEFAULT_SEQUENCE).seq, "the default passes its own check");
});

test("the sequence builder: saved per rep, the board's due dates follow it, the sent rows carry the version, reset brings the default back", async () => {
  const { d } = setup("user_seq");
  assert.deepEqual(await sequenceFor(d.rep.closeUserId), DEFAULT_SEQUENCE, "nothing saved: the default");
  const before = await accountsBoard(d, { fresh: true });
  const talkedBefore = before.accounts.filter((a) => a.cadence.eligible && a.cadence.phase === "intro");
  assert.ok(talkedBefore.length, "an intro account to move");

  const mine = cloneSequence(DEFAULT_SEQUENCE);
  mine.name = "Slow and steady";
  mine.talked.steps = mine.talked.steps.map((s) => ({ ...s, gap: s.gap + 10 }));
  mine.cold.steps = mine.cold.steps.map((s) => ({ ...s, gap: s.gap + 10 }));
  const dry = await sequencePreview(d, mine, { save: false });
  assert.equal(dry.ok, true, JSON.stringify(dry.errors));
  assert.equal(dry.saved, false);
  assert.ok(dry.previews.length >= 5, "one sample per step and rotating line");
  assert.match(dry.previews[0].body, /^Hi Sam!/);
  assert.deepEqual(await sequenceFor(d.rep.closeUserId), DEFAULT_SEQUENCE, "a dry run saves nothing");

  const saved = await sequencePreview(d, mine, { save: true });
  assert.equal(saved.saved, true);
  assert.ok(saved.moved >= talkedBefore.length, `moved ${saved.moved}`);
  assert.equal((await sequenceFor(d.rep.closeUserId)).name, "Slow and steady");
  const after = await accountsBoard(d, { fresh: true });
  for (const a of talkedBefore) {
    const now = after.accounts.find((x) => x.leadId === a.leadId)!;
    assert.ok(now.cadence.dueAt! > a.cadence.dueAt!, `${a.company}: ${a.cadence.dueAt} → ${now.cadence.dueAt}`);
    assert.equal(now.cadence.gap, a.cadence.gap + 10);
  }

  await setAutomations(d, true);
  const r = await planBumps(d, { force: true });
  for (const p of r.planned) assert.equal(p.seq, "Slow and steady", `${p.company} carries the version`);

  await resetSequence(d);
  assert.deepEqual(await sequenceFor(d.rep.closeUserId), DEFAULT_SEQUENCE);
  assert.equal(await store.getSetting(d.rep.closeUserId, "sequence"), null);
  // Something saved that no longer parses runs the default, not a crash.
  await store.putSetting(d.rep.closeUserId, "sequence", { talked: "nope" });
  assert.deepEqual(await sequenceFor(d.rep.closeUserId), DEFAULT_SEQUENCE);
});
