// Ask Close to call the hosted server whenever a call changes (its transcript lands),
// so reviews build right away instead of waiting for the panel or the daily job.
//   npm run close-webhook -- https://<your-app>.vercel.app
// Then put the printed signature key in Vercel as CLOSE_WEBHOOK_SIGNATURE_KEY.
import { loadReps } from "../src/config.js";

const base = process.argv[2]?.replace(/\/$/, "");
if (!base?.startsWith("https://")) {
  console.error("usage: npm run close-webhook -- https://<your-app>.vercel.app");
  process.exit(1);
}
const rep = [...loadReps().values()][0];
const res = await fetch("https://api.close.com/api/v1/webhook/", {
  method: "POST",
  headers: { authorization: `Basic ${Buffer.from(`${rep.close_api_key}:`).toString("base64")}`, "content-type": "application/json" },
  body: JSON.stringify({ url: `${base}/api/webhooks/close`, events: [{ object_type: "activity.call", action: "updated" }] }),
});
const body = (await res.json()) as { id?: string; signature_key?: string };
if (!res.ok || !body.signature_key) {
  console.error(`Close said ${res.status}:`, body);
  process.exit(1);
}
console.log(`Webhook ${body.id} created. Add this to Vercel → Settings → Environment Variables:`);
console.log(`CLOSE_WEBHOOK_SIGNATURE_KEY=${body.signature_key}`);
