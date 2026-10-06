// RFQ potential for every account on the board: read the sites that haven't been read (or are a month old),
// then print the tier split and who's still Unknown.
//   npm run potential               # read what's missing or stale
//   npm run potential -- --force    # read everyone again
//   npm run potential -- --unknown  # read again only the ones still Unknown
import { accountsBoard } from "../src/accounts.js";
import { structured } from "../src/claude.js";
import { CloseClient } from "../src/close.js";
import { loadReps } from "../src/config.js";
import { loadProfiles, potentialFor, refreshProfiles, TIER_LABEL, type Tier } from "../src/potential.js";

const force = process.argv.includes("--force");
const onlyUnknown = process.argv.includes("--unknown");

const rep = [...loadReps().values()][0];
const close = new CloseClient(rep.close_api_key);
const me = await close.me();
const d = { close, llm: structured, rep: { name: rep.name, email: rep.email, closeUserId: me.id, timeZone: rep.timezone } };

const board = await accountsBoard(d, { fresh: true });
const accounts = board.accounts.filter((a) => !a.rfq);
const before = await loadProfiles(d.rep.closeUserId);
const targets = onlyUnknown ? accounts.filter((a) => (potentialFor(before[a.leadId])?.tier ?? "unknown") === "unknown") : accounts;
console.log(`${accounts.length} accounts without an RFQ; reading ${force || onlyUnknown ? targets.length : "the missing and stale"}…`);
const started = Date.now();
const n = await refreshProfiles(d, targets, { max: 500, force: force || onlyUnknown });
console.log(`read ${n} sites in ${Math.round((Date.now() - started) / 1000)}s`);

const after = await loadProfiles(d.rep.closeUserId);
const tiers: Record<Tier, string[]> = { steady: [], project: [], occasional: [], unknown: [] };
const problems: string[] = [];
for (const a of accounts) {
  const p = potentialFor(after[a.leadId]);
  tiers[p?.tier ?? "unknown"].push(a.company);
  if (!p || p.tier === "unknown") problems.push(`${a.company.padEnd(40)} ${after[a.leadId]?.problem ?? "not read"}${a.website ? ` (${a.website})` : ""}`);
}
for (const t of Object.keys(tiers) as Tier[]) console.log(`${TIER_LABEL[t].padEnd(11)} ${tiers[t].length}`);
if (problems.length) { console.log(`\nStill unknown (${problems.length}):`); for (const line of problems) console.log("  " + line); }
