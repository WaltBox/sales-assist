import fs from "node:fs";
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
import { queueUntapped,
  advance, approveAll, approveItem, chatItem, countItems, discardItem, itemTranscript, listQueue, noteItem, QueueError, queueShotDown, quickOutcome, rebuildItem, rescheduleTask, reviewsForCall, setLineCardFormat, sweep, waitingFor,
} from "./queue.js";
import { checkPassword, COMPANY_DOMAIN, hashPassword, isCompanyEmail, issueSession, normalizeEmail, passwordProblem, readSession, recordTry, tooManyTries } from "./auth.js";
import { hashToken, hosted, SupabaseStore, store, type StoredRep } from "./store.js";
import { deleteMeme, memesFor, logLinkClick, logMemeEvent, memeCounts, MemeError, memeLanding, memesSeen, memeStats, memeUrl, pickMeme, renameMeme, trackingOn, uploadMemes, type MemeStats } from "./memes.js";
import { LineCardError, lineCardBounce, lineCardFor, sendLineCard } from "./linecard.js";
import { finishTask, tasksView, accountsBoard, cachedBoard, advanceStatus, bustBoard, ensureRescueDrafts, type Account, markNotInterested, markRescue, markRfqReceived, RescueError, rescueFor, RFQ_STAGES, sendRescue, setRfqStatus, ShotDownError, undoNotInterested } from "./accounts.js";
import { automationsView, setDailyCap, slowToday, coolingFor, sentEmailsView, dropRescueDraft, hijackAccount, holdAccount, morningRun, sequencesWith, planBumps, setAutomations, skipAutomation, syncAutomations, setTestMode, sendBumpsNow, setNextEmail, stopScheduledFor } from "./automations.js";
import { dayStats, mergeRfqTimelines, periodDetail, periodStats, rfqTimeline, weekStats } from "./stats.js";
import { rejections, speakAsDeep } from "./validate.js";
import { formatPhone } from "./rules.js";
import { myLeads } from "./myleads.js";
import { EXTENSION_ZIP, packedFiles, packedVersion } from "./extension.js";
import { guardSending, SendingError, sendingAccount, sendThrough } from "./sending.js";
import { FollowUpError, SITE_URL, writeFollowUp } from "./followup.js";
import { createGuest, fillFromClose, getList, GuestError, guestFollowUps, guestFor, guestSend, guestView, listCsv, listGuests, listSummary, markListLead, markListLeads, putList, setGuestActive, setGuestCc } from "./guests.js";
import { backfillPromiseQuotes } from "./heat.js";
import { NEW_CARD_SENDERS, newCardPlan, newCardMorning, newCardSummary, planNewCard, sendNewCard } from "./newcard.js";
import { postChat, raceLive, raceRoster, recordRfqTap, rfqScanDue, scanForRfqs, setRaceRoster, teamRace, withLiveLanes } from "./race.js";
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
  const jsonSmall = express.json({ limit: "256kb", verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; } });
  // A guest's call list upload can be a few thousand rows (10/15).
  const jsonList = express.json({ limit: "4mb" });
  // A call sheet is big (850 rows): the guest's own upload, or the rep uploading it for them (10/21).
  app.use((req, res, next) => (req.method === "POST" && /^\/api\/guests?\/[^/]+\/list$/.test(req.path) ? jsonList : jsonSmall)(req, res, next));
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
  // The line card and site links in a bump (10/12): logged as a click on the account, then on to the real thing.
  app.get("/l/:token/:kind", async (req, res) => {
    const kind = String(req.params.kind);
    if (kind !== "card" && kind !== "site") { res.status(404).end(); return; }
    await logLinkClick(String(req.params.token), kind, req.header("user-agent") ?? null).catch(() => null);
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    // The card is the current one kept here (10/27: the website's copy was the old one-pager).
    res.redirect(302, kind === "card" ? "/brand/westgate-line-card.pdf" : SITE_URL);
  });
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
    res.type("html").send(memeLanding({ name, url: memeUrl(name) }, t?.repName ?? "Westgate Supply", t?.repEmail ?? "sales@westgatesupply.com"));
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

  // Forgot password (10/19): prove it's you with your Close API key (only you can get it from Close), then pick a new
  // password. Nothing else about the account changes.
  app.post("/api/auth/reset", async (req, res, next) => {
    try {
      const body = Creds.parse(req.body);
      const email = companyEmail(body.email);
      if (tooManyTries(email)) throw new AuthError(429, "Too many tries. Wait 15 minutes and try again.");
      if (!(await repByEmail(email))) throw new AuthError(404, "There's no account for that email. Create one instead.");
      const bad = passwordProblem(body.password);
      if (bad) throw new AuthError(400, bad);
      const key = body.close_api_key?.trim();
      if (!key) throw new AuthError(400, "Paste your Close API key (Close, Settings, API Keys) so we know it's you.");
      const me = await appDeps.closeFor({ token: "reset", name: "", email, close_api_key: key, timezone: "America/Los_Angeles" }).me().catch(() => null);
      const ok = !!me && normalizeEmail(me.email) === email;
      recordTry(email, ok);
      if (!ok) throw new AuthError(401, me ? `That API key belongs to ${me.email}, not ${email}.` : "Close didn't accept that API key. Copy it from Close, Settings, API Keys.");
      const u = await store.getUser(email);
      await store.putUser({ email, passwordHash: await hashPassword(body.password), createdAt: u?.createdAt ?? new Date().toISOString(), lastLogin: u?.lastLogin ?? null });
      // A new key made for this (10/19) becomes the one the app uses, so the old one can be deleted in Close.
      const stored = await store.getRep(email);
      if (stored && stored.close_api_key !== key) {
        await store.putRep({ ...stored, close_api_key: key });
        for (const k of [...repInfoCache.keys()]) if (k === `email:${email}`) repInfoCache.delete(k);
      }
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
  type RepProfile = { phone?: string | null };
  const depsFor = async (rep: Rep): Promise<Deps> => {
    const close = appDeps.closeFor(rep);
    let info = repInfoCache.get(rep.token);
    if (!info) {
      const me = await close.me();
      const name = rep.name || `${me.first_name} ${me.last_name}`;
      // Emails go out only from the rep's own @westgatesupply.com account in Close (10/19). No other account is
      // ever picked: before, a rep without theirs connected fell back to whatever account Close had.
      const account = sendingAccount(me, rep.email || me.email, name);
      info = {
        name, email: rep.email || me.email, closeUserId: me.id, timeZone: rep.timezone || me.last_used_timezone || "America/Los_Angeles",
        sender: account?.sender ?? null,
        emailAccountId: account?.emailAccountId ?? null,
        // A phone saved in the app (Settings) wins over reps.json; reps who signed up have no other place for one.
        phone: (await store.getSetting<RepProfile>(me.id, "repProfile").catch(() => null))?.phone || rep.phone
          // Anyone after the first rep: their own Close line until they set one (the first rep's emails don't change).
          || (normalizeEmail(rep.email || me.email) === config.ownerEmail ? null
            : (await close.phoneNumbers().catch(() => [])).filter((p) => p.user_id === me.id).map((p) => formatPhone(p.number))[0] ?? null),
      };
      repInfoCache.set(rep.token, info);
    }
    // Every AI result reads as this rep, never as Walt (10/19: the playbook's examples are Walt's).
    const name = info.name;
    const llm = ((opts: Parameters<Llm>[0]) => appDeps.llm(opts).then((r) => ({ ...r, data: speakAsDeep(r.data, name) }))) as Llm;
    // The line card PDF lives on Walt's email template, which teammates can't see (10/21: a 404 for the Work Trial
    // login stopped every send). Anyone else reads it through the owner's account.
    if (normalizeEmail(info.email) !== config.ownerEmail) {
      const ownerRep = await repByEmail(config.ownerEmail).catch(() => null);
      const viaOwner = ownerRep && normalizeEmail(ownerRep.email) !== normalizeEmail(info.email) ? appDeps.closeFor(ownerRep) : null;
      if (viaOwner) {
        const mine = close.emailTemplateAttachments.bind(close);
        (close as { emailTemplateAttachments: typeof mine }).emailTemplateAttachments = (id: string) => mine(id).catch(() => viaOwner.emailTemplateAttachments(id));
      }
    }
    const own = info.sender && info.emailAccountId ? { sender: info.sender, emailAccountId: info.emailAccountId, email: info.email } : null;
    // No mailbox of their own, but set to send through a teammate (10/21: the Work Trial login sends from walt@).
    const viaEmail = !own ? config.sendVia[normalizeEmail(info.email)] : undefined;
    if (viaEmail && viaEmail !== normalizeEmail(info.email)) {
      const viaRep = await repByEmail(viaEmail);
      const via = viaRep ? await depsFor(viaRep).catch(() => null) : null;
      if (via && via.rep.emailAccountId) {
        return { close: sendThrough(close, via.close, info.name, via.rep.name), llm, rep: { ...info, sender: via.rep.sender, emailAccountId: via.rep.emailAccountId }, website: appDeps.website } satisfies Deps;
      }
    }
    return { close: guardSending(close, own, info.email), llm, rep: info, website: appDeps.website } satisfies Deps;
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

  // ---------- guest links (Walt 10/15): one page that sends line cards from the rep's account, nothing else ----------
  const repIdCache = new Map<string, { repId: string; rep: Rep }>();
  const guestFromToken = async (token: string) => {
    for (const rep of await allReps()) {
      let hit = repIdCache.get(rep.email);
      if (!hit) { const d = await depsFor(rep).catch(() => null); if (!d) continue; hit = { repId: d.rep.closeUserId, rep }; repIdCache.set(rep.email, hit); }
      const found = await guestFor(token, [hit.repId]);
      if (found) return { ...found, rep: hit.rep };
    }
    return null;
  };
  app.get("/g/:token", (_req, res) => res.sendFile(path.resolve(ROOT, "web", "guest.html")));
  app.get("/api/guest/:token", async (req, res, next) => {
    try {
      const g = await guestFromToken(String(req.params.token));
      if (!g) throw new GuestError(403, "This link isn't active. Ask whoever sent it to you for a new one.");
      res.json(guestView(g.guest));
    } catch (err) { next(err); }
  });
  app.post("/api/guest/:token/send", async (req, res, next) => {
    try {
      const g = await guestFromToken(String(req.params.token));
      if (!g) throw new GuestError(403, "This link isn't active. Ask whoever sent it to you for a new one.");
      const body = z.object({ company: z.string().max(200), name: z.string().max(100).nullable().optional(), email: z.string().max(200), meme: z.boolean().optional() }).parse(req.body ?? {});
      const d = await depsFor(g.rep);
      res.json(await guestSend(d, g.guest, body));
    } catch (err) { next(err); }
  });
  // The call list: the guest uploads their sheet, then marks each call.
  const guestRoute = (fn: (req: Request, g: NonNullable<Awaited<ReturnType<typeof guestFromToken>>>) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const g = await guestFromToken(String(req.params.token));
      if (!g) throw new GuestError(403, "This link isn't active. Ask whoever sent it to you for a new one.");
      res.json(await fn(req, g));
    } catch (err) { next(err); }
  };
  app.get("/api/guest/:token/list", guestRoute(async (_req, g) => ({ list: await getList(g.repId, g.guest.id) })));
  app.post("/api/guest/:token/list", guestRoute(async (req, g) => {
    const fill = await fillFromClose(await depsFor(g.rep), Array.isArray(req.body?.rows) ? req.body.rows : []);
    return { list: await putList(g.repId, g.guest, { name: typeof req.body?.name === "string" ? req.body.name : "", rows: fill.rows }), filled: fill.filled, notFound: fill.notFound };
  }));
  // Taps, batched by the page and sent one save at a time; Close notes go after the answer (10/15).
  const Mark = z.object({ i: z.number().int().min(0), outcome: z.string().max(40).nullable().optional(), notes: z.string().max(1000).nullable().optional(), email: z.string().max(200).nullable().optional(), gotName: z.string().max(200).nullable().optional() });
  app.post("/api/guest/:token/marks", guestRoute(async (req, g) => {
    const { marks } = z.object({ marks: z.array(Mark).max(200) }).parse(req.body ?? {});
    const d = await depsFor(g.rep);
    const r = await markListLeads(d, g.guest, marks);
    // Never re-saves the list (a second writer is what lost marks before); it only writes the notes.
    if (r.notes.length) background((async () => { for (const n of r.notes) await n().catch((e) => console.error("guest note:", (e as Error).message)); })(), "guest notes");
    return { called: r.called, total: r.total };
  }));
  // Their own email, CC'd on every line card they send (10/16).
  app.post("/api/guest/:token/cc", guestRoute(async (req, g) => setGuestCc(g.repId, g.guest.id, typeof req.body?.ccEmail === "string" ? req.body.ccEmail : null)));
  // Follow-ups (10/15): where the companies they called stand now in Close, line cards first.
  app.get("/api/guest/:token/followups", guestRoute(async (req, g) => guestFollowUps(await depsFor(g.rep), g.guest, { fresh: req.query.fresh === "1" })));
  app.post("/api/guest/:token/list/:i", guestRoute(async (req, g) => {
    const b = z.object({ outcome: z.string().max(40).nullable().optional(), notes: z.string().max(1000).nullable().optional(), email: z.string().max(200).nullable().optional(), gotName: z.string().max(200).nullable().optional() }).parse(req.body ?? {});
    return { lead: await markListLead(await depsFor(g.rep), g.guest, Number(req.params.i), b) };
  }));
  // The rep's side: make a link, switch it off or on, see what each guest sent.
  const guestLink = (req: Request, token: string) => `${(req.get("x-forwarded-proto") ?? req.protocol).split(",")[0]}://${req.get("host")}/g/${token}`;
  app.get("/api/guests", authed, route(async (_req, d) => ({ guests: await Promise.all((await listGuests(d.rep.closeUserId)).map(async ({ tokenHash: _h, ...g }) => ({ ...g, list: listSummary(await getList(d.rep.closeUserId, g.id)) }))) })));
  // Upload a guest's call list for them (10/21): the same as they would from their link; it replaces theirs.
  app.post("/api/guests/:id/list", authed, route(async (req, d) => {
    const guest = (await listGuests(d.rep.closeUserId)).find((g) => g.id === String(req.params.id));
    if (!guest) throw new GuestError(404, "No guest link with that id.");
    // A Close export has no phones: those are filled in from Close first (10/21).
    const fill = await fillFromClose(d, Array.isArray(req.body?.rows) ? req.body.rows : []);
    const list = await putList(d.rep.closeUserId, guest, { name: typeof req.body?.name === "string" ? req.body.name : "", rows: fill.rows });
    return { list: listSummary(list), filled: fill.filled, notFound: fill.notFound };
  }));
  app.get("/api/guests/:id/list.csv", authed, async (req, res, next) => {
    try {
      const d = res.locals.deps as Deps;
      const list = await getList(d.rep.closeUserId, String(req.params.id));
      if (!list) throw new GuestError(404, "That guest hasn't uploaded a list.");
      res.type("text/csv").setHeader("content-disposition", `attachment; filename="${list.name.replace(/[^\w .-]/g, "")}.csv"`);
      res.send(listCsv(list));
    } catch (err) { next(err); }
  });
  app.post("/api/guests", authed, route(async (req, d) => {
    const { guest, token } = await createGuest(d.rep.closeUserId, String(req.body?.name ?? ""));
    const { tokenHash: _h, ...g } = guest;
    return { guest: g, link: guestLink(req, token) };
  }));
  app.post("/api/guests/:id/active", authed, route(async (req, d) => {
    const { tokenHash: _h, ...g } = await setGuestActive(d.rep.closeUserId, String(req.params.id), req.body?.active !== false);
    return { guest: g };
  }));

  // The Chrome extension (10/19): the packed zip for signed-in reps, with its version for the setup page.
  app.get("/api/extension", authed, route(async () => ({ version: packedVersion(), server: config.publicUrl ?? null })));
  // What happened when someone clicked Update extension (10/26): logged so Walt doesn't have to relay screenshots.
  app.post("/api/extension/update-report", authed, route(async (req, d) => {
    const b = req.body ?? {};
    const clip = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
    console.log(`extension update [${d.rep.email}]: ${clip(b.outcome, 40)} | ${clip(b.detail)} | picker=${!!b.picker} secure=${!!b.secure} framed=${!!b.framed} installed=${clip(b.installed, 20)} | ${clip(b.ua, 200)} | ${clip(b.url, 120)}`);
    return { ok: true };
  }));
  app.get("/api/extension/files", authed, route(async () => {
    const out = packedFiles();
    if (!out) throw new GuestError(404, "The extension hasn't been packed yet. Run npm run pack-extension.");
    return out;
  }));
  app.get("/api/extension.zip", authed, (_req, res, next) => {
    if (!fs.existsSync(EXTENSION_ZIP)) { res.status(404).json({ error: "The extension hasn't been packed yet. Run npm run pack-extension." }); return; }
    res.type("application/zip").setHeader("content-disposition", 'attachment; filename="westgate-assistant-extension.zip"');
    res.sendFile(EXTENSION_ZIP, (err) => { if (err) next(err); });
  });
  // The extension from a guest link too (10/21), for a guest who has a Westgate login. An off or unknown link gets nothing.
  app.get("/api/guest/:token/extension", guestRoute(async () => ({ version: packedVersion() })));
  app.get("/api/guest/:token/extension.zip", async (req, res, next) => {
    try {
      if (!(await guestFromToken(String(req.params.token)))) throw new GuestError(403, "This link isn't active. Ask whoever sent it to you for a new one.");
      if (!fs.existsSync(EXTENSION_ZIP)) throw new GuestError(404, "The extension isn't available right now.");
      res.type("application/zip").setHeader("content-disposition", 'attachment; filename="westgate-assistant-extension.zip"');
      res.sendFile(EXTENSION_ZIP, (err) => { if (err) next(err); });
    } catch (err) { next(err); }
  });
  // My leads (10/19): every lead whose Lead owner in Close is you, with where each stands. For the extension.
  app.get("/api/my-leads", authed, route(async (req, d) => myLeads(d, { fresh: req.query.fresh === "1" })));
  // The team (10/19): the owner sees who's signed up and can reset a teammate's password. A reset removes only
  // the login; the rep, their Close key and their data stay, and the sign-in screen asks them for a new password.
  const ownerOnly = (d: Deps) => { if (normalizeEmail(d.rep.email) !== config.ownerEmail) throw new AuthError(403, "Only the account owner can do that."); };
  app.get("/api/team", authed, route(async (_req, d) => {
    ownerOnly(d);
    const reps = await allReps();
    return { reps: await Promise.all(reps.map(async (r) => {
      const u = await store.getUser(normalizeEmail(r.email)).catch(() => null);
      return { name: r.name, email: normalizeEmail(r.email), hasPassword: !!u, lastLogin: u?.lastLogin ?? null, you: normalizeEmail(r.email) === normalizeEmail(d.rep.email) };
    })) };
  }));
  // Team stats (10/19): each rep's numbers for a period, the same ones they see on their own home page. Owner only.
  app.get("/api/team/stats", authed, route(async (req, d) => {
    ownerOnly(d);
    const period = z.enum(["today", "week", "month", "all"]).parse(req.query.p ?? "week");
    const reps = await allReps();
    const rows = await Promise.all(reps.map(async (r) => {
      const email = normalizeEmail(r.email);
      try {
        const t = await depsFor(r);
        const [stats, line] = await Promise.all([
          periodStats(t, period),
          rfqTimeline(t, t.rep.closeUserId === d.rep.closeUserId ? {} : { savedOk: true }).catch(() => null),
        ]);
        return { email, name: t.rep.name, stats, rfqCompanies: line?.companies ?? null, error: null };
      } catch (e) {
        return { email, name: r.name, stats: null, rfqCompanies: null, error: (e as Error).message.slice(0, 160) };
      }
    }));
    return { period, reps: rows };
  }));
  // The BDR race (10/25): every rep on the roster, today's dials and points, the week, and today's RFQs to celebrate.
  // Everyone sees it; only the owner picks who's in it.
  // The live RFQ check runs every few seconds on every screen: whose settings to read is worked out once in a while.
  let liveOwner: { at: number; id: string; tz: string } | null = null;
  const liveOwnerInfo = async () => {
    if (!liveOwner || Date.now() - liveOwner.at > 10 * 60_000) {
      const team = (await Promise.all((await allReps()).map((r) => depsFor(r).catch(() => null)))).filter((x): x is Deps => !!x);
      const owner = team.find((t) => normalizeEmail(t.rep.email) === config.ownerEmail) ?? team[0];
      if (!owner) throw new GuestError(503, "West Game isn't available right now.");
      liveOwner = { at: Date.now(), id: owner.rep.closeUserId, tz: owner.rep.timeZone };
    }
    return liveOwner;
  };
  const raceTeam = async (d: Deps) => {
    const team = (await Promise.all((await allReps()).map((r) => depsFor(r).catch(() => null)))).filter((x): x is Deps => !!x);
    if (!team.some((t) => t.rep.closeUserId === d.rep.closeUserId)) team.unshift(d);
    const owner = team.find((t) => normalizeEmail(t.rep.email) === config.ownerEmail) ?? d;
    return { team, ownerId: owner.rep.closeUserId };
  };
  app.get("/api/race", authed, route(async (req, d) => {
    const { team, ownerId } = await raceTeam(d);
    const race = await withLiveLanes(await teamRace(team, ownerId), { ownerId });
    const isOwner = normalizeEmail(d.rep.email) === config.ownerEmail;
    return { ...race, you: normalizeEmail(d.rep.email), owner: isOwner, everyone: isOwner ? team.map((t) => ({ email: normalizeEmail(t.rep.email), name: t.rep.name })) : undefined };
  }));
  // Every live check, from anyone, can be the one that looks at new email (once every 30s for the whole team).
  const scanSoon = () => {
    void rfqScanDue().then((due) => {
      if (!due) return;
      background((async () => {
        const team = (await Promise.all((await allReps()).map((r) => depsFor(r).catch(() => null)))).filter((x): x is Deps => !!x);
        const owner = team.find((t) => normalizeEmail(t.rep.email) === config.ownerEmail) ?? team[0];
        if (!owner) return;
        const found = await scanForRfqs(team, owner.rep.closeUserId);
        if (found.length) await teamRace(team, owner.rep.closeUserId, { force: true });
      })(), "rfq email scan");
    }).catch(() => undefined);
  };
  app.get("/api/guest/:token/race/live", guestRoute(async () => {
    const o = await liveOwnerInfo();
    scanSoon();
    return raceLive(o.id, o.tz);
  }));
  // West Game on a guest's page (10/25): guests play while their link is on. Same shared copy the panels read.
  app.get("/api/guest/:token/race", guestRoute(async (req, g) => {
    const team = (await Promise.all((await allReps()).map((r) => depsFor(r).catch(() => null)))).filter((x): x is Deps => !!x);
    const owner = team.find((t) => normalizeEmail(t.rep.email) === config.ownerEmail) ?? team[0];
    if (!owner) throw new GuestError(503, "West Game isn't available right now.");
    const race = await withLiveLanes(await teamRace(team, owner.rep.closeUserId), { ownerId: owner.rep.closeUserId });
    return { ...race, you: `guest:${g.guest.id}`, owner: false, roster: { excluded: [] } };
  }));
  // The day's RFQs with the moment each one plays, read every few seconds by every screen so they celebrate together.
  app.get("/api/race/live", authed, route(async (_req, d) => {
    const o = await liveOwnerInfo();
    scanSoon();
    return raceLive(o.id, d.rep.timeZone);
  }));
  // The West Game chat: anyone playing can post; everyone sees it on their next live check.
  app.post("/api/race/chat", authed, route(async (req, d) => {
    const o = await liveOwnerInfo();
    return { chat: await postChat(o.id, d.rep.timeZone, { email: normalizeEmail(d.rep.email), name: d.rep.name }, z.string().max(1000).parse(req.body?.text)) };
  }));
  app.post("/api/guest/:token/race/chat", guestRoute(async (req, g) => {
    const o = await liveOwnerInfo();
    return { chat: await postChat(o.id, o.tz, { email: `guest:${g.guest.id}`, name: g.guest.name }, z.string().max(1000).parse(req.body?.text)) };
  }));
  // Who's in West Game, for the web app's Team page (Walt 10/25: "in the application, not the Chrome extension").
  app.get("/api/race/roster", authed, route(async (_req, d) => {
    ownerOnly(d);
    const { ownerId } = await raceTeam(d);
    return raceRoster(ownerId);
  }));
  app.post("/api/race/roster", authed, route(async (req, d) => {
    ownerOnly(d);
    const email = normalizeEmail(z.string().max(200).parse(req.body?.email));
    const racing = z.boolean().parse(req.body?.racing);
    const { ownerId } = await raceTeam(d);
    return setRaceRoster(ownerId, email, racing);
  }));
  app.post("/api/team/reset-password", authed, route(async (req, d) => {
    ownerOnly(d);
    const email = normalizeEmail(z.string().max(200).parse(req.body?.email));
    if (email === normalizeEmail(d.rep.email)) throw new AuthError(400, "That's you. Sign out and use your own password, or ask for help.");
    if (!(await repByEmail(email))) throw new AuthError(404, "There's no rep with that email.");
    await store.deleteUser(email);
    return { email, reset: true };
  }));
  // A new Close API key (Walt 10/25): when the old one stops working, paste a new one from Close without a new account.
  app.post("/api/me/close-key", authed, route(async (req, d) => {
    const key = z.string().min(10).max(200).parse(String(req.body?.close_api_key ?? "").trim());
    const email = normalizeEmail(d.rep.email);
    const me = await appDeps.closeFor({ token: "rekey", name: "", email, close_api_key: key, timezone: "America/Los_Angeles" }).me().catch(() => null);
    if (!me) throw new BadRequest("Close didn't accept that API key. Copy it from Close, Settings, API Keys.");
    if (normalizeEmail(me.email) !== email) throw new BadRequest(`That API key belongs to ${me.email}, not ${email}.`);
    if ([...appDeps.reps.values()].some((r) => normalizeEmail(r.email) === email)) throw new BadRequest("Your Close key is set in the server's reps file. Ask Walt to change it there.");
    const stored = await store.getRep(email);
    await store.putRep({ ...(stored ?? { email, name: `${me.first_name} ${me.last_name}`.trim() || email, timezone: me.last_used_timezone ?? null }), close_api_key: key });
    for (const k of [...repInfoCache.keys()]) if (k === `email:${email}`) repInfoCache.delete(k);
    for (const [k, v] of tokenReps) if (v.rep && normalizeEmail(v.rep.email) === email) tokenReps.delete(k);
    return { ok: true, name: `${me.first_name} ${me.last_name}`.trim() };
  }));
  // The rep's own settings (10/19): the phone number that goes in their emails.
  app.post("/api/me/profile", authed, route(async (req, d) => {
    const raw = z.string().max(40).nullable().parse(req.body?.phone ?? null);
    const digits = (raw ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (raw && digits.length !== 10) throw new BadRequest("That doesn't look like a 10-digit phone number.");
    const phone = digits ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : null;
    await store.putSetting(d.rep.closeUserId, "repProfile", { phone });
    for (const [k, v] of repInfoCache) if (v.closeUserId === d.rep.closeUserId) repInfoCache.delete(k);
    return { phone };
  }));
  app.get("/api/me", authed, route(async (_req, d) => ({
    rep: d.rep,
    owner: normalizeEmail(d.rep.email) === config.ownerEmail,
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
  // The team's RFQs (10/19): every rep's RFQ accounts and RFQ line, merged, each tagged with whose it is.
  // Everything else in the app stays per rep.
  app.get("/api/team/rfqs", authed, route(async (req, d) => {
    const fresh = req.query.fresh === "1";
    const team = (await Promise.all((await allReps()).map((r) => depsFor(r).catch(() => null)))).filter((x): x is Deps => !!x);
    if (!team.some((t) => t.rep.closeUserId === d.rep.closeUserId)) team.unshift(d);
    const parts = await Promise.all(team.map(async (t) => {
      const mine = t.rep.closeUserId === d.rep.closeUserId;
      // Yours as usual; a teammate's from what's saved, so their numbers never hold up your page.
      const [line, board] = await Promise.all([
        rfqTimeline(t, mine ? { fresh } : { savedOk: true }).catch(() => null),
        (mine ? accountsBoard(t) : cachedBoard(t)).catch(() => null),
      ]);
      return { rep: t.rep.name, mine, line, accounts: (board?.accounts ?? []).filter((a) => a.rfq) };
    }));
    const accounts = new Map<string, Account & { reps: string[] }>();
    for (const p of parts) for (const a of p.accounts) {
      const have = accounts.get(a.leadId);
      if (have) { if (!have.reps.includes(p.rep)) have.reps.push(p.rep); } else accounts.set(a.leadId, { ...a, reps: [p.rep] });
    }
    const lines = parts.filter((p) => p.line).map((p) => ({ rep: p.rep, line: p.line! }));
    return { reps: parts.map((p) => p.rep), line: lines.length ? mergeRfqTimelines(lines, d.rep.timeZone, d.now?.() ?? new Date()) : null, accounts: [...accounts.values()] };
  }));
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
  // Slow down (10/19): a lower daily limit. dry_run says how many of today's queued emails it would pull back.
  app.post("/api/automations/pace", authed, route(async (req, d) => {
    const cap = z.number().int().parse(req.body?.daily_cap);
    if (req.body?.dry_run === true) return slowToday(d, cap, { dryRun: true });
    const set = await setDailyCap(d, cap);
    const today = req.body?.pull_back_today === true ? await slowToday(d, cap) : null;
    return { ...set, today };
  }));
  app.post("/api/automations/test-mode", authed, route((req, d) => setTestMode(d, req.body?.on !== false)));
  app.post("/api/automations/plan", authed, route((_req, d) => planBumps(d, { force: true })));
  // An approved same-day send (10/2): named accounts, a couple of minutes apart; `test` goes to Test Lead Fabrication only.
  // "New line card!" (10/28): the owner plans the wave once; each rep's share goes out on their mornings, or now.
  app.get("/api/automations/new-card", authed, route(async (_req, d) => {
    const plan = await newCardPlan();
    return { summary: newCardSummary(plan), mine: plan ? plan.leads.filter((l) => l.repId === d.rep.closeUserId && !plan.done[l.leadId]).length : 0, owner: normalizeEmail(d.rep.email) === config.ownerEmail, senders: NEW_CARD_SENDERS };
  }));
  app.post("/api/automations/new-card/plan", authed, route(async (_req, d) => {
    if (normalizeEmail(d.rep.email) !== config.ownerEmail) throw new GuestError(403, "Only the owner plans this.");
    const team = (await Promise.all((await allReps()).map((r) => depsFor(r).catch(() => null)))).filter((x): x is Deps => !!x);
    const senders = team.filter((t) => NEW_CARD_SENDERS.includes(normalizeEmail(t.rep.email)));
    return { summary: newCardSummary(await planNewCard(d, senders)) };
  }));
  app.post("/api/automations/new-card/send-now", authed, route((req, d) => sendNewCard(d, { max: Number(req.body?.max) || undefined })));
  app.post("/api/automations/send-now", authed, route((req, d) => sendBumpsNow(d, {
    leadIds: Array.isArray(req.body?.lead_ids) ? req.body.lead_ids.map(String) : [],
    variant: typeof req.body?.variant === "string" ? req.body.variant : null,
    stagger: typeof req.body?.stagger === "number" ? req.body.stagger : 2,
    test: req.body?.test === true,
  })));
  // Cooling periods (10/6): out of the automatic emails for `days` (or for good), back in on their own after; `hold: false` puts them back now.
  app.post("/api/leads/:leadId/hold", authed, route((req, d) => holdAccount(d, leadId(req), req.body?.hold !== false, { days: Number(req.body?.days) || null, why: typeof req.body?.why === "string" ? req.body.why.slice(0, 200) : null })));
  // The Tasks tab (10/14): open Close tasks, today, this week, overdue; Done marks one complete in Close.
  app.get("/api/tasks", authed, route((_req, d) => tasksView(d)));
  app.post("/api/tasks/:taskId/done", authed, route((req, d) => finishTask(d, String(req.params.taskId))));
  // "Next email in…" on the call screen (10/12): when the email sequence starts again after this call.
  app.post("/api/leads/:leadId/next-email", authed, route((req, d) => setNextEmail(d, leadId(req), Number(req.body?.days) || 3)));
  // The whole email thread for the heat map drawer (10/14): both ways, newest first, with their own words split from
  // the quoted history so it reads like a conversation.
  app.get("/api/leads/:leadId/emails", authed, route(async (req, d) => {
    const emails = await d.close.leadEmails(leadId(req));
    const at = (e: (typeof emails)[number]) => e.date_sent ?? e.date_created ?? "";
    const split = (body: string) => {
      const i = body.search(/\n\s*On .{5,160}wrote:|\n-{2,}\s*Original Message|\nFrom: .+\n(Sent|Date): |\n_{5,}|\n>/i);
      return i > 0 ? { own: body.slice(0, i).trim(), quoted: body.slice(i).trim() } : { own: body.trim(), quoted: "" };
    };
    return {
      emails: emails.filter((e) => ["sent", "inbox", "scheduled", "outbox"].includes(e.status)).sort((a, b) => at(b).localeCompare(at(a))).map((e) => ({
        id: e.id, direction: e.direction, status: e.status, at: at(e), subject: e.subject, from: e.sender ?? null, to: e.to ?? [],
        files: (e.attachments ?? []).map((f) => f.filename).filter((f): f is string => !!f && !/^image\d*\.(png|jpe?g|gif)$/i.test(f)),
        opens: (e.opens ?? []).length, ...split(e.body_text ?? ""),
      })),
    };
  }));
  // Teammates to hijack from (10/28): whose automatic emails this account is in, besides your own.
  const teammates = async (d: Deps) => (await Promise.all((await allReps()).map((r) => depsFor(r).catch(() => null))))
    .filter((x): x is Deps => !!x && x.rep.closeUserId !== d.rep.closeUserId);
  app.get("/api/leads/:leadId/hold", authed, route(async (req, d) => ({
    cooling: await coolingFor(d, leadId(req)),
    sequences: await sequencesWith(await teammates(d), leadId(req)).catch(() => []),
  })));
  app.post("/api/leads/:leadId/hijack", authed, route(async (req, d) => hijackAccount(await teammates(d), d, leadId(req))));
  // Memes for the automatic bumps (9/30): the list (with which this lead has already had), and the pick for a lead's next bump.
  app.get("/api/memes", authed, route(async (req, d) => {
    const memes = await memesFor(d);
    const seen = typeof req.query.lead === "string" ? (await memesSeen(d)).get(req.query.lead) ?? new Set<string>() : new Set<string>();
    const counts = await memeCounts(d);
    const stats = await accountsBoard(d).then((b) => memeStats(d, b.accounts)).catch(() => ({} as MemeStats));
    return { memes: memes.map((m) => ({ ...m, seen: seen.has(m.name), sent: counts[m.name]?.sent ?? 0, queued: counts[m.name]?.queued ?? 0, stats: stats[m.name] ?? null })), folder: "server/memes", tracking: trackingOn() };
  }));
  // The meme library (Walt 10/5): upload an image or a zip of them, rename (every record follows), retire.
  app.post("/api/memes/upload", authed, express.raw({ type: () => true, limit: "26mb" }), route(async (req, d) => {
    const filename = typeof req.query.name === "string" ? req.query.name : "upload.zip";
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequest("Send the file as the request body.");
    return { added: await uploadMemes(d, filename, req.body) };
  }));
  app.post("/api/memes/rename", authed, route(async (req, d) => ({ name: await renameMeme(d, z.string().min(1).max(200).parse(req.body?.from), z.string().min(1).max(200).parse(req.body?.to)) })));
  app.post("/api/memes/delete", authed, route(async (req, d) => { await deleteMeme(d, z.string().min(1).max(200).parse(req.body?.name)); return { ok: true }; }));
  app.post("/api/automations/meme", authed, route((req, d) => pickMeme(d, z.string().min(3).max(100).parse(req.body?.lead_id), req.body?.meme === null ? null : z.string().min(1).max(200).parse(req.body?.meme))));
  app.post("/api/automations/:id/skip", authed, route((req, d) => skipAutomation(d, z.string().min(3).max(100).parse(req.params.id))));
  // "Send line card now": the email is ready on the call screen; it goes out while they're on the phone.
  const LineCardReq = z.object({ to: z.string().max(200).optional().nullable(), name: z.string().max(80).optional().nullable(), referred_by: z.string().max(80).optional().nullable(), ask_for: z.string().max(120).optional().nullable(), buys: z.array(z.string().max(80)).max(12).optional(), cold: z.boolean().optional(), meme: z.string().max(200).nullable().optional(), format: z.enum(["standard", "full_text", "pdf_only", "vendor_row"]).optional().nullable() });
  // The meme picked in the side panel (10/2): a name from the memes folder, one this company hasn't had.
  const pickedMeme = async (d: Deps, lead: string, name: string | null | undefined) => {
    if (name === undefined) return undefined;
    if (name === null) return null;
    const m = (await memesFor(d, { sync: false })).find((x) => x.name === name);
    if (!m) throw new MemeError(`You don't have a meme called "${name}".`);
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
    // "PMs / subs buy" (Walt 10/7): the lead's status in Close becomes his "project managers" status, so it's tracked there too.
    let status: string | null = null;
    if (given.works_through === "PM" || given.works_through === "sub") {
      const pm = (await d.close.leadStatuses().catch(() => [])).find((x) => /project manager/i.test(x.label));
      if (pm) { await d.close.updateLeadStatus(id, pm.id).catch(() => undefined); status = pm.label; }
    }
    bustBoard(d);
    return { heard: potential.profile.heard, ask: potential.ask, tier: potential.tier, status };
  }));
  app.post("/api/leads/:leadId/rfq-received", authed, route(async (req, d) => {
    const id = leadId(req);
    // West Game counts it now and every screen celebrates it together (10/26), without waiting on the next Close read.
    // The tap is saved first, alongside the Close writes rather than after them (10/27: "takes at least 30 seconds").
    const tapping = (async () => {
      const { team, ownerId } = await raceTeam(d);
      const tap = await recordRfqTap(team, ownerId, d, id);
      background(teamRace(team, ownerId, { force: true }).then(() => undefined), "race after RFQ tap");
      return tap;
    })().catch((e) => { console.error(`[rfq tap ${id}]`, (e as Error).message); return null; });
    const [r, tap] = await Promise.all([markRfqReceived(d, id, typeof req.body?.note === "string" ? req.body.note.slice(0, 200) : null), tapping]);
    // The tapper's screen plays it the moment this comes back; everyone else's on the live check.
    return { ...r, race: tap?.first ? { id: tap.id, email: tap.email, name: tap.name, company: tap.company, first: true, day: tap.day } : null };
  }));
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
  app.get("/api/email-rejections", authed, route(async (req, d) => await rejections(Math.min(Number(req.query.limit) || 100, 500), d.rep)));

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
  let lastUntapped = 0;
  const rfqLineAt = new Map<string, number>();
  const catchUp = async () => {
    // Automatic emails: plan the morning's bumps, and re-check the ones about to go (every few minutes).
    if (Date.now() - lastAutoCheck > 3 * 60_000) {
      lastAutoCheck = Date.now();
      for (const rep of await allReps().catch(() => [])) {
        const d = await depsFor(rep).catch(() => null);
        if (!d) continue;
        // Only the hosted server plans the morning (10/8: the Mac copy planned too, 90 seconds after it, and 80 leads
        // got two emails). PLAN_MORNING=1 turns it on for a copy that runs alone.
        if (process.env.VERCEL || process.env.PLAN_MORNING === "1") {
          // The "New line card!" wave first (10/28): it takes the morning's slots, and the sequence fills in behind it.
          await newCardMorning(d).catch((err) => console.error(`new card ${rep.email}:`, (err as Error).message));
          await morningRun(d).catch((err) => console.error(`morning run ${rep.email}:`, (err as Error).message));
        }
        await ensureRescueDrafts(d).catch((err) => console.error(`rescue drafts ${rep.email}:`, (err as Error).message));
        await syncAutomations(d).catch((err) => console.error(`sync ${rep.email}:`, (err as Error).message));
        // RFQ potential: sites never read, or read over a month ago, a few per pass, so the heat map stays current by itself.
        if (!config.demo) await accountsBoard(d).then((b) => refreshProfiles(d, b.accounts, { max: 6 })).then((n) => { if (n) bustBoard(d); })
          .catch((err) => console.error(`rfq potential ${rep.email}:`, (err as Error).message));
        // Anyone reached today (Close's calls) gets the mark, then the Close call lists follow the board minus them (10/6).
        if (!config.demo) await accountsBoard(d).then((b) => markReachedFromCalls(d, b.accounts)).catch((err) => console.error(`reached ${rep.email}:`, (err as Error).message));
        if (!config.demo) await syncDialViews(d).catch((err) => console.error(`dial views ${rep.email}:`, (err as Error).message));
        // The RFQ count stays current on its own (10/9), so the page never waits on a 17-second rebuild.
        if (!config.demo && Date.now() - (rfqLineAt.get(rep.email) ?? 0) > 8 * 60_000) {
          rfqLineAt.set(rep.email, Date.now());
          await rfqTimeline(d, { fresh: true }).catch((err) => console.error(`rfq line ${rep.email}:`, (err as Error).message));
        }
        // Their words for promises made before the quote was saved, a few a pass (10/14).
        if (!config.demo) await accountsBoard(d).then((b) => backfillPromiseQuotes(d, b.accounts)).then((n) => { if (n) bustBoard(d); })
          .catch((err) => console.error(`promise quotes ${rep.email}:`, (err as Error).message));
        // Today's call list gets its briefs written ahead of the first call (10/6).
        if (!config.demo) await accountsBoard(d).then((b) => warmLeads(d, callListIds(b.accounts))).catch((err) => console.error(`warm ${rep.email}:`, (err as Error).message));
      }
    }
    // Calls nobody tapped a result for, every 10 minutes (10/14).
    if (Date.now() - lastUntapped > 10 * 60_000) {
      lastUntapped = Date.now();
      for (const rep of await allReps().catch(() => [])) {
        const d = await depsFor(rep).catch(() => null);
        if (d && !config.demo) await queueUntapped(d).then((n) => { if (n) console.info(`[untapped] ${rep.email}: reading ${n} call(s) with no result tapped`); })
          .catch((err) => console.error(`untapped ${rep.email}:`, (err as Error).message));
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
    else if (err instanceof GuestError) res.status(err.status).json({ error: err.message });
    else if (err instanceof AuthError) res.status(err.status).json({ error: err.message, ...(err.status === 428 ? { needsCloseKey: true } : {}) });
    else if (err instanceof z.ZodError) res.status(400).json({ error: "Bad request", details: z.prettifyError(err) });
    else if (err instanceof DuplicateApplyError) res.status(409).json({ error: err.message });
    else if (err instanceof SendingError) res.status(409).json({ error: err.message });
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
