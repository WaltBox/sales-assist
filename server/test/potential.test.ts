import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAccount, emptyProfile, loadProfiles, potentialFor, recordRepSaid, refreshProfiles, siteFromEmail, tierFor } from "../src/potential.js";
import { pickPages } from "../src/website.js";
import { store } from "../src/store.js";
import type { Deps } from "../src/assistant.js";
import { FakeClose } from "../src/demo.js";

const REP = "user_potential_test";
const NOW = new Date("2026-10-05T17:00:00Z");

test("the tier rule: fab shops with specs are steady, plants are project, the rep's answer wins", () => {
  const p = emptyProfile(null);
  assert.equal(tierFor({ ...p, type: "fab shop", specs: ["duplex"] }), "steady");
  assert.equal(tierFor({ ...p, type: "mechanical contractor", certs: ["ASME R"] }), "steady");
  assert.equal(tierFor({ ...p, type: "fab shop" }), "project");
  assert.equal(tierFor({ ...p, type: "plant" }), "project");
  assert.equal(tierFor({ ...p, type: "utility" }), "project");
  assert.equal(tierFor({ ...p, type: "other" }), "occasional");
  assert.equal(tierFor(p), "unknown");
  assert.equal(tierFor({ ...p, type: "plant", repSaid: "weekly" }), "steady");
  assert.equal(tierFor({ ...p, type: "fab shop", specs: ["Inconel"], repSaid: "contract-elsewhere" }), "occasional");
});

test("a site comes from the buyer's address unless it's a personal mailbox", () => {
  assert.equal(siteFromEmail("kim@atf1.com"), "https://atf1.com");
  assert.equal(siteFromEmail("bob@gmail.com"), null);
  assert.equal(siteFromEmail(null), null);
});

test("the pages worth reading: same site, about/capabilities, never contact or careers", () => {
  const html = `<a href="/about-us">About</a> <a href="https://other.com/capabilities">x</a> <a href="/contact">C</a>
    <a href="/capabilities/">Cap</a> <a href="/careers">J</a> <a href="/products?x=1">P</a> <a href="/about-us">dup</a> <a href="/industries">I</a>`;
  assert.deepEqual(pickPages(html, new URL("https://www.acme.com/"), 3), ["https://www.acme.com/about-us", "https://www.acme.com/capabilities", "https://www.acme.com/products"]);
});

test("the why shows only what's on the page, and says what's unknown", () => {
  const p = { ...emptyProfile("https://x.com"), type: "fab shop" as const, makes: "pressure vessels", checkedAt: NOW.toISOString() };
  const pot = potentialFor(p)!;
  assert.equal(pot.tier, "project");
  assert.deepEqual(pot.why, ["Fab shop: pressure vessels"]);
  assert.match(pot.unknown!, /specs/);
  const dead = potentialFor({ ...emptyProfile("https://x.com"), problem: "site didn't load" })!;
  assert.equal(dead.tier, "unknown");
  assert.match(dead.unknown!, /Couldn't read their site/);
  assert.equal(potentialFor(null), null);
});

function fakeDeps(pages: Array<{ url: string; text: string }>, answer: Record<string, unknown>): Deps & { close: FakeClose } {
  const close = new FakeClose();
  const llm = (async () => ({ data: answer, usage: {} })) as unknown as Deps["llm"];
  return { close, llm, now: () => NOW, sitePages: async () => pages, rep: { name: "Walt", email: "walt@westgatesupply.com", closeUserId: REP, timeZone: "America/Los_Angeles" } };
}

test("reading a site keeps only facts that cite a page we fetched, and drops nothing the rep said", async () => {
  const d = fakeDeps([{ url: "https://acme.com/", text: "Acme fabricates ASME vessels in duplex and 316L" }], {
    type: "fab shop", makes: "ASME vessels", specs: ["duplex", "316L", "316L "], certs: ["ASME U"], industries: ["refining"],
    evidence: [{ fact: "Fabricates ASME vessels", source: "https://acme.com/" }, { fact: "Made up", source: "https://acme.com/nope" }],
  });
  const prev = { ...emptyProfile(null), repSaid: "monthly" as const, repSaidAt: "2026-10-01T00:00:00Z" };
  const p = await classifyAccount(d, { leadId: "lead_a", company: "Acme", website: null, contact: { name: "Kim", email: "kim@acme.com", phone: null } }, prev);
  assert.equal(p.website, "https://acme.com");
  assert.equal(p.type, "fab shop");
  assert.deepEqual(p.specs, ["duplex", "316L"]);
  assert.deepEqual(p.evidence.map((e) => e.fact), ["Fabricates ASME vessels"]);
  assert.equal(p.repSaid, "monthly");
  assert.equal(p.checkedAt, NOW.toISOString());
  assert.equal(tierFor(p), "steady");
});

test("a dead site is a profile with a problem, not an error", async () => {
  const d = fakeDeps([], {});
  const p = await classifyAccount(d, { leadId: "lead_b", company: "Ghost", website: "https://ghost.example", contact: { name: null, email: null, phone: null } }, null);
  assert.equal(p.type, "unknown");
  assert.equal(p.problem, "site didn't load");
  const none = await classifyAccount(d, { leadId: "lead_c", company: "Nobody", website: null, contact: { name: null, email: "x@gmail.com", phone: null } }, null);
  assert.equal(none.problem, "no website on the lead");
});

test("refresh reads the accounts with no profile or a stale one, saves them, and the rep's answer lands in Close", async () => {
  await store.putSetting(REP, "profiles", {});
  const d = fakeDeps([{ url: "https://acme.com/", text: "Acme" }], { type: "plant", makes: null, specs: [], certs: [], industries: [], evidence: [] });
  const acct = (id: string) => ({ leadId: id, company: id, website: "https://acme.com", contact: { name: null, email: null, phone: null } });
  const n = await refreshProfiles(d, [acct("lead_1"), acct("lead_2")], { max: 10 });
  assert.equal(n, 2);
  let all = await loadProfiles(REP);
  assert.equal(all.lead_1.type, "plant");
  // Fresh: nothing to do. Forced: read again.
  assert.equal(await refreshProfiles(d, [acct("lead_1")]), 0);
  assert.equal(await refreshProfiles(d, [acct("lead_1")], { force: true }), 1);

  const pot = await recordRepSaid(d, "lead_1", "weekly");
  assert.equal(pot.tier, "steady");
  assert.match(pot.why[0], /You said they send RFQs weekly/);
  all = await loadProfiles(REP);
  assert.equal(all.lead_1.repSaid, "weekly");
  assert.equal(all.lead_1.type, "plant"); // the site read is kept alongside the answer
  const note = d.close.writes.find((w) => w.op === "note" && (w.body as { leadId: string }).leadId === "lead_1");
  assert.ok(note && /\[RFQ potential\]/.test((note.body as { note: string }).note), "answer saved as a Close note");
  // A later site read keeps the answer.
  await refreshProfiles(d, [acct("lead_1")], { force: true });
  assert.equal((await loadProfiles(REP)).lead_1.repSaid, "weekly");
});
