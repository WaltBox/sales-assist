import path from "node:path";
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { ROOT } from "./config.js";

// Dynamic memes (Walt 11/10): a meme is a base image plus one or two text spots, and the text is drawn when the
// image loads, with the buyer's name and the rep's name filled in. One template serves every rep and every buyer.

/** A text spot on a meme. The box is in fractions of the image (0 to 1), so it fits whatever size the image is. */
export type Spot = { x: number; y: number; w: number; h: number; text: string; style: "meme" | "plain"; align?: "center" | "left" };
/** What a spot's fill-ins are filled with. */
export type Fills = { first?: string | null; company?: string | null; rep?: string | null; repfull?: string | null };
/** The fill-ins the editor offers; {name} is the same as {first}. */
export const FILL_INS = ["{first}", "{company}", "{rep}", "{repfull}"] as const;
/** What the editor and the landing page show (11/10): a sample buyer; the rep is whoever is signed in. */
export const SAMPLE_FILLS: Fills = { first: "Sam", company: "Crest Mechanical" };

const FONTS = { meme: "Anton", plain: "42dot Sans" } as const;
let fontsReady = false;
/** The bundled fonts, registered once: Anton for the Impact look, 42dot Sans (the app's reading font) for plain text. */
export function registerFonts() {
  if (fontsReady) return;
  fontsReady = true;
  GlobalFonts.registerFromPath(path.join(ROOT, "fonts", "Anton-Regular.ttf"), FONTS.meme);
  GlobalFonts.registerFromPath(path.join(ROOT, "web", "fonts", "42dotSans-Medium.woff2"), FONTS.plain);
}

/** The fill-ins replaced. A missing first name reads "there" ("Hi there"); the rest fall back to blank. */
export function fillText(text: string, fills: Fills): string {
  const first = (fills.first ?? "").trim() || "there";
  const repfull = (fills.repfull ?? "").trim();
  const rep = (fills.rep ?? "").trim() || repfull.split(/\s+/)[0] || "";
  const map: Record<string, string> = { first, name: first, company: (fills.company ?? "").trim(), rep, repfull: repfull || rep };
  return text.replace(/\{(first|name|company|rep|repfull)\}/gi, (_, k: string) => map[k.toLowerCase()] ?? "");
}

/** Greedy word wrap at a width. A word wider than the line stands on its own line (the caller shrinks the font). */
function wrap(ctx: SKRSContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = w; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

const LINE = { meme: 1.05, plain: 1.3 } as const;
const font = (style: Spot["style"], size: number) => `${size}px "${FONTS[style]}"`;

/**
 * How a text fits a box (in pixels): the font size and the lines. Meme style starts as big as the box and shrinks
 * until every line fits the width and the lines fit the height; plain is a fixed size (the image's height over 22),
 * just wrapped.
 */
export function measure(text: string, box: { w: number; h: number }, style: Spot["style"], imageH = box.h * 4): { size: number; lines: string[]; lineHeight: number } {
  registerFonts();
  const ctx = createCanvas(8, 8).getContext("2d");
  const shown = style === "meme" ? text.toUpperCase() : text;
  const pad = Math.max(2, box.w * 0.03);
  const maxW = Math.max(1, box.w - pad * 2);
  if (style === "plain") {
    const size = Math.max(12, Math.round(imageH / 22));
    ctx.font = font(style, size);
    return { size, lines: wrap(ctx, shown, maxW), lineHeight: size * LINE.plain };
  }
  let size = Math.max(10, Math.floor(box.h * 0.9));
  for (; size > 10; size = Math.floor(size * 0.92)) {
    ctx.font = font(style, size);
    const lines = wrap(ctx, shown, maxW);
    const fitsW = lines.every((l) => ctx.measureText(l).width <= maxW);
    if (fitsW && lines.length * size * LINE.meme <= box.h) return { size, lines, lineHeight: size * LINE.meme };
  }
  ctx.font = font(style, size);
  return { size, lines: wrap(ctx, shown, maxW), lineHeight: size * LINE.meme };
}

/** The image with every spot's text drawn in, as a JPEG. The base can be any image the email apps show (jpg, png, gif, webp). */
export async function renderMeme(imageBytes: Buffer, spots: Spot[], fills: Fills): Promise<Buffer> {
  registerFonts();
  const img = await loadImage(imageBytes);
  const W = img.width, H = img.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H); // a transparent png gets a white ground, as the email app would show it
  ctx.drawImage(img, 0, 0, W, H);
  for (const s of spots) {
    const text = fillText(s.text, fills).trim();
    if (!text) continue;
    const box = { x: s.x * W, y: s.y * H, w: Math.max(1, s.w * W), h: Math.max(1, s.h * H) };
    const m = measure(text, box, s.style, H);
    ctx.font = font(s.style, m.size);
    ctx.textBaseline = "middle";
    ctx.textAlign = s.align === "left" ? "left" : "center";
    const pad = Math.max(2, box.w * 0.03);
    const x = s.align === "left" ? box.x + pad : box.x + box.w / 2;
    const total = m.lines.length * m.lineHeight;
    const top = box.y + Math.max(0, (box.h - total) / 2);
    m.lines.forEach((line, i) => {
      const y = top + i * m.lineHeight + m.lineHeight / 2;
      if (s.style === "meme") {
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(2, m.size / 10);
        ctx.strokeStyle = "#000";
        ctx.strokeText(line, x, y);
        ctx.fillStyle = "#fff";
      } else {
        ctx.fillStyle = "#111114";
      }
      ctx.fillText(line, x, y);
    });
  }
  return canvas.encode("jpeg", 88);
}
