import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { demoLineCards, demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_USER_ID, roddaCall } from "../src/fixtures.js";
import { NEW_CARD_SUBJECT, newCardSummary, planNewCard, sendNewCard } from "../src/newcard.js";
import { store } from "../src/store.js";

const rep = (name: string, email: string, closeUserId: string) => ({ name, email, closeUserId, timeZone: "America/Los_Angeles", sender: `"${name}" <${email}>`, emailAccountId: "emailacct_demo" });

test("New line card! (10/28): from whoever sent the last card, skipping anyone who already has the new one; Walt CC'd on the others", async () => {
  const close = new FakeClose({ calls: [roddaCall()] });
  demoLineCards(close); // six companies, every card from the demo user (Walt), all before the new card existed
  const walt: Deps = { close, llm: demoLlm, rep: rep("Walt Boxwell", "walt@westgatesupply.com", DEMO_USER_ID) } as never;
  const chase: Deps = { close, llm: demoLlm, rep: rep("Chase Bent", "chase@westgatesupply.com", "user_nc_chase") } as never;
  const ulysses: Deps = { close, llm: demoLlm, rep: rep("Ulysses R", "ulysses@westgatesupply.com", "user_nc_uly") } as never;
  for (const e of close.sentEmails) { e.date_sent = "2026-10-20T15:00:00Z"; e.date_created = "2026-10-20T15:00:00Z"; }
  const ids = [...new Set(close.sentEmails.filter((e) => e.direction === "outgoing").map((e) => String(e.lead_id)))];
  const card = [{ filename: "Westgate_Supply_Line_Card.pdf", content_type: "application/pdf" }];
  // Chase sent the most recent card to the second company; Ulysses to the third; the fourth already got the new one.
  close.sentEmails.push({ id: "acti_nc_chase", lead_id: ids[1], user_id: "user_nc_chase", status: "sent", direction: "outgoing", subject: "Westgate Supply – line card", date_sent: "2026-10-24T15:00:00Z", date_created: "2026-10-24T15:00:00Z", to: ["buyer@two.test"], attachments: card, opens: [] });
  close.sentEmails.push({ id: "acti_nc_uly", lead_id: ids[2], user_id: "user_nc_uly", status: "sent", direction: "outgoing", subject: "Westgate Supply – line card", date_sent: "2026-10-24T15:00:00Z", date_created: "2026-10-24T15:00:00Z", to: ["buyer@three.test"], attachments: card, opens: [] });
  close.sentEmails.push({ id: "acti_nc_new", lead_id: ids[3], user_id: DEMO_USER_ID, status: "sent", direction: "outgoing", subject: "Re: Westgate Supply – line card", date_sent: "2026-10-28T15:00:00Z", date_created: "2026-10-28T15:00:00Z", to: ["buyer@four.test"], attachments: card, opens: [] });
  await store.putSetting("team", "newCardPlan", null as never);

  const plan = await planNewCard(walt, [walt, chase]);
  const by = (id: string) => plan.leads.find((l) => l.leadId === id);
  assert.equal(by(ids[1])?.repId, "user_nc_chase", "Chase sent the last card, so it's his");
  assert.equal(by(ids[0])?.repId, DEMO_USER_ID, "Walt's");
  assert.equal(by(ids[2]), undefined, "Ulysses isn't a sender, so his company is left out");
  assert.equal(by(ids[3]), undefined, "already has the new card");
  const sum = newCardSummary(plan)!;
  assert.equal(sum.subject, NEW_CARD_SUBJECT);
  assert.equal(sum.reps.find((r) => r.repId === "user_nc_chase")?.waiting, 1);
  void ulysses;

  // Chase's share goes out as Chase, new thread, Walt CC'd.
  const r = await sendNewCard(chase);
  assert.equal(r.planned.length, 1, JSON.stringify(r.skipped));
  assert.equal(r.planned[0].subject, NEW_CARD_SUBJECT);
  assert.equal(r.planned[0].variant, "newcard");
  const draft = close.writes.find((w) => w.op === "email" && (w.body as { subject: string }).subject === NEW_CARD_SUBJECT)!.body as Record<string, unknown>;
  assert.deepEqual(draft.cc, ["walt@westgatesupply.com"]);
  assert.equal(draft.inReplyToId ?? null, null, "a new thread, not a reply");
  assert.match(String(draft.body), /^Hi \w+!\n\nWe just redid our line card/);
  assert.ok((draft.attachments as unknown[]).length, "the card is attached");
  assert.equal((await sendNewCard(chase)).planned.length, 0, "not twice");

  // Walt's share: no CC, and the one that's past Quoted is skipped.
  close.leadStatus.set(ids[0], "Quoted");
  const w = await sendNewCard(walt, { max: 10 });
  assert.ok(w.skipped.some((s) => s.why === "They've sent an RFQ"), JSON.stringify(w.skipped));
  const mine = close.writes.filter((x) => x.op === "email" && (x.body as { subject: string }).subject === NEW_CARD_SUBJECT && (x.body as { sender: string }).sender.includes("Walt"));
  assert.ok(mine.length >= 1);
  assert.equal((mine[0].body as { cc?: string[] | null }).cc ?? null, null, "Walt doesn't CC himself");
});
