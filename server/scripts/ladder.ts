// The ladder in Close (Walt 11/11): the statuses the pipeline runs on, every lead moved to the rung its facts say,
// and the unowned A and B leads dealt out as territories, so each BDR has a working pool and a discovery pool.
//
//   npm run ladder -- --statuses                 # make Fit, Named buyer, Reached buyer, Not a fit (idempotent)
//   npm run ladder -- --migrate                  # print where every sales lead would move; add --write to do it
//   npm run ladder -- --territories --reps chase@westgatesupply.com,liam@westgatesupply.com   # print; --write assigns
//   --limit 200                                  # size, for a first look
//
// Forward only, like everything else that touches statuses: a lead never moves down the ladder, and Customer,
// Vendor, Not Interested and the RFQ rungs are never touched. Nothing here deletes a status or a lead.
import fs from "node:fs";
import path from "node:path";
import { CloseClient, type CloseLead } from "../src/close.js";
import { loadReps, ROOT } from "../src/config.js";
import { buyerOf, ICP_FIELD_NAMES, ladderFor, OUT_STATUS, RUNG_STATUS, rungIndex, rungOfStatus, type Rung } from "../src/ladder.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const write = flag("write");
const limit = Number(opt("limit", "0")) || Infinity;
const LOG = path.join(ROOT, ".cache", "ladder-runs.jsonl");

const rep = [...loadReps().values()][0];
if (!rep) throw new Error("no rep in reps.json");
const close = new CloseClient(rep.close_api_key);
const log = (line: unknown) => { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...(line as object) })}\n`); };

// ---------- the statuses ----------

const WANT = [RUNG_STATUS.fit, RUNG_STATUS.named, RUNG_STATUS.reached, OUT_STATUS[0]];
async function statuses() {
  const have = await close.leadStatuses();
  const byLabel = new Map(have.map((s) => [s.label.toLowerCase(), s]));
  for (const label of WANT) {
    if (byLabel.has(label.toLowerCase())) { console.log(`have   ${label}`); continue; }
    if (!write) { console.log(`would make ${label}`); continue; }
    const made = await close.createLeadStatus(label);
    byLabel.set(label.toLowerCase(), made);
    console.log(`made   ${label} (${made.id})`);
  }
  return new Map([...byLabel.values()].map((s) => [s.label, s.id]));
}

// ---------- every sales lead, to the rung its facts say ----------

const GULF = new Set(["TX", "LA", "OK", "NM", "MS", "AL", "AR"]);
async function* leads(fields: string[]) {
  // Everyone but the rep's own test leads.
  for await (const l of close.allLeads(fields)) {
    if (/^test lead\b/i.test(l.display_name)) continue;
    yield l;
  }
}
async function migrate() {
  const ids = await statuses();
  const fields = await close.leadCustomFields();
  const tierField = fields.find((f) => f.name === ICP_FIELD_NAMES.tier)?.id ?? null;
  if (!tierField) console.warn("no icp_tier field yet: Fit can't be told from Potential; run the ICP pass first");
  const list = ["id", "display_name", "status_label", "contacts", "addresses", "date_created", ...(tierField ? [`custom.${tierField}`] : [])];
  const counts: Record<string, number> = {};
  let n = 0, moved = 0;
  for await (const l of leads(list)) {
    if (++n > limit) break;
    const from = l.status_label ?? "";
    const stage = rungOfStatus(from);
    // Only leads on the ladder (or with no status we know) move; the side exits and the RFQ rungs stay as the reps set them.
    if (stage === "out" || (stage && rungIndex(stage) >= rungIndex("rfq"))) continue;
    const tier = tierField ? ((l[`custom.${tierField}`] as string | undefined) ?? null) : null;
    const L = ladderFor({ lead: l, tier, cardSentAt: from.toLowerCase() === "sent line card" ? "yes" : null });
    const to = L.stage === "out" ? OUT_STATUS[0] : L.stage === "potential" ? RUNG_STATUS.potential : RUNG_STATUS[L.stage as Rung];
    if (to.toLowerCase() === from.toLowerCase()) continue;
    const key = `${from || "(none)"} → ${to}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (!write) continue;
    const id = ids.get(to);
    if (!id) { console.warn(`no status "${to}" in Close; run --statuses --write first`); continue; }
    await close.updateLeadStatus(l.id, id);
    log({ kind: "status", leadId: l.id, company: l.display_name, from, to, tier, buyer: L.buyer?.name ?? null });
    moved++;
  }
  console.log(`\n${n} leads read${write ? `, ${moved} moved` : " (nothing written: add --write)"}`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(5)}  ${k}`);
}

// ---------- territories: the unowned A and B leads, dealt out by state ----------

async function territories() {
  const emails = opt("reps", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) throw new Error("--reps a@westgatesupply.com,b@westgatesupply.com");
  const users = await close.users();
  const reps = emails.map((e) => { const u = users.find((x) => x.email.toLowerCase() === e); if (!u) throw new Error(`no Close user ${e}`); return u; });
  const fields = await close.leadCustomFields();
  const ownerField = fields.find((f) => f.name.trim().toLowerCase() === "lead owner")?.id;
  const tierField = fields.find((f) => f.name === ICP_FIELD_NAMES.tier)?.id;
  if (!ownerField || !tierField) throw new Error("needs the Lead owner and icp_tier fields");
  const pool: CloseLead[] = [];
  for await (const l of leads(["id", "display_name", "status_label", "addresses", "contacts", `custom.${ownerField}`, `custom.${tierField}`])) {
    const tier = l[`custom.${tierField}`];
    if (tier !== "A" && tier !== "B") continue;
    if (l[`custom.${ownerField}`]) continue;
    const stage = rungOfStatus(l.status_label);
    if (stage === "out" || (stage && rungIndex(stage) >= rungIndex("rfq"))) continue;
    pool.push(l);
    if (pool.length >= limit) break;
  }
  // Gulf first, A before B, then the rest; dealt round-robin so every rep gets the same share of each kind.
  const state = (l: CloseLead) => l.addresses?.[0]?.state ?? "";
  pool.sort((a, b) => Number(GULF.has(state(b))) - Number(GULF.has(state(a))) || String(a[`custom.${tierField}`]).localeCompare(String(b[`custom.${tierField}`])) || state(a).localeCompare(state(b)));
  const share = new Map(reps.map((r) => [r.id, { name: r.first_name, n: 0, gulf: 0, a: 0, named: 0 }]));
  for (const [i, l] of pool.entries()) {
    const r = reps[i % reps.length];
    const s = share.get(r.id)!;
    s.n++; if (GULF.has(state(l))) s.gulf++; if (l[`custom.${tierField}`] === "A") s.a++; if (buyerOf(l.contacts)) s.named++;
    if (!write) continue;
    await close.updateLead(l.id, { [`custom.${ownerField}`]: r.id });
    log({ kind: "owner", leadId: l.id, company: l.display_name, to: r.email, tier: l[`custom.${tierField}`], state: state(l) });
  }
  console.log(`${pool.length} unowned A/B leads${write ? " assigned" : " (nothing written: add --write)"}`);
  for (const s of share.values()) console.log(`  ${s.name}: ${s.n} (${s.a} A, ${s.gulf} Gulf, ${s.named} with a buyer already named)`);
}

if (flag("statuses")) await statuses();
else if (flag("migrate")) await migrate();
else if (flag("territories")) await territories();
else console.log("usage: --statuses | --migrate [--write] | --territories --reps a,b [--write]  (--limit N)");
