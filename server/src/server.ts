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
      // The ICP pass's fields in the demo (11/11), so the heat map shows who each account is: a vessel fab in Texas,
      // a steel fab, an electrical contractor to avoid, one the pass hasn't read.
      fake.customFields_.push({ id: "cf_demo_tier", name: "icp_tier" }, { id: "cf_demo_seg", name: "segment" }, { id: "cf_demo_buys", name: "buys_through" }, { id: "cf_demo_why", name: "icp_why" });
      const icp = (id: string, tier: string, seg: string, buys: string, why: string) => fake.leadFields_[id] = { "custom.cf_demo_tier": tier, "custom.cf_demo_seg": seg, "custom.cf_demo_buys": buys, "custom.cf_demo_why": why };
      icp("lead_demoHarborFab000001", "A", "asme-vessel-skid", "purchasing-desk", "ASME U-stamp vessel and skid fab in Houston with a purchasing desk");
      icp("lead_demoNorthline000001", "A", "asme-vessel-skid", "purchasing-desk", "Skid and process equipment packager, one named buyer");
      icp("lead_demoMesaPipe0000001", "B", "structural-steel", "purchasing-desk", "Structural and misc steel fab with its own shop");
      icp("lead_demoCrestMech000001", "Avoid", "electrical-contractor", "pm-per-project", "Electrical contractor: PMs buy per job");
      icp("lead_demoValleyWeld00001", "A", "heat-exchanger", "purchasing-desk", "Shell and tube exchanger shop in Lake Charles");
      // Northline sent an RFQ a few days ago, so the "like your RFQ senders" row has something to show.
      const rfqAt = new Date(Date.now() - 2 * 86400000).toISOString();
      fake.sentEmails.push({ id: "acti_rfq_demoNorthline", lead_id: "lead_demoNorthline000001", user_id: "user_demoWaltBoxwell000001", status: "inbox", direction: "incoming", subject: "RFQ 4471 - skid piping", date_sent: rfqAt, date_created: rfqAt, sender: "Pat Kim <pat@northline.test>", opens: [], attachments: [{ filename: "RFQ-4471.xlsx", content_type: "application/vnd.ms-excel" }], body_text: "Please quote the attached." });
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
