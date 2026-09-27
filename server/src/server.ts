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
      return createApp({ reps, closeFor: () => fake, llm: demoLlm, website: async () => null });
    })()
  : createApp({ reps, closeFor: (rep) => new CloseClient(rep.close_api_key), llm: structured });

if (!config.demo && !process.env.ANTHROPIC_API_KEY) {
  console.warn("ANTHROPIC_API_KEY is not set; Claude calls will fail unless another credential source is configured.");
}
