import assert from "node:assert/strict";
import { test } from "node:test";
import { ownContactCard } from "../src/assistant.js";
import { dialViewName } from "../src/dialviews.js";
import { mergeRfqTimelines, type RfqTimeline } from "../src/stats.js";
import { speakAs, speakAsDeep } from "../src/validate.js";

test("a second rep (10/19): AI text reads as that rep, never as Walt; a note about Walt stays", () => {
  const rep = "Alex Rivera";
  assert.equal(speakAs("Hi Tracy,\n\nI'm Walt with Westgate Supply.\n\nThanks,\nWalt Boxwell", rep), "Hi Tracy,\n\nI'm Alex with Westgate Supply.\n\nThanks,\nAlex Rivera");
  assert.equal(speakAs("Hi, this is Walt with Westgate Supply.", rep), "Hi, this is Alex with Westgate Supply.");
  assert.equal(speakAs("Thanks,\nWalt", rep), "Thanks,\nAlex");
  assert.equal(speakAs("Buyer said Walt sent them a quote last month.", rep), "Buyer said Walt sent them a quote last month.", "Walt as a person stays");
  assert.equal(speakAs("I'm Walt with Westgate Supply.", "Walt Boxwell"), "I'm Walt with Westgate Supply.", "Walt's own text is untouched");
  assert.deepEqual(speakAsDeep({ email: { body: "Thanks,\nWalt Boxwell", to: [{ name: "Tracy" }] }, n: 3 }, rep), { email: { body: "Thanks,\nAlex Rivera", to: [{ name: "Tracy" }] }, n: 3 });
});

test("dial views: the first rep keeps the pinned names, anyone else's carry their name", () => {
  const v = "Dial: Hot · talked before, no RFQ";
  assert.equal(dialViewName(v, { name: "Walt Boxwell", email: "Walt@westgatesupply.com" }), v);
  assert.equal(dialViewName(v, { name: "Alex Rivera", email: "alex@westgatesupply.com" }), "Dial (Alex): Hot · talked before, no RFQ");
  assert.ok(!dialViewName(v, { name: "Alex Rivera", email: "alex@westgatesupply.com" }).startsWith(`${v} (`), "Walt's view lookup never grabs Alex's");
});

test("a contact card in the shared template goes out only with the rep it names", () => {
  const files = [{ filename: "Westgate_Supply_Line_Card.pdf" }, { filename: "Westgate-Supply-Walt-Boxwell.vcf" }];
  assert.deepEqual(ownContactCard(files, "Walt Boxwell").map((f) => f.filename), ["Westgate_Supply_Line_Card.pdf", "Westgate-Supply-Walt-Boxwell.vcf"]);
  assert.deepEqual(ownContactCard(files, "Alex Rivera").map((f) => f.filename), ["Westgate_Supply_Line_Card.pdf"]);
});

test("the team's RFQ line: a company counts once a day, its first RFQ is the team's first, each says whose", () => {
  const line = (since: string, days: Array<[string, Array<{ leadId: string; company: string }>]>): RfqTimeline => ({
    since, total: 0, thisWeek: 0, lastWeek: 0, firstToday: 0, firstThisWeek: 0, companies: 0, newThisWeek: 0, newLastWeek: 0, newThisMonth: 0, newLastMonth: 0,
    days: days.map(([day, accounts]) => ({ day, count: accounts.length, total: 0, newCompanies: 0, companiesTotal: 0, accounts: accounts.map((a) => ({ ...a, how: "file" as const, first: true })) })),
  });
  const walt = line("2026-10-10T16:00:00Z", [["2026-10-10", [{ leadId: "l1", company: "Acme" }]], ["2026-10-19", [{ leadId: "l2", company: "Both Co" }]]]);
  const alex = line("2026-10-15T16:00:00Z", [["2026-10-15", [{ leadId: "l1", company: "Acme" }]], ["2026-10-19", [{ leadId: "l2", company: "Both Co" }, { leadId: "l3", company: "Alex Only" }]]]);
  const m = mergeRfqTimelines([{ rep: "Walt Boxwell", line: walt }, { rep: "Alex Rivera", line: alex }], "America/Los_Angeles", new Date("2026-10-19T20:00:00Z"));
  assert.equal(m.days[0].day, "2026-10-10");
  assert.equal(m.companies, 3);
  assert.equal(m.total, 4, "Acme twice (two days), Both Co once, Alex Only once");
  assert.equal(m.firstToday, 2, "Both Co and Alex Only are new today; Acme isn't (Walt had it on 10/10)");
  const today = m.days.at(-1)!;
  assert.deepEqual(today.accounts.map((a) => [a.company, (a as unknown as { reps: string[] }).reps]), [["Both Co", ["Walt Boxwell", "Alex Rivera"]], ["Alex Only", ["Alex Rivera"]]]);
  assert.equal(m.days.find((x) => x.day === "2026-10-15")!.accounts[0].first, false, "Acme's RFQ to Alex isn't a first for the team");
});

