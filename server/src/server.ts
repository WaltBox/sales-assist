import { structured } from "./claude.js";
import { CloseClient } from "./close.js";
import { config, loadReps } from "./config.js";
import { createApp } from "./app.js";
import { demoLineCards, demoLlm, FakeClose } from "./demo.js";
import { roddaCall } from "./fixtures.js";

// The one app, run two ways: a long-running Node server (src/index.ts) or a Vercel function (api/index.ts).
export const reps = loadReps();

export const app = config.demo
  ? (() => {
      const fake = new FakeClose({ calls: [roddaCall()], simulateDial: true });
      demoLineCards(fake);
      // My leads in the demo (10/19): a few leads owned by the demo rep.
      fake.customFields_.push({ id: "cf_demo_owner", name: "Lead owner" });
      fake.ownedLeads = [
        { id: "lead_demoRoddaElectric0001", display_name: "Rodda Electric, Inc.", status_label: "Sent Line Card", contacts: [{ name: "Renee Ortiz", phones: [{ phone: "+19252406024" }], emails: [{ email: "renee@roddaelectric.com" }] }] },
        { id: "lead_demoOwned00000000002", display_name: "Abanaki Corporation", status_label: "Potential", contacts: [{ name: "Main Office", phones: [{ phone: "+14405437400" }] }] },
        { id: "lead_demoOwned00000000003", display_name: "A&R Mechanical Contractors, Inc.", status_label: "Good lead", contacts: [{ name: "Main Office", phones: [{ phone: "+12173674227" }] }] },
      ];
      return createApp({ reps, closeFor: () => fake, llm: demoLlm, website: async () => null });
    })()
  : createApp({ reps, closeFor: (rep) => new CloseClient(rep.close_api_key), llm: structured });

if (!config.demo && !process.env.ANTHROPIC_API_KEY) {
  console.warn("ANTHROPIC_API_KEY is not set; Claude calls will fail unless another credential source is configured.");
}
