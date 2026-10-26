import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { ROOT } from "./config.js";

/** The packed Chrome extension the web app hands out (built by `npm run pack-extension`). */
export const EXTENSION_DIR = path.resolve(ROOT, "..", "extension");
export const EXTENSION_ZIP = path.join(ROOT, "downloads", "westgate-assistant-extension.zip");

/** The version inside the packed zip, or null when there isn't one. */
export function packedVersion(): string | null {
  try {
    const files = unzipSync(new Uint8Array(fs.readFileSync(EXTENSION_ZIP)), { filter: (f) => f.name.endsWith("manifest.json") });
    const m = Object.values(files)[0];
    return m ? JSON.parse(Buffer.from(m).toString("utf8")).version ?? null : null;
  } catch { return null; }
}

/**
 * The packed extension's files, for the web app's Update button (Walt 10/26: "when you click it, it makes sure the
 * files you have locally are the newest"): the page writes them into the folder the rep picked.
 */
export function packedFiles(): { version: string | null; files: Array<{ path: string; b64: string }> } | null {
  try {
    const all = unzipSync(new Uint8Array(fs.readFileSync(EXTENSION_ZIP)));
    const files = Object.entries(all).filter(([name]) => !name.endsWith("/"))
      .map(([name, data]) => ({ path: name.replace(/^westgate-assistant\//, ""), b64: Buffer.from(data).toString("base64") }));
    return { version: packedVersion(), files };
  } catch { return null; }
}
