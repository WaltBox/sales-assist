import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  afterCall, afterCallExtras, applyProposals, callState, DuplicateApplyError, leadBrief, leadChat, listStatus, repLines, repStats, warmAfterLead, warmAhead, type Close, type Deps, type Llm,
} from "./assistant.js";
import { ClaudeError } from "./claude.js";
import { CloseError } from "./close.js";
import { config, ROOT, type Rep } from "./config.js";
import type { RepInfo } from "./context.js";
import { background } from "./background.js";
import {
  advance, approveAll, approveItem, chatItem, countItems, discardItem, itemTranscript, listQueue, noteItem, QueueError, quickOutcome, rebuildItem, rescheduleTask, reviewsForCall, sweep, waitingFor,
} from "./queue.js";
import { checkPassword, COMPANY_DOMAIN, hashPassword, isCompanyEmail, issueSession, normalizeEmail, passwordProblem, readSession, recordTry, tooManyTries } from "./auth.js";
import { hashToken, hosted, SupabaseStore, store, type StoredRep } from "./store.js";
import { LineCardError, lineCardFor, sendLineCard } from "./linecard.js";
import { accountsBoard, ensureRescueDrafts, markRescue, RescueError, rescueFor, sendRescue } from "./accounts.js";
import { automationsView, holdAccount, morningRun, planBumps, setAutomations, skipAutomation, syncAutomations } from "./automations.js";
import { dayStats, periodDetail, periodStats, weekStats } from "./stats.js";
import { rejections } from "./validate.js";
import { FollowUpError, writeFollowUp } from "./followup.js";
import { AfterCallRequest, ApplyRequest, ChatRequest, QueueApproveRequest, QueueChatRequest, QuickOutcomeRequest } from "./schemas.js";

export type AppDeps = {
  reps: Map<string, Rep>;
  closeFor: (rep: Rep) => Close;
  llm: Llm;
  website?: Deps["website"];
};

const LEAD_ID = /^lead_[A-Za-z0-9]{10,}$/;

