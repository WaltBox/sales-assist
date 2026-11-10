import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { fillText, measure, renderMeme, type Spot } from "../src/memerender.js";
// The store is picked when it's first imported: here, before the bucket is pointed at the stub, so it's the in-memory one.
import "../src/store.js";

// Dynamic memes (11/10): the text is drawn when the image loads, with the buyer's and the rep's names filled in.

/** A small generated base image: a grey square as a PNG. */
async function basePng(w = 320, h = 240): Promise<Buffer> {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, w, h);
  return c.encode("png");
}
const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

test("fill-ins: the buyer's first name (or 'there'), the company, the rep's first and full name; {name} is {first}", () => {
  const fills = { first: "Tammy", company: "Crest Mechanical", repfull: "Walt Boxwell" };
  assert.equal(fillText("Hi {first} at {company}, it's {rep} ({repfull})", fills), "Hi Tammy at Crest Mechanical, it's Walt (Walt Boxwell)");
  assert.equal(fillText("{name} and {FIRST}", fills), "Tammy and Tammy");
  assert.equal(fillText("Hi {first}", { first: null, company: null, repfull: "Walt Boxwell" }), "Hi there");
  assert.equal(fillText("{company}|{rep}", {}), "|");
  assert.equal(fillText("{rep}", { rep: "Ulysses", repfull: "Ulysses Grant" }), "Ulysses");
});

test("renderMeme draws one or two spots into a generated image and answers with a JPEG", async () => {
  const base = await basePng();
  const spots: Spot[] = [
    { x: 0.05, y: 0.05, w: 0.9, h: 0.25, text: "WHEN {first} FINALLY SENDS THE RFQ", style: "meme" },
    { x: 0.05, y: 0.7, w: 0.9, h: 0.2, text: "{rep} from Westgate", style: "plain", align: "left" },
  ];
  const out = await renderMeme(base, spots, { first: "Sam", company: "Crest Mechanical", repfull: "Walt Boxwell" });
  assert.ok(isJpeg(out), "a JPEG");
  assert.ok(out.length > 1000, "has pixels in it");
  // The drawing changed the picture: the plain grey square alone is a different JPEG.
  const plain = await renderMeme(base, [], {});
  assert.ok(isJpeg(plain));
  assert.notEqual(Buffer.compare(out, plain), 0);
});

test("a long meme text wraps to more than one line and shrinks until it fits the box", () => {
  const box = { w: 300, h: 120 };
  const long = measure("when the buyer says the RFQ is coming next week and it's been three weeks", box, "meme");
  assert.ok(long.lines.length > 1, `wrapped: ${long.lines.length} lines`);
  assert.ok(long.lines.length * long.lineHeight <= box.h + 1, "the lines fit the box's height");
  assert.ok(long.lines.every((l) => l === l.toUpperCase()), "meme style shouts");
  const short = measure("HI SAM", box, "meme");
  assert.equal(short.lines.length, 1);
  assert.ok(short.size > long.size, "a short text gets the bigger font");
  // Plain is a fixed size from the image's height, just wrapped.
  const plain = measure("A plain note from Walt about the line card that runs on a bit", { w: 200, h: 200 }, "plain", 400);
  assert.equal(plain.size, Math.round(400 / 22));
  assert.ok(plain.lines.length > 1);
});

