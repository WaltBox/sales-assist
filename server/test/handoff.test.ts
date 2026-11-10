import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsBoard } from "../src/accounts.js";
import type { Deps } from "../src/assistant.js";
import { forecast } from "../src/automations.js";
import { demoLineCards, demoLlm, FakeClose } from "../src/demo.js";
import { roddaCall } from "../src/fixtures.js";
import { handoffs, handOver, setHandoffRule } from "../src/handoff.js";
import { planNewCard } from "../src/newcard.js";
import { store } from "../src/store.js";

const rep = (name: string, email: string, closeUserId: string) => ({ name, email, closeUserId, timeZone: "America/Los_Angeles", sender: `"${name}" <${email}>`, emailAccountId: "emailacct_demo" });

test("Hand-off (10/28): Walt's heat map moves to Chase: off Walt's board and emails, on Chase's to call, new card from Chase", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close);
  for (const e of close.sentEmails) e.user_id = "user_ho_walt";
  for (const t of close.extraTasks) t.assigned_to = "user_ho_walt";
  const walt: Deps = { close, llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", "user_ho_walt") };
  const chase: Deps = { close, llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", "user_ho_chase") };
  await store.putSetting("team", "handoffs", {});
  await store.putSetting("team", "leadOwnerFieldId", "cf_ho_owner");
  await store.putSetting("team", "newCardPlan", null as never);
  await store.putSetting(walt.rep.closeUserId, "cooling", {});

  const before = (await accountsBoard(walt, { fresh: true })).accounts;
  const crest = before.find((a) => a.company === "Crest Mechanical")!;
  await store.putAutomation({ id: "acti_ho_bump", repId: walt.rep.closeUserId, leadId: crest.leadId, company: crest.company, to: crest.contact.email!, subject: "Re: x", kind: "bump", label: "", reason: "", scheduledFor: new Date(Date.now() + 3600e3).toISOString(), createdAt: new Date().toISOString(), status: "scheduled", statusAt: null, note: null, checkedAt: null });
  assert.equal((await accountsBoard(chase, { fresh: true })).accounts.length, 0, "Chase starts with nothing");

  const ids = before.filter((a) => a.heat).map((a) => a.leadId);
  const r = await handOver(walt, chase, ids);
  assert.equal(r.done.length, ids.length, JSON.stringify(r.failed));
  assert.equal(Object.keys(await handoffs()).length, ids.length);

  const waltAfter = (await accountsBoard(walt, { fresh: true })).accounts;
  assert.ok(!waltAfter.some((a) => ids.includes(a.leadId)), "gone from Walt's board");
  assert.ok(!(await forecast(walt)).some((f) => ids.includes(f.leadId)), "and out of Walt's automatic emails");
  assert.equal((await store.listAutomations(walt.rep.closeUserId, new Date(Date.now() - 86400e3).toISOString())).find((a) => a.id === "acti_ho_bump")?.status, "stopped", "the scheduled bump is pulled back");
  assert.equal(close.leadFields_[crest.leadId]?.["custom.cf_ho_owner"], "user_ho_chase", "Lead owner in Close is Chase");
  assert.ok(close.writes.some((w) => w.op === "note" && /\[Handed over\] Walt Boxwell handed this account to Chase Bent/.test(String((w.body as { note: string }).note))));

  const chaseAfter = (await accountsBoard(chase, { fresh: true })).accounts;
  const his = chaseAfter.find((a) => a.leadId === crest.leadId)!;
  assert.ok(his, "Crest is on Chase's board");
  assert.ok(his.heat, "with its heat");
  assert.equal(his.handedFrom, "Walt Boxwell");
  assert.notEqual(his.next.kind, "bump", `no automatic email from Chase yet: ${his.next.kind} · ${his.next.tag}`);
  assert.ok(!(await forecast(chase)).some((f) => f.leadId === crest.leadId), "not in Chase's automatic emails until he's emailed them");

  // The new line card wave has nothing to do with the hand-off (Walt 10/28): it still goes from whoever sent the last card.
  for (const e of close.sentEmails) { e.date_sent = "2026-10-20T15:00:00Z"; e.date_created = "2026-10-20T15:00:00Z"; }
  const plan = await planNewCard(walt, [walt, chase]);
  assert.equal(plan.leads.find((l) => l.leadId === crest.leadId)?.repId, "user_ho_walt");
  await store.putSetting("team", "handoffs", {});
});

test("Standing rule (10/29): everything Walt's line cards bring in goes to Chase, from now on", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close);
  for (const e of close.sentEmails) e.user_id = "user_hr_walt";
  for (const t of close.extraTasks) t.assigned_to = "user_hr_walt";
  const walt: Deps = { close, llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", "user_hr_walt") };
  const chase: Deps = { close, llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", "user_hr_chase") };
  await store.putSetting("team", "handoffs", {});
  await store.putSetting("team", "leadOwnerFieldId", "cf_hr_owner");
  await setHandoffRule(walt, chase);
  try {
    assert.equal((await accountsBoard(walt, { fresh: true })).accounts.length, 0, "nothing stays on Walt's board");
    const his = (await accountsBoard(chase, { fresh: true })).accounts;
    const crest = his.find((a) => a.company === "Crest Mechanical")!;
    assert.ok(crest, "Walt's card put Crest on Chase's board");
    assert.equal(crest.handedFrom, "Walt Boxwell");
    await new Promise((r) => setTimeout(r, 50)); // the background adoption
    assert.equal(close.leadFields_[crest.leadId]?.["custom.cf_hr_owner"], "user_hr_chase", "Lead owner in Close followed");
    assert.equal((await handoffs())[crest.leadId]?.to, "user_hr_chase", "and it's written down as a hand-off");
  } finally {
    await setHandoffRule(walt, null);
    await store.putSetting("team", "handoffs", {});
  }
});
