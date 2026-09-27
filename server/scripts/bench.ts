// Times the brief and after-call on real leads with different models. Read-only: nothing is written to Close.
//   npm run bench -- lead_A lead_B ...
import { afterCall, leadBrief } from "../src/assistant.js";
import { structured } from "../src/claude.js";
import { CloseClient } from "../src/close.js";
import { config, loadReps } from "../src/config.js";

const leads = process.argv.slice(2);
const models = (process.env.MODELS ?? "claude-opus-5,claude-sonnet-5,claude-haiku-4-5").split(",");
const rep = [...loadReps().values()][0];
const close = new CloseClient(rep.close_api_key);
const me = await close.me();
const deps = { close, llm: structured, rep: { name: rep.name, email: rep.email, closeUserId: me.id, timeZone: rep.timezone } };

for (const model of models) {
  (config as { briefModel: string }).briefModel = model;
  (config as { afterCallModel: string }).afterCallModel = model;
  for (const lead of leads) {
    let t = Date.now();
    try {
      const b = await leadBrief(deps, lead, { refresh: true });
      const briefS = (Date.now() - t) / 1000;
      t = Date.now();
      const ac = process.env.SKIP_AFTER_CALL ? null : await afterCall(deps, lead, { rating: b.brief.rating });
      const acS = ac ? `${((Date.now() - t) / 1000).toFixed(1)}s` : "-";
      console.log(`\n=== ${model} | ${b.header.company} | brief ${briefS.toFixed(1)}s | after-call ${acS}`);
      console.log(`  ${b.brief.rating}: ${b.brief.opener}`);
      if (ac) console.log(`  Note: ${ac.proposals.note?.text.replace(/\n/g, " ") ?? "-"}\n  Email subj: ${ac.proposals.email?.subject ?? "-"}`);
    } catch (e) {
      console.log(`\n=== ${model} | ${lead} | ERROR ${(e as Error).message}`);
    }
  }
}