export function createApp(appDeps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  // Keep the raw body: Close signs its webhook calls over the exact bytes.
  app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.demo || config.allowedOrigins.includes(origin)),
    allowedHeaders: ["authorization", "content-type"],
  }));

  if (config.demo) {
    // Lets you open the side panel as a normal web page for a quick look.
    app.use("/preview", express.static(path.resolve(ROOT, "..", "extension")));
  }

  // The web app (the morning view); the side panel is the other half.
  app.use(express.static(path.resolve(ROOT, "web"), { index: "index.html" }));

  app.get("/api/health", (_req, res) => { res.json({ ok: true, model: config.model, demo: config.demo }); });

  // Reps: reps.json (local) plus whoever signed up (the store: a file locally, Supabase when hosted).
  const asRep = (r: StoredRep): Rep => ({ token: `email:${r.email}`, name: r.name, email: r.email, close_api_key: r.close_api_key, timezone: r.timezone ?? "America/Los_Angeles" });
  const repByEmail = async (email: string): Promise<Rep | null> => {
    const local = [...appDeps.reps.values()].find((r) => normalizeEmail(r.email) === email);
    if (local) return local;
    const stored = await store.getRep(email);
    return stored ? asRep(stored) : null;
  };
  const tokenReps = new Map<string, { at: number; rep: Rep | null }>();
  /** A signed-in session (email + password), or the side panel's older per-rep token. */
  const findRep = async (token: string): Promise<Rep | null> => {
    const email = token.startsWith("s1.") ? readSession(token) : null;
    if (email) return repByEmail(email);
    const local = appDeps.reps.get(token);
    if (local || !hosted || token.length < 24) return local ?? null;
    const hash = hashToken(token);
    const hit = tokenReps.get(hash);
    if (hit && Date.now() - hit.at < 60_000) return hit.rep;
    const row = await (store as SupabaseStore).repByTokenHash(hash);
    const rep = row ? asRep(row) : null;
    tokenReps.set(hash, { at: Date.now(), rep });
    return rep;
  };
  const allReps = async (): Promise<Rep[]> => {
    const local = [...appDeps.reps.values()];
    const seen = new Set(local.map((r) => normalizeEmail(r.email)));
    return [...local, ...(await store.listReps()).filter((r) => !seen.has(r.email)).map(asRep)];
  };

  // ---------- sign-in ----------
  const Email = z.object({ email: z.string().max(200) });
  const Creds = z.object({ email: z.string().max(200), password: z.string().max(200), close_api_key: z.string().max(200).optional() });
  const companyEmail = (raw: string) => {
    const email = normalizeEmail(raw);
    if (!isCompanyEmail(email)) throw new AuthError(403, `Use your @${COMPANY_DOMAIN} email.`);
    return email;
  };
  const signedIn = async (email: string) => {
    const rep = (await repByEmail(email))!;
    const u = await store.getUser(email);
    if (u) await store.putUser({ ...u, lastLogin: new Date().toISOString() });
    return { token: issueSession(email), name: rep.name, email };
  };

  // Step 1: which screen to show: sign in, create a password, or also connect Close.
  app.post("/api/auth/check", async (req, res, next) => {
    try {
      const email = companyEmail(Email.parse(req.body).email);
      const [user, rep] = await Promise.all([store.getUser(email), repByEmail(email)]);
      res.json({ email, hasAccount: !!user, needsCloseKey: !user && !rep });
    } catch (err) { next(err); }
  });

  app.post("/api/auth/signup", async (req, res, next) => {
    try {
      const body = Creds.parse(req.body);
      const email = companyEmail(body.email);
      if (await store.getUser(email)) throw new AuthError(409, "There's already an account for that email. Sign in instead.");
      const bad = passwordProblem(body.password);
      if (bad) throw new AuthError(400, bad);
      if (!(await repByEmail(email))) {
        // Someone new: their Close API key connects the assistant to their Close account.
        const key = body.close_api_key?.trim();
        if (!key) throw new AuthError(428, "Add your Close API key so the assistant can read your leads.");
        const me = await appDeps.closeFor({ token: "signup", name: "", email, close_api_key: key, timezone: "America/Los_Angeles" }).me()
          .catch(() => { throw new AuthError(400, "Close didn't accept that API key. Copy it from Close → Settings → API Keys."); });
        if (normalizeEmail(me.email) !== email) throw new AuthError(400, `That API key belongs to ${me.email}, not ${email}.`);
        await store.putRep({ email, name: `${me.first_name} ${me.last_name}`.trim() || email, close_api_key: key, timezone: me.last_used_timezone ?? null });
      }
      await store.putUser({ email, passwordHash: await hashPassword(body.password), createdAt: new Date().toISOString(), lastLogin: null });
      res.json(await signedIn(email));
    } catch (err) { next(err); }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const body = Creds.parse(req.body);
      const email = normalizeEmail(body.email);
      if (tooManyTries(email)) throw new AuthError(429, "Too many tries. Wait 15 minutes and try again.");
      const user = await store.getUser(email);
      const ok = !!user && (await checkPassword(body.password, user.passwordHash));
      recordTry(email, ok);
      if (!ok || !(await repByEmail(email))) throw new AuthError(401, "Wrong email or password.");
      res.json(await signedIn(email));
    } catch (err) { next(err); }
  });

  const repInfoCache = new Map<string, RepInfo>();
  const depsFor = async (rep: Rep): Promise<Deps> => {
    const close = appDeps.closeFor(rep);
    let info = repInfoCache.get(rep.token);
    if (!info) {
      const me = await close.me();
      // Drafts are sent from the rep's connected Close email account.
      const account = me.email_accounts?.find((a) => a.email.toLowerCase() === (rep.email || me.email).toLowerCase() && a.send_status !== "error")
        ?? me.email_accounts?.find((a) => a.send_status === "ok") ?? me.email_accounts?.[0];
      const name = rep.name || `${me.first_name} ${me.last_name}`;
      info = {
        name, email: rep.email || me.email, closeUserId: me.id, timeZone: rep.timezone || me.last_used_timezone || "America/Los_Angeles",
        sender: account ? `"${(account.sender?.name || name).replaceAll('"', "")}" <${account.sender?.email || account.email}>` : null,
        emailAccountId: account?.id ?? null,
      };
      repInfoCache.set(rep.token, info);
    }
    return { close, llm: appDeps.llm, rep: info, website: appDeps.website } satisfies Deps;
  };
  /** Deps for whoever owns a review (webhook and catch-up job have no rep token). */
  const depsForUser = async (closeUserId: string): Promise<Deps | null> => {
    for (const rep of await allReps()) {
      const d = await depsFor(rep).catch(() => null);
      if (d?.rep.closeUserId === closeUserId) return d;
    }
    return null;
  };

  const authed = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    try {
      const rep = await findRep(token);
      if (!rep) {
        res.status(401).json({ error: "You're signed out. Sign in again." });
        return;
      }
      res.locals.deps = await depsFor(rep);
      next();
    } catch (err) {
      next(err);
    }
  };

  const leadId = (req: Request) => {
    const id = String(req.params.leadId);
    if (!LEAD_ID.test(id)) throw new BadRequest("That doesn't look like a Close lead ID.");
    return id;
  };
  const route = (fn: (req: Request, deps: Deps) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await fn(req, res.locals.deps as Deps));
      } catch (err) {
        next(err);
      }
    };

  app.get("/api/me", authed, route(async (_req, d) => ({
    rep: d.rep,
    lines: await repLines(d).catch(() => []),
    stats: await repStats(d).catch(() => null),
  })));

  // Daily stats. The panel sends what its own counter shows; when that
  // disagrees with Close, Close wins and the difference is logged.
  app.get("/api/stats/today", authed, route(async (req, d) => {
    const stats = await dayStats(d, { fresh: req.query.fresh === "1" });
    const local = Number(req.query.local_dials);
    if (req.query.local_dials !== undefined && Number.isFinite(local) && local !== stats.dials) {
      console.info(`[stats] ${d.rep.name} ${stats.day}: panel showed ${local} dials, Close has ${stats.dials} (${stats.dials - local > 0 ? "+" : ""}${stats.dials - local})`);
    }
    return stats;
  }));
  app.get("/api/stats/week", authed, route(async (_req, d) => weekStats(d)));
  // Today / this week / this month / all time: the same counts for any period.
  app.get("/api/stats/period/detail", authed, route(async (req, d) => periodDetail(d,
    z.enum(["today", "week", "month", "all"]).parse(req.query.p ?? "today"),
    z.enum(["dials", "reached", "lineCards", "replied", "rfqs", "rfqReceived"]).parse(req.query.m))));
  app.get("/api/stats/period", authed, route(async (req, d) => periodStats(d, z.enum(["today", "week", "month", "all"]).parse(req.query.p ?? "today"), { fresh: req.query.fresh === "1" })));
  // One status per account we've sent the line card to: what happened and what's next (read from Close).
  app.get("/api/accounts", authed, route(async (req, d) => {
    const board = await accountsBoard(d, { days: Math.min(Number(req.query.days) || 45, 120), fresh: req.query.fresh === "1" });
    // Rescue emails missing a draft get one in the background; the next refresh shows "Draft ready in Close".
    if (board.accounts.some((a) => a.next.rescue && !a.rescueDraft)) background(ensureRescueDrafts(d), "rescue drafts");
    return board;
  }));
  // The rescue call: the email is drafted in Close ahead of time; afterwards, the rep marks whether they found it.
  // Automatic emails: what's going out today and why, what went out, what was skipped or stopped.
  app.get("/api/automations", authed, route((_req, d) => automationsView(d)));
  app.post("/api/automations/toggle", authed, route((req, d) => setAutomations(d, req.body?.enabled === true)));
  app.post("/api/automations/plan", authed, route((_req, d) => planBumps(d, { force: true })));
  app.post("/api/leads/:leadId/hold", authed, route((req, d) => holdAccount(d, leadId(req), req.body?.hold !== false)));
  app.post("/api/automations/:id/skip", authed, route((req, d) => skipAutomation(d, z.string().min(3).max(100).parse(req.params.id))));
  // "Send line card now": the email is ready on the call screen; it goes out while they're on the phone.
  const LineCardReq = z.object({ to: z.string().max(200).optional().nullable(), ask_for: z.string().max(120).optional().nullable(), buys: z.array(z.string().max(80)).max(12).optional() });
  app.post("/api/leads/:leadId/linecard/preview", authed, route((req, d) => {
    const b = LineCardReq.parse(req.body ?? {});
    return lineCardFor(d, leadId(req), { to: b.to ?? null, askFor: b.ask_for ?? null, buys: b.buys });
  }));
  app.post("/api/leads/:leadId/linecard/send", authed, route((req, d) => {
    const b = LineCardReq.parse(req.body ?? {});
    return sendLineCard(d, leadId(req), { to: b.to ?? "", askFor: b.ask_for ?? null, buys: b.buys });
  }));
  app.get("/api/leads/:leadId/rescue", authed, route((req, d) => rescueFor(d, leadId(req))));
  app.post("/api/leads/:leadId/rescue/send", authed, route((req, d) => sendRescue(d, leadId(req), z.string().min(3).max(100).parse(req.body?.draft_id))));
  app.post("/api/leads/:leadId/rescue/found", authed, route((req, d) => markRescue(d, leadId(req), req.body?.found === true, typeof req.body?.name === "string" ? req.body.name.slice(0, 80) : null)));
  // Rejected email drafts and which pre-save rule they broke, newest first.
  app.get("/api/email-rejections", authed, route(async (req) => await rejections(Math.min(Number(req.query.limit) || 100, 500))));

  const SMART_VIEW = /^save_[A-Za-z0-9]{10,}$/;
  const smartViewId = (req: Request) => {
    const id = String(req.params.smartViewId);
    if (!SMART_VIEW.test(id)) throw new BadRequest("That doesn't look like a Close Smart View ID.");
    return id;
  };
  const optionalLead = (v: unknown) => (typeof v === "string" && LEAD_ID.test(v) ? v : null);
  // Rep opened a Smart View (or a lead on it): start writing briefs for the next few leads.
  app.post("/api/smart-views/:smartViewId/warm", authed, route((req, d) => warmAhead(d, smartViewId(req), optionalLead(req.body?.lead_id))));
  app.get("/api/smart-views/:smartViewId/status", authed, route((req, d) => listStatus(d, smartViewId(req), optionalLead(req.query.lead_id))));

  app.get("/api/leads/:leadId/brief", authed, route(async (req, d) => {
    const id = leadId(req);
    const list = warmAfterLead(d, id); // the next leads start writing while this one loads
    const brief = await leadBrief(d, id, { refresh: req.query.refresh === "1" });
    return { ...brief, list: await list };
  }));

  app.get("/api/leads/:leadId/call-state", authed, route((req, d) => {
    const since = z.iso.datetime({ offset: true }).safeParse(req.query.since);
    if (!since.success) throw new BadRequest("since must be an ISO timestamp");
    return callState(d, leadId(req), since.data);
  }));

  app.post("/api/leads/:leadId/after-call", authed, route((req, d) => afterCall(d, leadId(req), AfterCallRequest.parse(req.body))));
  app.post("/api/leads/:leadId/after-call/extras", authed, route((req, d) => afterCallExtras(d, leadId(req), AfterCallRequest.parse(req.body))));

  app.post("/api/leads/:leadId/chat", authed, route((req, d) => leadChat(d, leadId(req), ChatRequest.parse(req.body))));

  // One tap after a call: saves status + callback now, queues the rest.
  // "Write a follow-up": one tap drafts a short bump in Close, threaded under the last email.
  app.post("/api/leads/:leadId/follow-up", authed, route((req, d) => writeFollowUp(d, leadId(req), { force: req.body?.force === true })));
  app.post("/api/leads/:leadId/outcome", authed, route((req, d) => quickOutcome(d, leadId(req), QuickOutcomeRequest.parse(req.body))));

  app.post("/api/leads/:leadId/tasks/:taskId/reschedule", authed, route((req, d) =>
    rescheduleTask(d, leadId(req), String(req.params.taskId), z.string().parse(req.body?.due_at))));

  // The approval queue.
  const queueId = (req: Request) => String(req.params.id);
  // Reviews waiting on a transcript move along whenever the panel looks (at most every 20s each).
  const kicked = new Map<string, number>();
  const kick = (d: Deps, id: string) => {
    if (Date.now() - (kicked.get(id) ?? 0) < 20_000) return;
    kicked.set(id, Date.now());
    background(advance(d, id), "build");
  };
  app.get("/api/queue", authed, route(async (_req, d) => {
    const items = (await listQueue(d)).map((it) => ({ ...it, count: countItems(it.proposals) }));
    for (const it of items) if (it.state === "building") kick(d, it.id);
    return {
      items,
      ready: items.filter((i) => i.state === "ready" || i.state === "failed").length, // need the rep
      building: items.filter((i) => i.state === "building").length,
      saved: items.filter((i) => i.state === "saved").length,
    };
  }));
  app.post("/api/queue/approve-all", authed, route(async (_req, d) => approveAll(d)));
  app.post("/api/queue/:id/approve", authed, route((req, d) => approveItem(d, queueId(req), QueueApproveRequest.parse(req.body ?? {}).proposals)));
  app.post("/api/queue/:id/discard", authed, route(async (req, d) => discardItem(d, queueId(req))));
  app.post("/api/queue/:id/note", authed, route(async (req, d) => noteItem(d, queueId(req), String(req.body?.note ?? "").slice(0, 1000))));
  app.post("/api/queue/:id/rebuild", authed, route(async (req, d) => rebuildItem(d, queueId(req))));
  app.get("/api/queue/:id/transcript", authed, route((req, d) => itemTranscript(d, queueId(req))));
  app.post("/api/queue/:id/chat", authed, route((req, d) => chatItem(d, queueId(req), QueueChatRequest.parse(req.body))));

  app.post("/api/leads/:leadId/apply", authed, route((req, d) => {
    const body = ApplyRequest.parse(req.body);
    return applyProposals(d, leadId(req), body.proposals, body.rating ?? null);
  }));

  // Close tells us when a call changes (its transcript landed): build that call's review now.
  app.post("/api/webhooks/close", async (req: Request, res: Response) => {
    if (!verifyClose(req)) {
      res.status(401).json({ error: "bad signature" });
      return;
    }
    res.json({ ok: true });
    const ev = (req.body?.event ?? {}) as { object_type?: string; object_id?: string };
    if (ev.object_type !== "activity.call" || !ev.object_id) return;
    background((async () => {
      for (const it of await reviewsForCall(ev.object_id!)) {
        if (it.state !== "building") continue;
        const d = await depsForUser(it.repId);
        if (d) await advance(d, it.id);
      }
    })(), "webhook");
  });

  // Catch-up: anything still waiting gets built (Vercel Cron, or every 15s on a local server).
  let lastAutoCheck = 0;
  const catchUp = async () => {
    // Automatic emails: plan the morning's bumps, and re-check the ones about to go (every few minutes).
    if (Date.now() - lastAutoCheck > 3 * 60_000) {
      lastAutoCheck = Date.now();
      for (const rep of await allReps().catch(() => [])) {
        const d = await depsFor(rep).catch(() => null);
        if (!d) continue;
        await morningRun(d).catch((err) => console.error(`morning run ${rep.email}:`, (err as Error).message));
        await ensureRescueDrafts(d).catch((err) => console.error(`rescue drafts ${rep.email}:`, (err as Error).message));
        await syncAutomations(d).catch((err) => console.error(`sync ${rep.email}:`, (err as Error).message));
      }
    }
    const waiting = await waitingFor(null);
    for (const it of waiting) {
      const d = await depsForUser(it.repId);
      if (d) await advance(d, it.id).catch((err) => console.error(`catch-up ${it.id}:`, (err as Error).message));
    }
    await sweep().catch(() => {});
    return { waiting: waiting.length };
  };
  app.locals.catchUp = catchUp;
  app.get("/api/cron/catch-up", async (req: Request, res: Response, next: NextFunction) => {
    if (!config.cronSecret || req.header("authorization") !== `Bearer ${config.cronSecret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try { res.json(await catchUp()); } catch (err) { next(err); }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) res.status(400).json({ error: err.message });
    else if (err instanceof AuthError) res.status(err.status).json({ error: err.message, ...(err.status === 428 ? { needsCloseKey: true } : {}) });
    else if (err instanceof z.ZodError) res.status(400).json({ error: "Bad request", details: z.prettifyError(err) });
    else if (err instanceof DuplicateApplyError) res.status(409).json({ error: err.message });
    else if (err instanceof QueueError) res.status(409).json({ error: err.message });
    else if (err instanceof FollowUpError) res.status(409).json({ error: err.message });
    else if (err instanceof RescueError) res.status(409).json({ error: err.message });
    else if (err instanceof LineCardError) res.status(409).json({ error: err.message });
    else if (err instanceof ClaudeError) res.status(502).json({ error: err.message });
    else if (err instanceof CloseError) res.status(err.status === 404 ? 404 : 502).json({ error: err.status === 401 ? "Close rejected this rep's API key." : err.message });
    else {
      console.error(err);
      res.status(500).json({ error: "Something went wrong on the server." });
    }
  });
  return app;
}

class BadRequest extends Error {}
class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Close signs webhooks: HMAC-SHA256 over timestamp + raw body, keyed with the subscription's signature_key (hex). */
function verifyClose(req: Request): boolean {
  if (!config.closeWebhookKey) return false;
  const ts = req.header("close-sig-timestamp") ?? "";
  const sig = req.header("close-sig-hash") ?? "";
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!ts || !sig || !raw) return false;
  const want = createHmac("sha256", Buffer.from(config.closeWebhookKey, "hex")).update(ts).update(raw).digest("hex");
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}
