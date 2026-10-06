import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import { memeName, moveMemeRefs, unpackUpload, MemeError } from "../src/memes.js";
import { store } from "../src/store.js";

test("meme names are safe and keep their extension", () => {
  assert.equal(memeName("Walter White (1).JPG"), "walter-white-1.jpg");
  assert.equal(memeName("/tmp/dir/MJ crying.png"), "mj-crying.png");
  assert.throws(() => memeName("notes.txt"), MemeError);
  assert.throws(() => memeName("...jpg"), MemeError);
});

test("an upload is one image, or every image in a zip with the junk left out", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.deepEqual(unpackUpload("Drake.png", png).map((f) => f.name), ["drake.png"]);
  const zip = Buffer.from(zipSync({
    "memes/Drake Hotline.png": new Uint8Array(png), "memes/sub/Distracted BF.jpg": new Uint8Array([1, 2]),
    "__MACOSX/memes/._Drake Hotline.png": new Uint8Array([9]), "memes/.DS_Store": new Uint8Array([9]), "memes/readme.txt": new Uint8Array([9]),
  }));
  const files = unpackUpload("pack.zip", zip);
  assert.deepEqual(files.map((f) => f.name).sort(), ["distracted-bf.jpg", "drake-hotline.png"]);
  assert.equal(files.find((f) => f.name === "drake-hotline.png")!.data.length, png.length);
  assert.throws(() => unpackUpload("empty.zip", Buffer.from(zipSync({ "a.txt": new Uint8Array([1]) }))), /No images/);
  assert.throws(() => unpackUpload("bad.zip", Buffer.from("PK not a zip")), /couldn't be opened/);
});

test("a rename moves every record that names the meme", async () => {
  const rep = "user_meme_rename";
  const base = { repId: rep, company: "X", to: "x@x.com", subject: "s", kind: "bump" as const, label: "l", reason: "r", scheduledFor: null, createdAt: "2026-10-01T00:00:00Z", status: "sent" as const, statusAt: null, note: null, checkedAt: null };
  await store.putAutomation({ ...base, id: "auto_r1", leadId: "lead_1", meme: "old.jpg" });
  await store.putAutomation({ ...base, id: "auto_r2", leadId: "lead_2", meme: "other.jpg" });
  await store.putSetting(rep, "rescueMemes", { lead_3: ["old.jpg", "other.jpg"], lead_4: ["other.jpg"] });
  await store.putSetting(rep, "memePicks", { lead_5: "old.jpg", lead_6: null });
  await moveMemeRefs(rep, "old.jpg", "new.jpg");
  const autos = await store.listAutomations(rep, new Date(0).toISOString());
  assert.deepEqual(autos.map((a) => [a.id, a.meme]).sort(), [["auto_r1", "new.jpg"], ["auto_r2", "other.jpg"]]);
  assert.deepEqual(await store.getSetting(rep, "rescueMemes"), { lead_3: ["new.jpg", "other.jpg"], lead_4: ["other.jpg"] });
  assert.deepEqual(await store.getSetting(rep, "memePicks"), { lead_5: "new.jpg", lead_6: null });
});

test("memes are dealt evenly across a wave, a new one joins the rotation instead of taking it over", async () => {
  const { memeFor } = await import("../src/memes.js");
  const d = { rep: { closeUserId: "user_meme_deal", name: "W", email: "w@westgatesupply.com", timeZone: "America/Los_Angeles" } } as never;
  const memes = [{ name: "a.jpg", url: "a" }, { name: "b.jpg", url: "b" }, { name: "new.jpg", url: "c" }];
  // a and b have each gone to 50 companies; new.jpg to none.
  const seen = new Map<string, Set<string>>();
  for (let i = 0; i < 50; i++) { seen.set(`old_a${i}`, new Set(["a.jpg"])); seen.set(`old_b${i}`, new Set(["b.jpg"])); }
  // One wave of 30 fresh accounts shares a tally: each meme goes out 10 times, not new.jpg 30 times.
  const ctx = { memes, seen, picks: {} as Record<string, string | null> };
  const got: Record<string, number> = {};
  for (let i = 0; i < 30; i++) { const m = (await memeFor(d, `wave_${i}`, ctx))!; got[m.name] = (got[m.name] ?? 0) + 1; }
  assert.deepEqual(got, { "a.jpg": 10, "b.jpg": 10, "new.jpg": 10 });
  // The first of the wave is the one with the least history.
  assert.equal((await memeFor(d, "first", { memes, seen, picks: {} }))!.name, "new.jpg");
  // Never one they've had, even when it's the least dealt.
  seen.set("lead_2", new Set(["new.jpg"]));
  const m = (await memeFor(d, "lead_2", { memes, seen, picks: {} }))!.name;
  assert.ok(["a.jpg", "b.jpg"].includes(m), m);
});

test("meme results: opens, replies and RFQs within two weeks of the bump, credited once", async () => {
  const { memeStats } = await import("../src/memes.js");
  const rep = "user_meme_stats";
  const d = { rep: { closeUserId: rep, name: "W", email: "w@westgatesupply.com", timeZone: "America/Los_Angeles" } } as never;
  const base = { repId: rep, company: "X", to: "x@x.com", subject: "s", kind: "bump" as const, label: "l", reason: "r", scheduledFor: null, createdAt: "2026-09-20T00:00:00Z", status: "sent" as const, note: null, checkedAt: null };
  await store.putAutomation({ ...base, id: "ms1", leadId: "l1", meme: "a.jpg", statusAt: "2026-09-20T16:00:00Z" });
  await store.putAutomation({ ...base, id: "ms2", leadId: "l1", meme: "b.jpg", statusAt: "2026-09-27T16:00:00Z" }); // the bump right before the reply
  await store.putAutomation({ ...base, id: "ms3", leadId: "l2", meme: "a.jpg", statusAt: "2026-09-20T16:00:00Z" });
  await store.putAutomation({ ...base, id: "ms4", leadId: "l3", meme: "a.jpg", statusAt: "2026-08-01T16:00:00Z" }); // too long before anything
  const accounts = [
    { leadId: "l1", opens: { last: "2026-09-28T10:00:00Z" }, events: [{ at: "2026-09-29T10:00:00Z", kind: "reply" }], rfq: { at: "2026-09-30T10:00:00Z" } },
    { leadId: "l2", opens: { last: "2026-09-21T10:00:00Z" }, events: [], rfq: null },
    { leadId: "l3", opens: { last: "2026-09-21T10:00:00Z" }, events: [{ at: "2026-09-22T10:00:00Z", kind: "reply" }], rfq: null },
  ];
  const st = await memeStats(d, accounts);
  assert.deepEqual(st["b.jpg"], { sent: 1, opened: 1, replied: 1, rfq: 1 });
  assert.deepEqual(st["a.jpg"], { sent: 3, opened: 1, replied: 0, rfq: 0 });
});
