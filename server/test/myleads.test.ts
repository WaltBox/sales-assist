import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { myLeads } from "../src/myleads.js";

test("my leads (10/19): every lead whose Lead owner is you, with status, last call, email opens, replies and tasks", async () => {
  const me = "user_owner_test";
  const close = new FakeClose();
  close.customFields_.push({ id: "cf_owner", name: "Lead owner" });
  const now = new Date("2026-10-19T18:00:00Z");
  const d: Deps = { close, llm: demoLlm, now: () => now, rep: { name: "Ulysses Vazquez-Perez", email: "ulysses@westgatesupply.com", closeUserId: me, timeZone: "America/Chicago" } };
  close.ownedLeads = [
    { id: "lead_a", display_name: "Acme Fab", status_label: "Potential", contacts: [{ name: "Main Office", phones: [{ phone: "+18325551000" }] }] },
    { id: "lead_b", display_name: "Bolt Co", status_label: "Sent Line Card", contacts: [{ name: "Dana Ruiz", phones: [{ phone: "+15125550101" }], emails: [{ email: "dana@boltco.com" }] }] },
    { id: "lead_c", display_name: "Cold Ltd", status_label: "Good lead", contacts: [] },
  ];
  close.calls = (async () => [
    { id: "c2", lead_id: "lead_b", user_id: "user_demoWaltBoxwell000001", duration: 240, disposition: "answered", date_created: "2026-10-17T16:00:00Z" },
    { id: "c1", lead_id: "lead_b", user_id: me, duration: 20, disposition: "vm-left", date_created: "2026-10-15T16:00:00Z" },
    { id: "cx", lead_id: "lead_other", user_id: me, duration: 300, disposition: "answered", date_created: "2026-10-18T16:00:00Z" },
  ]) as never;
  close.sentEmails.push(
    { lead_id: "lead_b", direction: "outgoing", status: "sent", subject: "Westgate Supply: line card", date_sent: "2026-10-17T16:10:00Z", date_created: "2026-10-17T16:10:00Z", opens: [{ opened_at: "2026-10-18T14:00:00Z", opened_by: "dana@boltco.com" }] } as never,
    { lead_id: "lead_b", direction: "incoming", status: "inbox", subject: "Re: line card", date_sent: "2026-10-18T15:00:00Z", date_created: "2026-10-18T15:00:00Z", opens: null } as never,
  );
  close.extraTasks.push({ id: "t1", lead_id: "lead_a", assigned_to: me, text: "Call Acme back", date: "2026-10-18", is_complete: false });

  const r = await myLeads(d, { fresh: true });
  assert.equal(r.field, true);
  assert.deepEqual(r.leads.map((l) => l.company), ["Bolt Co", "Acme Fab", "Cold Ltd"], "wrote back first, then a task due, then the rest");
  const b = r.leads[0];
  assert.deepEqual([b.status, b.calls, b.lastCall?.talked, b.lastCall?.by, b.lastEmail?.opens, b.repliedAt, b.contact.name, b.contact.email], ["Sent Line Card", 2, true, "Walt", 1, "2026-10-18T15:00:00Z", "Dana Ruiz", "dana@boltco.com"]);
  const a = r.leads[1];
  assert.deepEqual([a.contact.name, a.task?.text, a.task?.overdue, a.untouched], [null, "Call Acme back", true, true], "Main Office isn't a person");
  assert.equal(r.leads[2].untouched, true);
  assert.ok(!close.writes.length, "reading only");
  // Served from the store the next time.
  close.ownedLeads = [];
  assert.equal((await myLeads(d)).leads.length, 3);
});

test("my leads: no Lead owner field in Close yet says so", async () => {
  const close = new FakeClose();
  const d: Deps = { close, llm: demoLlm, rep: { name: "X", email: "x@westgatesupply.com", closeUserId: "user_nofield", timeZone: "America/Chicago" } };
  const { store } = await import("../src/store.js");
  await store.putSetting("team", "leadOwnerFieldId", null as never);
  assert.equal((await myLeads(d, { fresh: true })).field, false);
});