// The image route: a meme with spots is drawn (and the render kept in the bucket); one without still redirects
// to the file. The bucket is a stubbed fetch; everything else (the app itself) goes through the real one.
const BUCKET = "https://stub.supabase.co";
const bucket = new Map<string, Buffer>(); // object key → bytes
let app: import("express").Express;
let server: import("node:http").Server;
let base = "";
const realFetch = globalThis.fetch;
before(async () => {
  const { config } = await import("../src/config.js");
  (config as { supabaseUrl: string | null }).supabaseUrl = BUCKET;
  (config as { supabaseKey: string | null }).supabaseKey = "stub-key";
  bucket.set("tv-show.png", await basePng(200, 150));
  bucket.set("tv-show.png.json", Buffer.from(JSON.stringify([{ x: 0.05, y: 0.05, w: 0.9, h: 0.3, text: "HI {first} FROM {rep}", style: "meme" }])));
  bucket.set("ron.png", await basePng(100, 100));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(BUCKET)) return realFetch(input as never, init);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/storage/v1/object/list/")) return new Response(JSON.stringify([...bucket.keys()].map((name) => ({ name }))), { status: 200 });
    const key = decodeURIComponent(url.replace(`${BUCKET}/storage/v1/object/`, "").replace(/^public\//, "").replace(/^memes\//, ""));
    if (method === "POST") { bucket.set(key, Buffer.from(await new Request(url, init).arrayBuffer())); return new Response("{}", { status: 200 }); }
    const hit = bucket.get(key);
    return hit ? new Response(new Uint8Array(hit), { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  const { createApp } = await import("../src/app.js");
  const { demoLlm, FakeClose } = await import("../src/demo.js");
  app = createApp({ reps: new Map(), closeFor: () => new FakeClose(), llm: demoLlm, website: async () => null });
  await new Promise<void>((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }); });
});
after(() => { globalThis.fetch = realFetch; server?.close(); });

test("the image route draws a meme with spots and still redirects for one without", async () => {
  const { trackMeme } = await import("../src/memes.js");
  await trackMeme({ token: "tokdyn", repId: "user_t", repName: "Walt Boxwell", repEmail: "walt@westgatesupply.com", leadId: "lead_t", meme: "tv-show.png", emailId: "acti_t", fills: { first: "Tammy", company: "Crest Mechanical" } });
  const drawn = await fetch(`${base}/m/tokdyn/tv-show.png`, { redirect: "manual" });
  assert.equal(drawn.status, 200);
  assert.equal(drawn.headers.get("content-type"), "image/jpeg");
  assert.equal(drawn.headers.get("cache-control"), "private, max-age=31536000");
  const bytes = Buffer.from(await drawn.arrayBuffer());
  assert.ok(isJpeg(bytes));
  // Kept in the bucket under renders/<name>/<hash>.jpg, so the same text is drawn once.
  const kept = [...bucket.keys()].filter((k) => k.startsWith("renders/tv-show.png/"));
  assert.equal(kept.length, 1, kept.join(","));
  assert.equal(Buffer.compare(bucket.get(kept[0])!, bytes), 0);
  // An unknown token still gets the picture, filled for "there".
  const anon = await fetch(`${base}/m/nobody/tv-show.png`, { redirect: "manual" });
  assert.equal(anon.status, 200);
  assert.equal([...bucket.keys()].filter((k) => k.startsWith("renders/tv-show.png/")).length, 2, "a different text is a second render");
  // No spots: the redirect to the file, as before.
  const plain = await fetch(`${base}/m/tokdyn/ron.png`, { redirect: "manual" });
  assert.equal(plain.status, 302);
  assert.equal(plain.headers.get("location"), `${BUCKET}/storage/v1/object/public/memes/ron.png`);
  // The landing page for a dynamic meme shows the drawing, not the bare file.
  const page = await (await fetch(`${base}/m/tokdyn/tv-show.png/view`)).text();
  assert.ok(page.includes(`src="/m/tokdyn/tv-show.png"`), "the page's image is the drawn one");
});

test("the fills ride on the token; a track from before has none and reads 'there'", async () => {
  const { fillsOf, memeTrack, trackMeme } = await import("../src/memes.js");
  await trackMeme({ token: "tokold", repId: "user_t", repName: "Ulysses Grant", repEmail: "u@westgatesupply.com", leadId: "lead_t", meme: "tv-show.png", emailId: null });
  const t = await memeTrack("tokold");
  assert.deepEqual(t?.fills, { first: null, company: null });
  assert.equal(fillText("Hi {first}, {rep}", fillsOf(t)), "Hi there, Ulysses");
  assert.equal(fillText("{repfull}", fillsOf(null)), "Westgate Supply");
});