test("emails only ever go out from the rep's own @westgatesupply.com account in Close", async () => {
  const { sendingAccount, guardSending, SendingError } = await import("../src/sending.js");
  const accounts = [
    { id: "acct_gmail", email: "ulysses.vp@gmail.com", send_status: "ok" },
    { id: "acct_walt", email: "walt@westgatesupply.com", send_status: "ok" },
  ];
  assert.equal(sendingAccount({ email: "ulysses@westgatesupply.com", email_accounts: accounts }, "ulysses@westgatesupply.com", "Ulysses V"), null, "never a personal Gmail or a teammate's");
  const own = sendingAccount({ email: "u", email_accounts: [...accounts, { id: "acct_u", email: "Ulysses@westgatesupply.com", send_status: "ok" }] }, "ulysses@westgatesupply.com", "Ulysses V");
  assert.deepEqual(own, { sender: '"Ulysses V" <Ulysses@westgatesupply.com>', emailAccountId: "acct_u", email: "Ulysses@westgatesupply.com" });
  assert.equal(sendingAccount({ email: "x", email_accounts: [{ id: "a", email: "x@gmail.com", send_status: "ok" }] }, "x@gmail.com", "X"), null, "only westgatesupply.com addresses");
  assert.equal(sendingAccount({ email: "x", email_accounts: [{ id: "a", email: "u@westgatesupply.com", send_status: "error" }] }, "u@westgatesupply.com", "U"), null, "a broken account doesn't send");
  assert.equal(sendingAccount({ email: "x", email_accounts: [{ id: "a", email: "u@westgatesupply.com", send_status: "ok", sender: { email: "walt@westgatesupply.com" } }] }, "u@westgatesupply.com", "U"), null, "no sending as someone else");

  const made: unknown[] = [];
  const close = { createDraftEmail: async (_l: string, e: unknown) => { made.push(e); return { id: "e1" }; }, other: () => "ok" };
  const guarded = guardSending(close, own, "ulysses@westgatesupply.com");
  await guarded.createDraftEmail("lead_1", { to: ["a@b.com"], sender: '"Walt Boxwell" <walt@westgatesupply.com>', emailAccountId: "acct_walt" } as never);
  assert.deepEqual(made[0], { to: ["a@b.com"], sender: '"Ulysses V" <Ulysses@westgatesupply.com>', emailAccountId: "acct_u" }, "whatever the caller passed, it's the rep's own");
  assert.equal(guarded.other(), "ok");
  await assert.rejects(guardSending(close, null, "ulysses@westgatesupply.com").createDraftEmail("lead_1", {} as never), (e: Error) => e instanceof SendingError && /isn't connected in Close/.test(e.message));
  assert.equal(made.length, 1, "nothing made without the rep's own account");
});

test("the extension zip the web app hands out is the current extension (run npm run pack-extension after changing it)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { packedVersion, EXTENSION_DIR } = await import("../src/extension.js");
  const version = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8")).version;
  assert.equal(packedVersion(), version);
});
