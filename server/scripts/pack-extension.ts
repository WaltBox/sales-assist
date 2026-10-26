// The Chrome extension as a zip the web app hands out (10/19: "a button to download it, with instructions").
// The hosted app only deploys server/, so the zip is built here and committed: run this after any change to
// extension/ (a test fails if the zip is behind the extension's version).
//   npm run pack-extension
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { EXTENSION_ZIP, EXTENSION_DIR } from "../src/extension.js";

const files: Record<string, Uint8Array> = {};
const walk = (dir: string) => {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files[`westgate-assistant/${path.relative(EXTENSION_DIR, full).split(path.sep).join("/")}`] = fs.readFileSync(full);
  }
};
walk(EXTENSION_DIR);
// West Game is shared with the guest page (10/25): the hosted app only deploys server/, so it gets a copy.
for (const f of ["westgame.js", "westgame.css"]) fs.copyFileSync(path.join(EXTENSION_DIR, f), path.resolve(EXTENSION_DIR, "..", "server", "web", f));
// Fixed timestamps, so the zip only changes when the extension does.
const zip = zipSync(Object.fromEntries(Object.entries(files).sort().map(([k, v]) => [k, [v, { mtime: new Date("2026-01-01T00:00:00Z") }]])), { level: 9 });
fs.mkdirSync(path.dirname(EXTENSION_ZIP), { recursive: true });
fs.writeFileSync(EXTENSION_ZIP, zip);
const version = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8")).version;
console.log(`${path.relative(process.cwd(), EXTENSION_ZIP)}: version ${version}, ${Object.keys(files).length} files, ${Math.round(zip.length / 1024)} KB`);
