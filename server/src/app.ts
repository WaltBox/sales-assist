import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import {
  afterCall, afterCallExtras, applyProposals, callState, DuplicateApplyError, leadBrief, leadChat, listStatus, repLines, repStats, saveSaid, warmAfterLead, warmAhead, warmLeads, type Close, type Deps, type Llm,
} from "./assistant.js";
import { ClaudeError } from "./claude.js";
import { CloseError } from "./close.js";
import { loadProfiles, potentialFor, recordPurchasing, recordRepSaid, refreshProfiles } from "./potential.js";
import { markReachedByHand, markReachedFromCalls, syncDialViews } from "./dialviews.js";
import { askNext, confirmAnswers, FIELDS, type Field } from "./purchasing.js";
import { config, ROOT, type Rep } from "./config.js";
import type { RepInfo } from "./context.js";
import { background } from "./background.js";
import {
  advance, approveAll, approveItem, chatItem, countItems, discardItem, itemTranscript, listQueue, noteItem, QueueError, queueShotDown, quickOutcome, rebuildItem, rescheduleTask, reviewsForCall, setLineCardFormat, sweep, waitingFor,
} from "./queue.js";
import { checkPassword, COMPANY_DOMAIN, hashPassword, isCompanyEmail, issueSession, normalizeEmail, passwordProblem, readSession, recordTry, tooManyTries } from "./auth.js";
import { hashToken, hosted, SupabaseStore, store, type StoredRep } from "./store.js";
import { deleteMeme, listMemes, logMemeEvent, memeCounts, MemeError, memeLanding, memesSeen, memeStats, memeUrl, pickMeme, renameMeme, trackingOn, uploadMemes, type MemeStats } from "./memes.js";
import { LineCardError, lineCardBounce, lineCardFor, sendLineCard } from "./linecard.js";
import { accountsBoard, advanceStatus, bustBoard, ensureRescueDrafts, type Account, markNotInterested, markRescue, markRfqReceived, RescueError, rescueFor, RFQ_STAGES, sendRescue, setRfqStatus, ShotDownError, undoNotInterested } from "./accounts.js";
import { automationsView, coolingFor, sentEmailsView, dropRescueDraft, holdAccount, morningRun, planBumps, setAutomations, skipAutomation, syncAutomations, setTestMode, sendBumpsNow, stopScheduledFor } from "./automations.js";
import { dayStats, periodDetail, periodStats, rfqTimeline, weekStats } from "./stats.js";
import { rejections } from "./validate.js";
import { FollowUpError, writeFollowUp } from "./followup.js";
import { AfterCallRequest, ApplyRequest, ChatRequest, LineCardFormatRequest, QueueApproveRequest, QueueChatRequest, QuickOutcomeRequest } from "./schemas.js";

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

  // The meme in a bump (10/6): the image and the link come through here so a load or a click is logged, then the
  // image itself. No sign-in: the buyer's mail app and browser are the callers. An unknown token still gets the image.
  app.get("/m/:token/:name", async (req, res) => {
    const name = String(req.params.name);
    if (!/^[a-z0-9-]+\.(jpe?g|png|gif|webp)$/i.test(name)) { res.status(404).end(); return; }
    await logMemeEvent(String(req.params.token), "shown", req.header("user-agent") ?? null).catch(() => null);
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.redirect(302, memeUrl(name));
  });
  app.get("/m/:token/:name/view", async (req, res) => {
    const name = String(req.params.name);
    if (!/^[a-z0-9-]+\.(jpe?g|png|gif|webp)$/i.test(name)) { res.status(404).end(); return; }
    const t = await logMemeEvent(String(req.params.token), "clicked", req.header("user-agent") ?? null).catch(() => null);
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.type("html").send(memeLanding({ name, url: memeUrl(name) }, t?.repName ?? "Walt", t?.repEmail ?? "walt@westgatesupply.com"));
  });
  // The web app (the morning view); the side panel is the other half.
  // Always revalidate the web app's files: a stale app.js or app.css after a deploy is worse than one extra round trip.
  app.use(express.static(path.resolve(ROOT, "web"), { index: "index.html", setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));

  // What's configured (never the values): the first thing to check on a new deploy.
  app.get("/api/health", (_req, res) => {
    const missing = [
      config.provider === "openai" && !process.env.OPENAI_API_KEY && !config.demo ? "OPENAI_API_KEY" : null,
      config.provider === "claude" && !process.env.ANTHROPIC_API_KEY && !config.demo ? "ANTHROPIC_API_KEY" : null,
      process.env.VERCEL && !config.supabaseUrl ? "SUPABASE_URL" : null,
      process.env.VERCEL && !config.supabaseKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
      process.env.VERCEL && !config.sessionSecret ? "SESSION_SECRET" : null,
      process.env.VERCEL && !config.cronSecret ? "CRON_SECRET" : null,
    ].filter(Boolean);
    res.json({ ok: missing.length === 0, model: config.model, demo: config.demo, store: hosted ? "supabase" : "file", reps: appDeps.reps.size, provider: config.provider === "openai" && process.env.OPENAI_API_KEY ? `openai (${config.openaiModel}, fast: ${config.openaiFastModel})` : `claude (${config.model})`, backup: config.provider === "openai" ? (process.env.ANTHROPIC_API_KEY ? "claude" : null) : (process.env.OPENAI_API_KEY ? config.openaiModel : null), missing });
  });

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
        phone: rep.phone ?? null,
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
  // RFQs over time, for the growth line on the RFQs page.
  app.get("/api/stats/rfqs", authed, route(async (req, d) => rfqTimeline(d, { fresh: req.query.fresh === "1" })));
  // Today / this week / this month / all time: the same counts for any period.
  app.get("/api/stats/period/detail", authed, route(async (req, d) => periodDetail(d,
    z.enum(["today", "week", "month", "all"]).parse(req.query.p ?? "today"),
    z.enum(["dials", "reached", "lineCards", "replied", "rfqs", "rfqReceived"]).parse(req.query.m))));
  app.get("/api/stats/period", authed, route(async (req, d) => periodStats(d, z.enum(["today", "week", "month", "all"]).parse(req.query.p ?? "today"), { fresh: req.query.fresh === "1" })));
  // Who's getting called today, in the order the board shows them: callbacks due, replies to answer, hot, rescue calls.
  const callListIds = (accounts: Account[]) => accounts.filter((a) => ["call_due", "reply", "rescue"].includes(a.next.kind) || a.section === "hot").map((a) => a.leadId);
  // One status per account we've sent the line card to: what happened and what's next (read from Close).
  app.get("/api/accounts", authed, route(async (req, d) => {
    const board = await accountsBoard(d, { days: Math.min(Number(req.query.days) || 45, 120), fresh: req.query.fresh === "1" });
    // Rescue emails missing a draft get one in the background; the next refresh shows "Draft ready in Close".
    if (board.accounts.some((a) => a.next.rescue && !a.rescueDraft)) background(ensureRescueDrafts(d), "rescue drafts");
    // Accounts whose site hasn't been read yet get read in the background, a few per refresh (RFQ potential, 10/5).
    if (!config.demo && board.accounts.some((a) => !a.potential)) background(refreshProfiles(d, board.accounts, { max: 12 }).then(() => bustBoard(d)), "rfq potential");
    // Today's calls get their briefs written now, so the call card opens instantly (10/6).
    if (!config.demo) background(warmLeads(d, callListIds(board.accounts)), "warm today's calls");
    // Anyone you've reached today, by Close's call record, comes off today's call lists (10/6).
    if (!config.demo) background(markReachedFromCalls(d, board.accounts), "reached today");
    return board;
  }));
  // RFQ potential: read every account's site now (or one account's again), and the rep's own answer after a call.
  app.post("/api/potential/refresh", authed, route(async (req, d) => {
    const board = await accountsBoard(d);
    const ids = Array.isArray(req.body?.lead_ids) ? new Set<string>(req.body.lead_ids) : null;
    const n = await refreshProfiles(d, ids ? board.accounts.filter((a) => ids.has(a.leadId)) : board.accounts, { max: Number(req.body?.max) || 300, force: !!ids || req.body?.force === true });
    bustBoard(d);
    return { read: n };
  }));
  app.post("/api/potential/:leadId", authed, route(async (req, d) => {
    const said = req.body?.said ?? null;
    if (said !== null && !["weekly", "monthly", "projects", "contract-elsewhere"].includes(said)) throw new BadRequest("said must be weekly, monthly, projects, contract-elsewhere or null");
    const potential = await recordRepSaid(d, String(req.params.leadId), said);
    bustBoard(d);
    return { potential };
  }));
  // The rescue call: the email is drafted in Close ahead of time; afterwards, the rep marks whether they found it.
  // Automatic emails: what's going out today and why, what went out, what was skipped or stopped.
  app.get("/api/automations", authed, route((_req, d) => automationsView(d)));
  // The call lists in Close, rebuilt from the board: talked before, no RFQ, by warmth, minus anyone called today (10/6).
  app.post("/api/dial-views/refresh", authed, route(async (_req, d) => ({ views: await syncDialViews(d) })));
  // "Got them" (10/6): the rep reached the person they were after; off today's lists right away.
  app.post("/api/leads/:leadId/reached", authed, route(async (req, d) => ({ reached: await markReachedByHand(d, leadId(req)) })));
  // The side panel's Emails tab: sent and queued automatic emails, with opens and replies since (10/6).
  app.get("/api/emails/sent", authed, route(async (req, d) => ({ emails: await sentEmailsView(d, Math.min(Number(req.query.days) || 7, 30)) })));
  app.post("/api/automations/toggle", authed, route((req, d) => setAutomations(d, req.body?.enabled === true)));
  app.post("/api/automations/test-mode", authed, route((req, d) => setTestMode(d, req.body?.on !== false)));
  app.post("/api/automations/plan", authed, route((_req, d) => planBumps(d, { force: true })));
  // An approved same-day send (10/2): named accounts, a couple of minutes apart; `test` goes to Test Lead Fabrication only.
  app.post("/api/automations/send-now", authed, route((req, d) => sendBumpsNow(d, {
    leadIds: Array.isArray(req.body?.lead_ids) ? req.body.lead_ids.map(String) : [],
    variant: typeof req.body?.variant === "string" ? req.body.variant : null,
    stagger: typeof req.body?.stagger === "number" ? req.body.stagger : 2,
    test: req.body?.test === true,
  })));
  // Cooling periods (10/6): out of the automatic emails for `days` (or for good), back in on their own after; `hold: false` puts them back now.
  app.post("/api/leads/:leadId/hold", authed, route((req, d) => holdAccount(d, leadId(req), req.body?.hold !== false, { days: Number(req.body?.days) || null, why: typeof req.body?.why === "string" ? req.body.why.slice(0, 200) : null })));
  app.get("/api/leads/:leadId/hold", authed, route(async (req, d) => ({ cooling: await coolingFor(d, leadId(req)) })));
  // Memes for the automatic bumps (9/30): the list (with which this lead has already had), and the pick for a lead's next bump.
  app.get("/api/memes", authed, route(async (req, d) => {
    const memes = await listMemes();
    const seen = typeof req.query.lead === "string" ? (await memesSeen(d)).get(req.query.lead) ?? new Set<string>() : new Set<string>();
    const counts = await memeCounts(d);
    const stats = await accountsBoard(d).then((b) => memeStats(d, b.accounts)).catch(() => ({} as MemeStats));
    return { memes: memes.map((m) => ({ ...m, seen: seen.has(m.name), sent: counts[m.name]?.sent ?? 0, queued: counts[m.name]?.queued ?? 0, stats: stats[m.name] ?? null })), folder: "server/memes", tracking: trackingOn() };
  }));
  // The meme library (Walt 10/5): upload an image or a zip of them, rename (every record follows), retire.
  app.post("/api/memes/upload", authed, express.raw({ type: () => true, limit: "26mb" }), route(async (req) => {
    const filename = typeof req.query.name === "string" ? req.query.name : "upload.zip";
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequest("Send the file as the request body.");
    return { added: await uploadMemes(filename, req.body) };
  }));
  app.post("/api/memes/rename", authed, route(async (req, d) => ({ name: await renameMeme(d.rep.closeUserId, z.string().min(1).max(200).parse(req.body?.from), z.string().min(1).max(200).parse(req.body?.to)) })));
  app.post("/api/memes/delete", authed, route(async (req) => { await deleteMeme(z.string().min(1).max(200).parse(req.body?.name)); return { ok: true }; }));
  app.post("/api/automations/meme", authed, route((req, d) => pickMeme(d, z.string().min(3).max(100).parse(req.body?.lead_id), req.body?.meme === null ? null : z.string().min(1).max(200).parse(req.body?.meme))));
  app.post("/api/automations/:id/skip", authed, route((req, d) => skipAutomation(d, z.string().min(3).max(100).parse(req.params.id))));
  // "Send line card now": the email is ready on the call screen; it goes out while they're on the phone.
  const LineCardReq = z.object({ to: z.string().max(200).optional().nullable(), name: z.string().max(80).optional().nullable(), referred_by: z.string().max(80).optional().nullable(), ask_for: z.string().max(120).optional().nullable(), buys: z.array(z.string().max(80)).max(12).optional(), cold: z.boolean().optional(), meme: z.string().max(200).nullable().optional(), format: z.enum(["standard", "full_text", "pdf_only", "vendor_row"]).optional().nullable() });
  // The meme picked in the side panel (10/2): a name from the memes folder, one this company hasn't had.
  const pickedMeme = async (d: Deps, lead: string, name: string | null | undefined) => {
    if (name === undefined) return undefined;
    if (name === null) return null;
    const m = (await listMemes({ sync: false })).find((x) => x.name === name);
    if (!m) throw new MemeError(`There's no meme called "${name}".`);
    if ((await memesSeen(d)).get(lead)?.has(name)) throw new MemeError("They've already had that meme. Pick another.");
    return m;
  };
  app.post("/api/leads/:leadId/linecard/preview", authed, route(async (req, d) => {
    const b = LineCardReq.parse(req.body ?? {});
    return lineCardFor(d, leadId(req), { to: b.to ?? null, name: b.name ?? null, referredBy: b.referred_by ?? null, askFor: b.ask_for ?? null, buys: b.buys, cold: b.cold, meme: await pickedMeme(d, leadId(req), b.meme), format: b.format ?? null });
  }));
  app.post("/api/leads/:leadId/linecard/send", authed, route(async (req, d) => {
    const b = LineCardReq.parse(req.body ?? {});
    return sendLineCard(d, leadId(req), { to: b.to ?? "", name: b.name ?? null, referredBy: b.referred_by ?? null, askFor: b.ask_for ?? null, buys: b.buys, cold: b.cold, meme: await pickedMeme(d, leadId(req), b.meme), format: b.format ?? null });
  }));
  // Checked a few times after a send, so a bounce shows on the call screen while they're still on the phone.
  app.get("/api/leads/:leadId/linecard/bounce", authed, route((req, d) =>
    lineCardBounce(d, leadId(req), z.string().email().max(200).parse(req.query.to), z.string().datetime({ offset: true }).parse(req.query.since))));
  // "They got it" ticked on the call screen: a [Got it] note in Close, which the automations read.
  app.post("/api/leads/:leadId/linecard/got-it", authed, route((req, d) => markRescue(d, leadId(req), true, typeof req.body?.name === "string" ? req.body.name.slice(0, 80) : null, "call")));
  // The call screen's "Say" text, as a note in Close, once per call (Walt 10/1).
  app.post("/api/leads/:leadId/said", authed, route((req, d) => saveSaid(d, leadId(req), z.string().min(5).max(1000).parse(req.body?.text), typeof req.body?.call_id === "string" ? req.body.call_id.slice(0, 100) : null)));
  // "RFQ came in" (another inbox, a call, a text): an [RFQ received] note in Close (Mitchell Concrete, 9/29).
  // The purchasing cycle (Walt 10/5): what's been heard on calls, the one question to ask next, and the rep's confirmed answers.
  app.get("/api/leads/:leadId/purchasing", authed, route(async (req, d) => {
    const id = leadId(req);
    const potential = potentialFor((await loadProfiles(d.rep.closeUserId))[id]);
    const pr = potential?.profile;
    return {
      heard: pr?.heard ?? null, ask: potential?.ask ?? askNext(null), tier: potential?.tier ?? "unknown",
      // What their site says they run, for the call card's at-a-glance line (Walt 10/6).
      site: pr && pr.type !== "unknown" ? { type: pr.type, makes: pr.makes, specs: pr.specs.slice(0, 4), certs: pr.certs.slice(0, 3) } : null,
    };
  }));
  app.post("/api/leads/:leadId/purchasing", authed, route(async (req, d) => {
    const id = leadId(req);
    const given: Partial<Record<Field, string | null>> = {}, quotes: Partial<Record<Field, string | null>> = {};
    for (const f of FIELDS) {
      const v = req.body?.answers?.[f];
      if (v === undefined) continue;
      if (v !== null && typeof v !== "string") throw new BadRequest(`${f} must be a string`);
      given[f] = v === null ? null : v.slice(0, 300);
      const q = req.body?.quotes?.[f];
      if (typeof q === "string") quotes[f] = q.slice(0, 300);
    }
    const prev = (await loadProfiles(d.rep.closeUserId))[id]?.heard ?? null;
    const potential = await recordPurchasing(d, id, confirmAnswers(prev, given, quotes, (d.now?.() ?? new Date()).toISOString()), { note: true, replace: true });
    bustBoard(d);
    return { heard: potential.profile.heard, ask: potential.ask, tier: potential.tier };
  }));
  app.post("/api/leads/:leadId/rfq-received", authed, route((req, d) => markRfqReceived(d, leadId(req), typeof req.body?.note === "string" ? req.body.note.slice(0, 200) : null)));
  // Where an RFQ stands, set by the rep ("With pricing · Berni has it"): a [RFQ status] note in Close.
  // "Shot down" from the side panel (Walt 10/5): Not Interested in Close, callbacks cleared, and out of the
  // automatic emails: a bump already scheduled is pulled back and the unsent rescue draft goes.
  app.post("/api/leads/:leadId/not-interested", authed, route(async (req, d) => {
    const id = leadId(req);
    if (req.body?.undo === true) return undoNotInterested(d, id, typeof req.body?.prev_status === "string" ? req.body.prev_status.slice(0, 80) : null);
    const r = await markNotInterested(d, id, typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null);
    await stopScheduledFor(d, id, "you marked them not interested.").catch((e) => console.error(`[shot down ${id}] scheduled bump:`, (e as Error).message));
    await dropRescueDraft(d, id).catch((e) => console.error(`[shot down ${id}] rescue draft:`, (e as Error).message));
    const queued = await queueShotDown(d, id, { call_id: typeof req.body?.call_id === "string" ? req.body.call_id.slice(0, 100) : null, note: typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null })
      .catch((e) => { console.error(`[shot down ${id}] review:`, (e as Error).message); return null; });
    return { ...r, queued };
  }));

  app.post("/api/leads/:leadId/rfq-status", authed, route((req, d) => {
    const b = z.object({ stage: z.enum(RFQ_STAGES), note: z.string().max(200).optional().nullable() }).parse(req.body ?? {});
    return setRfqStatus(d, leadId(req), b.stage, b.note?.trim() || null);
  }));
  app.get("/api/leads/:leadId/rescue", authed, route((req, d) => rescueFor(d, leadId(req))));
  app.post("/api/leads/:leadId/rescue/send", authed, route(async (req, d) => { const r = await sendRescue(d, leadId(req), z.string().min(3).max(100).parse(req.body?.draft_id)); await stopScheduledFor(d, leadId(req), "you sent the rescue draft yourself.").catch(() => null); return r; }));
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
    // "Great fit" (an A) on a lead nobody's worked yet: mark it "Good lead" in Close as you browse (Walt 9/29).
    if (brief.brief.rating === "A" && brief.header.status === "Potential") {
      const moved = await advanceStatus(d, id, "Good lead", "Potential").catch((e) => { console.error(`[good lead ${id}]`, (e as Error).message); return null; });
      if (moved) brief.header.status = moved;
    }
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
  // Another format for the line card email (10/7): recomposed, the transcript isn't read again.
  app.post("/api/queue/:id/linecard", authed, route(async (req, d) => setLineCardFormat(d, queueId(req), LineCardFormatRequest.parse(req.body).format)));
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
        // RFQ potential: sites never read, or read over a month ago, a few per pass, so the heat map stays current by itself.
        if (!config.demo) await accountsBoard(d).then((b) => refreshProfiles(d, b.accounts, { max: 6 })).then((n) => { if (n) bustBoard(d); })
          .catch((err) => console.error(`rfq potential ${rep.email}:`, (err as Error).message));
        // Anyone reached today (Close's calls) gets the mark, then the Close call lists follow the board minus them (10/6).
        if (!config.demo) await accountsBoard(d).then((b) => markReachedFromCalls(d, b.accounts)).catch((err) => console.error(`reached ${rep.email}:`, (err as Error).message));
        if (!config.demo) await syncDialViews(d).catch((err) => console.error(`dial views ${rep.email}:`, (err as Error).message));
        // Today's call list gets its briefs written ahead of the first call (10/6).
        if (!config.demo) await accountsBoard(d).then((b) => warmLeads(d, callListIds(b.accounts))).catch((err) => console.error(`warm ${rep.email}:`, (err as Error).message));
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
    else if (err instanceof RescueError || err instanceof ShotDownError) res.status(409).json({ error: err.message });
    else if (err instanceof LineCardError || err instanceof MemeError) res.status(409).json({ error: err.message });
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
