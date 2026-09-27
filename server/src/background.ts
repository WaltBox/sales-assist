import { waitUntil } from "@vercel/functions";

/**
 * Work that finishes after the response is sent (building a review, warming the
 * next briefs, logging). On Vercel the function stays alive until it's done;
 * on a normal Node server it just runs.
 */
export function background(p: Promise<unknown>, what: string) {
  const guarded = p.catch((err) => console.error(`${what}:`, (err as Error).message));
  try {
    waitUntil(guarded);
  } catch {}
  return guarded;
}
