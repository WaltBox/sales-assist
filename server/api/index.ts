// Vercel entry: every request is rewritten to this one function (see vercel.json), and the
// original path rides along as ?__path=. Put it back so Express routes the real request.
import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../src/server.js";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const original = url.searchParams.get("__path");
  if (original !== null) {
    url.searchParams.delete("__path");
    const query = url.searchParams.toString();
    req.url = `${original.startsWith("/") ? original : `/${original}`}${query ? `?${query}` : ""}`;
  }
  return app(req as never, res as never);
}
