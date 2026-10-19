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
