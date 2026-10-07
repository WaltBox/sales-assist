// Writes the contact card for the Close line card template (Walt 10/7): `npm run vcf`.
// Upload server/assets/Westgate-Supply-Walt-Boxwell.vcf to the template's attachments; see playbook/line-card-email.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { renderVcf } from "../src/content/lineCard.js";

const rep = { name: process.env.REP_NAME ?? "Walt Boxwell", email: process.env.REP_EMAIL ?? "walt@westgatesupply.com", phone: process.env.REP_PHONE ?? null, title: "Sales" };
mkdirSync("assets", { recursive: true });
const file = `assets/${rep.name.replace(/\s+/g, "-")}.vcf`.replace("assets/", "assets/Westgate-Supply-");
writeFileSync(file, renderVcf(rep));
console.log(`wrote ${file} (${renderVcf(rep).length} bytes)`);
