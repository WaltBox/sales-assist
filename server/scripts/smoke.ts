// Read-only end-to-end check against real Close + real Claude. Nothing is
// written to Close: it prints the brief and the after-call proposals that the
// panel would show, so you can judge quality before a pilot.
//
//   npm run smoke -- lead_XXXX            # brief + after-call for the rep's latest call on that lead
//   npm run smoke -- lead_XXXX acti_YYYY  # after-call for a specific call

import { afterCall, leadBrief } from "../src/assistant.js";
import { structured } from "../src/claude.js";
import { CloseClient } from "../src/close.js";
import { loadReps } from "../src/config.js";

const [leadId, callId] = process.argv.slice(2);
if (!leadId?.startsWith("lead_")) {
  console.error("usage: npm run smoke -- <lead_id> [call_id]");
  process.exit(1);
}

const rep = [...loadReps().values()][0];
const close = new CloseClient(rep.close_api_key);
const me = await close.me();
const deps = {
  close, llm: structured,
  rep: { name: rep.name, email: rep.email, closeUserId: me.id, timeZone: rep.timezone },
};

console.time("brief");
const brief = await leadBrief(deps, leadId, { refresh: true });
console.timeEnd("brief");
console.log(JSON.stringify(brief, null, 2));

console.time("after-call");
const ac = await afterCall(deps, leadId, { call_id: callId ?? null, rating: brief.brief.rating });
console.timeEnd("after-call");
console.log(JSON.stringify(ac, null, 2));
