// Westgate Assistant web app: one status per account. The side panel is for
// the call itself; this page is for what happens around it: every account
// you've sent the line card to, what's happened since, and what to do next.
// All data comes from the server, which reads Close; nothing here is stored
// except your sign-in.

const $app = document.getElementById("app");
const TOKEN_KEY = "westgate.token";
let token = (() => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } })();

const state = {
  me: null, today: null, board: null, autos: null,
  open: {}, followUps: {}, gotIt: {}, showSect: {}, error: null,
  mailTab: "upcoming", mailOpen: {}, mailBusy: false,
  page: pageFromHash(),
  rfqEdit: {}, // leadId -> { stage, note, busy, error }
  heatPick: null, // leadId whose breakdown is open on the heat map
  heatOnly: null, // a bucket to show alone on the heat map, or null for all
  heatCard: null, // line-card filter on the heat map: "opened" | "landed" | "bounced" | null
  heatPot: null, // RFQ-potential filter on the heat map: "steady" | "project" | "occasional" | "unknown" | null
  heatFresh: {}, // heat map bands showing the accounts touched in the last two business days (hidden by default, Walt 10/7)
  memeNow: {}, // per lead: a one-off meme email fired from the drawer or the accounts page (Walt 10/7)
  heatPms: false, // heat map: only accounts where the PMs or subs order their own materials (Walt 10/7)
  heatToday: null, // what's happened today on the heat map: "none" | "emailed" | "called" | "reached" | "wrote" | null
  heatQ: "", // search on the heat map: company, contact, email
  acctQ: "", // search on the accounts page
  cool: {}, // leadId -> cooling state for the drawer ({ until, why } | null | "loading")
  potBusy: false, // reading sites / saving an answer
  potOpen: {}, // leadId -> the "why" behind the potential is open in the drawer
  lib: null, // the meme library: { memes, busy, msg, rename: { name, value } }
  period: (() => { try { return localStorage.getItem("westgate.period") || "today"; } catch { return "today"; } })(),
  periods: {}, // period -> stats (loaded when picked)
  drill: null, // the stat whose rows are showing, e.g. "dials"
  details: {}, // `${period}:${metric}` -> table
};

function pageFromHash() { return location.hash === "#emails" ? "emails" : location.hash === "#rfqs" ? "rfqs" : location.hash === "#heat" ? "heat" : "accounts"; }

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(kids).flat(Infinity)) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(); throw new Error("Signed out"); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

const closeLead = (id) => `https://app.close.com/lead/${id}/`;
const daysAgo = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
const ago = (iso) => { const n = daysAgo(iso); return n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`; };
const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const prettyPhone = (p) => { const d = String(p || "").replace(/\D/g, "").slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };
const personOf = (addr) => { const m = String(addr || "").match(/^\s*"?([^"<]+?)"?\s*</); if (m) return m[1]; const n = String(addr || "").split("@")[0].split(/[._-]/)[0]; return n ? n[0].toUpperCase() + n.slice(1) : ""; };

// ---------- load ----------

// A call that dies on a cold hosted instance (a bare 502, 10/7) is tried again before it counts as failed.
async function apiRetry(path, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await api(path); }
    catch (e) { if (i >= tries || e.message === "Signed out" || !/Error 50\d|502|503|504/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 1500 * i)); }
  }
}
async function load(fresh = false) {
  state.error = null;
  render();
  // The board first, on its own, so the pages draw even if a stats call hiccups; then the rest together.
  const me = await apiRetry("/api/me").catch((e) => { if (e.message !== "Signed out") state.error = e.message; return null; });
  const board = await apiRetry(`/api/accounts${fresh ? "?fresh=1" : ""}`).catch((e) => { if (e.message !== "Signed out") state.error = e.message; return null; });
  Object.assign(state, { me, board });
  render();
  const results = await Promise.allSettled([apiRetry("/api/stats/today"), apiRetry("/api/automations"), apiRetry(`/api/stats/rfqs${fresh ? "?fresh=1" : ""}`)]);
  const [today, autos, rfqLine] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
  Object.assign(state, { today, autos, rfqLine });
  const failed = results.find((r) => r.status === "rejected");
  if (failed && failed.reason.message !== "Signed out" && !state.error) state.error = failed.reason.message;
  render();
}

function signOut() {
  token = "";
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  render();
}

// ---------- views ----------

function render() {
  if (!token) return $app.replaceChildren(signIn());
  const err = state.error ? el("p", { class: "empty", text: `Couldn't load everything: ${state.error}` }) : null;
  $app.replaceChildren(topBar(), el("main", {}, state.page === "emails" ? [err, emailsSection()]
    : state.page === "rfqs" ? [err, rfqsPage()]
      : state.page === "heat" ? [err, heatPage()]
        : [hello(), err, accountsSection()]));
}

// Sign in with your @westgatesupply.com email. First time: create a password
// (and, if you're new to the assistant, connect your Close API key).
const auth = { step: "email", email: "", needsCloseKey: false, error: "", busy: false };

async function authPost(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { data });
  return data;
}

function signIn() {
  const f = {};
  const run = async (fn) => {
    auth.busy = true; auth.error = ""; render();
    try { await fn(); } catch (e) {
      auth.error = e.message;
      if (e.data && e.data.needsCloseKey) auth.needsCloseKey = true;
    }
    auth.busy = false; render();
  };
  const done = (r) => {
    token = r.token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
    Object.assign(auth, { step: "email", error: "" });
    load();
  };
  const next = () => run(async () => {
    if (auth.step === "email") {
      auth.email = f.email.value.trim();
      const r = await authPost("/api/auth/check", { email: f.email.value });
      Object.assign(auth, { email: r.email, step: r.hasAccount ? "password" : "create", needsCloseKey: r.needsCloseKey });
    } else if (auth.step === "password") {
      done(await authPost("/api/auth/login", { email: auth.email, password: f.password.value }));
    } else {
      if (f.password.value !== f.confirm.value) throw new Error("Those passwords don't match.");
      done(await authPost("/api/auth/signup", { email: auth.email, password: f.password.value, close_api_key: f.key ? f.key.value : undefined }));
    }
  });
  const enter = (e) => { if (e.key === "Enter") next(); };
  const field = (name, attrs) => (f[name] = el("input", { ...attrs, onkeydown: enter }));
  const title = { email: "Sign in", password: "Welcome back", create: auth.needsCloseKey ? "Create your account" : "Set your password" }[auth.step];
  const intro = {
    email: "Use your Westgate email.",
    password: auth.email,
    create: auth.needsCloseKey
      ? `${auth.email} isn't connected to Close yet. Pick a password and paste your Close API key (Close → Settings → API Keys). It stays on the server.`
      : `First time here: pick a password for ${auth.email}.`,
  }[auth.step];
  const form = el("div", { class: "signin x3d" }, [
    el("img", { src: "brand/world-mark-filled.svg", alt: "", style: "height:28px;width:auto;align-self:flex-start" }),
    el("h1", { text: title }),
    el("p", { class: "muted", text: intro }),
    auth.step === "email" ? field("email", { type: "email", placeholder: "you@westgatesupply.com", autocomplete: "username", value: auth.email }) : null,
    auth.step !== "email" ? field("password", { type: "password", placeholder: auth.step === "create" ? "New password (10+ characters)" : "Password", autocomplete: auth.step === "create" ? "new-password" : "current-password" }) : null,
    auth.step === "create" ? field("confirm", { type: "password", placeholder: "Same password again", autocomplete: "new-password" }) : null,
    auth.step === "create" && auth.needsCloseKey ? field("key", { type: "password", placeholder: "Close API key", autocomplete: "off" }) : null,
    auth.error ? el("p", { class: "err", text: auth.error }) : null,
    el("button", { class: "btn primary", disabled: auth.busy, text: auth.busy ? "One sec…" : { email: "Continue", password: "Sign in", create: "Create account" }[auth.step], onclick: next }),
    auth.step !== "email" ? el("button", { class: "linkbtn", style: "align-self:flex-start", text: "Use a different email", onclick: () => { Object.assign(auth, { step: "email", error: "" }); render(); } }) : null,
  ]);
  setTimeout(() => (f.email || f.password)?.focus(), 0);
  return form;
}


function topBar() {
  const line = state.me && state.me.lines && state.me.lines[0];
  return el("header", { class: "top" }, el("div", { class: "in" }, [
    el("div", { class: "brand" }, [el("img", { src: "brand/world-mark-filled.svg", alt: "" }), "Westgate", el("span", { class: "sub", text: "Assistant" })]),
    el("nav", { class: "nav" }, [["accounts", "Accounts"], ["heat", "Heat map"], ["rfqs", "RFQs"], ["emails", "Automatic emails"]].map(([k, label]) => el("button", {
      class: state.page === k ? "on" : "", onclick: () => go(k),
    }, [label,
      k === "emails" && state.autos ? el("span", { class: "navc mono", text: mailRows(state.autos, "upcoming").length }) : null,
      k === "rfqs" && state.board ? el("span", { class: "navc mono", text: state.board.accounts.filter((a) => a.rfq).length }) : null,
      k === "heat" && state.board ? el("span", { class: "navc mono hotc", text: state.board.accounts.filter((a) => !a.rfq && !HAS_RFQ_STATUS.test(a.status || "") && a.warmth && a.warmth.bucket === "hot").length }) : null,
    ]))),
    el("div", { class: "who" }, [
      line ? el("button", {
        class: "myline", title: "Copy your Close number",
        onclick: (e) => { navigator.clipboard?.writeText(line); e.currentTarget.lastChild.textContent = "Copied"; setTimeout(render, 1200); },
      }, [el("span", { class: "k", text: "My line" }), el("span", { text: prettyPhone(line) })]) : null,
      state.me ? el("span", { text: state.me.rep.name }) : null,
      el("button", { class: "linkbtn", text: "Sign out", onclick: signOut }),
    ]),
  ]));
}

function go(page) {
  state.page = page;
  history.replaceState(null, "", page === "accounts" ? "#" : `#${page}`);
  window.scrollTo(0, 0);
  render();
}
window.addEventListener("hashchange", () => { state.page = pageFromHash(); render(); });

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"; };
const NOW_KINDS = ["reply", "quote", "call_due", "rescue", "bump"];

function hello() {
  const name = state.me ? state.me.rep.name.split(" ")[0] : "";
  const c = state.board && state.board.counts;
  const sec = state.board && state.board.sections;
  const now = sec ? SECTIONS.filter(([k]) => !["later", "today", "rest"].includes(k)).reduce((n, [k]) => n + (sec[k] || 0), 0) : c ? NOW_KINDS.reduce((n, k) => n + c[k], 0) : null;
  return [el("div", { class: "hello" }, [
    el("div", {}, [
      el("h1", {}, [`${greeting()}${name ? `, ${name}` : ""}.`, el("br"), el("em", { text: now ? `${now} account${now === 1 ? "" : "s"} need${now === 1 ? "s" : ""} you.` : c ? "You're clear." : "Loading…" })]),
    ]),
    el("button", { class: "btn", text: "Refresh", onclick: () => { state.periods = {}; state.details = {}; load(true); } }),
  ]), statsBar()];
}

// ---------- today / this week / this month / all time ----------

const PERIODS = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["all", "All time"]];

async function loadPeriod(p, fresh = false) {
  if (state.periods[p] && !fresh) return;
  state.periods[p] = state.periods[p] || { loading: true };
  render();
  try {
    state.periods[p] = await api(`/api/stats/period?p=${p}${fresh ? "&fresh=1" : ""}`);
  } catch (e) {
    state.periods[p] = { error: e.message };
  }
  render();
}

const METRIC_NAME = { dials: "Dials", reached: "Reached", lineCards: "Line cards sent", replied: "Replied", rfqs: "RFQs promised", rfqReceived: "RFQs in" };

async function loadDetail(p, metric) {
  const key = `${p}:${metric}`;
  if (state.details[key] && !state.details[key].error) return;
  state.details[key] = { loading: true };
  render();
  try {
    state.details[key] = await api(`/api/stats/period/detail?p=${p}&m=${metric}`);
  } catch (e) {
    state.details[key] = { error: e.message };
  }
  render();
}

function detailTable(p, metric) {
  const t = state.details[`${p}:${metric}`];
  const period = PERIODS.find(([k]) => k === p)[1].toLowerCase();
  const head = el("div", { class: "dhead" }, [
    el("p", { class: "label", text: `${METRIC_NAME[metric]} · ${period}${t && t.rows ? ` · ${t.rows.length}` : ""}` }),
    el("button", { class: "linkbtn", text: "Close", onclick: () => { state.drill = null; render(); } }),
  ]);
  if (!t || t.loading) return el("div", { class: "dwrap" }, [head, el("p", { class: "loading", text: "Loading…" })]);
  if (t.error) return el("div", { class: "dwrap" }, [head, el("p", { class: "err", text: t.error })]);
  if (!t.rows.length) return el("div", { class: "dwrap" }, [head, el("p", { class: "empty", text: "Nothing here for this period." })]);
  return el("div", { class: "dwrap x3d" }, [
    head,
    el("div", { class: "dscroll" }, el("table", { class: "dtable" }, [
      el("thead", {}, el("tr", {}, t.columns.map((c) => el("th", { text: c })))),
      el("tbody", {}, t.rows.map((r) => el("tr", {}, r.cells.map((c, i) => el("td", {},
        t.columns[i] === "Account" && c ? el("a", { href: closeLead(r.leadId), target: "_blank", rel: "noopener", text: c }) : c))))),
    ])),
  ]);
}

function statsBar() {
  const p = state.period;
  const s = state.periods[p];
  if (!s) setTimeout(() => loadPeriod(p), 0);
  const n = (v) => (s && !s.loading && !s.error ? String(v) : "–");
  // Click a number to see the rows behind it; click again to close.
  const stat = (label, v, sub, metric) => el("button", {
    class: `pstat${state.drill === metric ? " on" : ""}`, title: "Show the list",
    onclick: () => { state.drill = state.drill === metric ? null : metric; if (state.drill) loadDetail(p, metric); render(); },
  }, [el("span", { class: "v mono", text: n(v) }), el("span", { class: "label", text: label }), sub ? el("span", { class: "sub2", text: sub }) : null]);
  const pct = s && s.dials ? `${Math.round((s.reached / s.dials) * 100)}% of dials` : null;
  return el("div", { class: "statsbar" }, [
    el("div", { class: "seg" }, PERIODS.map(([k, label]) => el("button", {
      class: state.period === k ? "on" : "",
      onclick: () => { state.period = k; try { localStorage.setItem("westgate.period", k); } catch {} loadPeriod(k); if (state.drill) loadDetail(k, state.drill); render(); },
    }, label))),
    el("div", { class: "pstats" }, [
      stat("Dials", s && s.dials, s && !s.loading && s.companies != null ? `${s.companies} compan${s.companies === 1 ? "y" : "ies"}` : null, "dials"),
      stat("Reached", s && s.reached, pct, "reached"),
      stat("Line cards sent", s && s.lineCards, null, "lineCards"),
      stat("Replied", s && s.replied, s && s.lineCards ? `${Math.round((s.replied / s.lineCards) * 100)}% of line cards` : null, "replied"),
      stat("RFQs promised", s && s.rfqs, null, "rfqs"),
      stat("RFQs in", s && s.rfqReceived, null, "rfqReceived"),
    ]),
    state.drill ? detailTable(p, state.drill) : null,
    s && s.loading && p === "all" ? el("p", { class: "sub2", text: "Counting everything in Close, this takes a moment…" }) : null,
    s && s.error ? el("p", { class: "err", text: s.error }) : null,
  ]);
}

// ---------- accounts ----------

// Sections, in the order to work them (Walt 9/29): money, people waiting on you, promised times, hot, chasing.
const SECTIONS = [
  ["answer", "Answer replies", "They wrote back and are waiting on you."],
  ["callback", "Callbacks due today", "Times you promised."],
  ["hot", "Hot: call now", "Opened your email 3+ times, no RFQ yet."],
  ["seen", "Get the line card seen", "Not opened, bounced or blocked."],
  ["followup", "Follow up by email", "A short reply in the same thread."],
  ["today", "Done today", "You already reached out today. They come back tomorrow if there's still something to do."],
  ["rest", "Giving them a day", "Someone picked up, you left a voicemail, or you emailed them on the last business day. Back tomorrow, so you're never calling two days in a row."],
  ["later", "Waiting", "Nothing to do today: an automatic email, a task later, or it's their move."],
];
const SEEN = {
  bounced: ["Bounced", "s-bounced"],
  replied: ["Replied", "s-replied"],
  confirmed: ["Got it · no reply", "s-has"],
  opened: ["Opened", "s-opened"],
  maybe: ["Maybe opened", "s-maybe"],
  not_opened: ["Not opened", "s-not"],
};
const EVENT_ICON = { auto: "⟳", line_card: "✉", email: "✉", reply: "↩", rfq: "★", quote: "$", opened: "◉", filter: "⚠", call: "☎", note: "✎" };

function accountsSection() {
  const q = (state.acctQ || "").trim().toLowerCase();
  const hit = (a) => !q || `${a.company} ${a.contact.name || ""} ${a.contact.email || ""} ${a.contact.phone || ""}`.toLowerCase().includes(q);
  const all = ((state.board && state.board.accounts) || []).filter(hit);
  const head = () => el("div", { class: "gr gh" }, ["Account", "Phone", "Line card", "Goal", "Last activity", ""].map((h) => el("span", { class: "label", text: h })));
  const groups = SECTIONS.map(([k, title, sub]) => {
    const rows = all.filter((a) => a.section === k);
    if (!rows.length) return null;
    const later = k === "later" || k === "today" || k === "rest"; // collapsed until you open them
    const shut = later && !state.showSect[k] && !q; // a search shows every match, whatever section it's in
    return el("div", { class: `sect sect-${k}` }, [
      el("div", { class: "secthead", onclick: later ? () => { state.showSect[k] = !state.showSect[k]; render(); } : null }, [
        el("h3", {}, [title, el("span", { class: "c mono", text: rows.length })]),
        el("span", { class: "sub2", text: sub }),
        later ? el("button", { class: "btn small", text: shut ? "Show" : "Hide" }) : null,
      ]),
      shut ? null : el("div", { class: "grid x3d" }, [head(), ...rows.flatMap(accountRow)]),
    ]);
  }).filter(Boolean);
  const needs = all.filter((a) => !["later", "today", "rest", "rfq"].includes(a.section)).length;
  return el("section", {}, [
    el("div", { class: "head" }, [
      el("h2", { text: "Accounts" }),
      el("input", { class: "heatq", type: "search", placeholder: "Find an account, a name, an email, a number", value: state.acctQ || "", oninput: (e) => { state.acctQ = e.target.value; renderKeepFocus(".heatq"); } }),
      q ? el("span", { class: "muted small3", text: `${all.length} match${all.length === 1 ? "" : "es"} · click a row for its history` }) : null,
    ]),
    !state.board ? el("p", { class: "loading", text: "Reading your accounts from Close…" })
      : !all.length ? el("p", { class: "empty", text: q ? "No account matches that." : "None here." })
        : el("div", { class: "sects" }, [rfqNote(all), needs ? null : el("p", { class: "empty", text: "Nothing needs you right now." }), ...groups]),
  ]);
}

// ---------- RFQs: everyone who's sent one, where it stands and who it's waiting on (Walt 9/29) ----------
// Off the action list: once the RFQ is in, the rep isn't the next move unless the buyer answers the quote.

const RFQ_STAGES = ["With pricing", "Quote sent", "Buyer answered", "Order in", "Won", "Lost"];
const WAITING = { westgate: ["Westgate", "w-westgate"], buyer: ["The buyer", "w-buyer"], you: ["You", "w-you"], nobody: ["Done", "w-done"] };

// ---------- RFQs over time: one line, the running total (Walt 9/29: "exponential growth, a line graph") ----------
// Growth reads as the line getting steeper. Hover snaps to a day: new that day, the total, and who sent them.

const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(kids)) if (c) n.append(c);
  return n;
}
const dayLabel = (day, opts = { month: "short", day: "numeric" }) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

function rfqGrowth(t) {
  if (!t) return el("section", { class: "rfqline" }, [el("p", { class: "loading", text: "Counting RFQs…" })]);
  const days = t.days;
  const pct = t.lastWeek ? Math.round(((t.thisWeek - t.lastWeek) / t.lastWeek) * 100) : null;
  const hero = el("div", { class: "rfqhero" }, [
    el("div", {}, [el("span", { class: "big mono", text: t.total }), el("span", { class: "sub2", text: ` RFQ${t.total === 1 ? "" : "s"} since your first line card, ${dayLabel(days[0].day)}` })]),
    el("div", { class: "rfqweeks" }, [
      el("span", {}, [el("b", { class: "mono", text: t.thisWeek }), " this week"]),
      el("span", { class: "sub2" }, [el("b", { class: "mono", text: t.lastWeek }), " the week before"]),
      el("span", { class: "sub2", text: pct == null ? (t.thisWeek ? "first week with RFQs" : "") : `${pct >= 0 ? "+" : ""}${pct}% week over week` }),
    ]),
  ]);
  if (days.length < 2) return el("section", { class: "rfqline" }, [hero]);

  // Plot: fixed coordinate space, scaled to the container.
  const W = 760, H = 240, L = 34, R = 28, T = 14, B = 30;
  const max = Math.max(4, Math.ceil(t.total * 1.15));
  const step = max <= 12 ? 2 : max <= 30 ? 5 : max <= 60 ? 10 : max <= 150 ? 25 : 50;
  const x = (i) => L + (i * (W - L - R)) / (days.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const kids = [];
  for (let v = 0; v <= max; v += step) {
    kids.push(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? "base" : "grid" }));
    kids.push(svg("text", { x: L - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, [String(v)]));
  }
  const every = Math.max(1, Math.ceil(days.length / 8));
  days.forEach((dd, i) => { if (i % every === 0 || i === days.length - 1) kids.push(svg("text", { x: x(i), y: H - 8, class: "tick", "text-anchor": i === 0 ? "start" : i === days.length - 1 ? "end" : "middle" }, [dayLabel(dd.day)])); });
  kids.push(svg("path", { d: days.map((dd, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(dd.total).toFixed(1)}`).join(""), class: "line" }));
  // A dot on each day RFQs came in (the steps up), with a surface ring.
  days.forEach((dd, i) => { if (dd.count) kids.push(svg("circle", { cx: x(i), cy: y(dd.total), r: 4.5, class: "dot" })); });
  // Direct label on the last point: the total.
  const last = days[days.length - 1];
  kids.push(svg("text", { x: x(days.length - 1) + 8, y: y(last.total) + 4, class: "endlabel" }, [String(last.total)]));
  const hair = svg("line", { y1: T, y2: H - B, class: "hair", visibility: "hidden" });
  const focus = svg("circle", { r: 6, class: "focus", visibility: "hidden" });
  kids.push(hair, focus);
  const hit = svg("rect", { x: L, y: T, width: W - L - R, height: H - T - B, class: "hit", tabindex: "0", "aria-label": "RFQs over time; use the arrow keys to move between days" });
  kids.push(hit);
  const plot = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "rfqsvg", role: "img", "aria-label": `RFQs over time: ${t.total} since ${dayLabel(days[0].day)}` }, kids);
  const tip = el("div", { class: "rfqtip", hidden: true });
  const wrap = el("div", { class: "rfqplot" }, [plot, tip]);

  let at = -1;
  const show = (i) => {
    at = Math.max(0, Math.min(days.length - 1, i));
    const dd = days[at];
    hair.setAttribute("x1", x(at)); hair.setAttribute("x2", x(at)); hair.setAttribute("visibility", "visible");
    focus.setAttribute("cx", x(at)); focus.setAttribute("cy", y(dd.total)); focus.setAttribute("visibility", "visible");
    tip.replaceChildren(
      el("p", { class: "tipday", text: dayLabel(dd.day, { weekday: "short", month: "short", day: "numeric" }) }),
      el("p", {}, [el("b", { class: "mono", text: dd.count }), ` new · `, el("b", { class: "mono", text: dd.total }), " total"]),
      ...dd.accounts.map((a) => el("p", { class: "sub2", text: `${a.company}${a.how === "marked" ? " (marked)" : a.how === "email" ? " (in the email)" : ""}` })),
    );
    tip.hidden = false;
    const r = plot.getBoundingClientRect(), px = (x(at) / W) * r.width;
    // Right half: the readout sits left of the crosshair, so it never covers the point it describes.
    const tw = tip.offsetWidth || 200;
    tip.style.left = `${px > r.width / 2 ? Math.max(px - tw - 14, 0) : Math.min(px + 14, r.width - tw)}px`;
    tip.style.top = `${Math.max((y(dd.total) / H) * r.height - 20, 0)}px`;
  };
  const hide = () => { hair.setAttribute("visibility", "hidden"); focus.setAttribute("visibility", "hidden"); tip.hidden = true; };
  hit.addEventListener("pointermove", (e) => { const r = plot.getBoundingClientRect(); const vx = ((e.clientX - r.left) / r.width) * W; show(Math.round(((vx - L) / (W - L - R)) * (days.length - 1))); });
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(days.length - 1));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") { show(at - 1); e.preventDefault(); } if (e.key === "ArrowRight") { show(at + 1); e.preventDefault(); } });

  const table = el("details", { class: "rfqtable" }, [
    el("summary", { text: "See the numbers" }),
    el("table", {}, [
      el("thead", {}, [el("tr", {}, ["Day", "New", "Total", "From"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, days.filter((dd) => dd.count).reverse().map((dd) => el("tr", {}, [
        el("td", { text: dayLabel(dd.day, { weekday: "short", month: "short", day: "numeric" }) }), el("td", { class: "mono", text: dd.count }), el("td", { class: "mono", text: dd.total }), el("td", { text: dd.accounts.map((a) => a.company).join(", ") }),
      ]))),
    ]),
  ]);
  return el("section", { class: "rfqline" }, [el("h2", { class: "rfqh", text: "RFQs over time" }), hero, wrap, table]);
}

function rfqNote(all) {
  const n = all.filter((a) => a.rfq).length;
  return n ? el("p", { class: "rfqnote" }, [`${n} account${n === 1 ? " has" : "s have"} sent an RFQ and ${n === 1 ? "is" : "are"} off this list. `, el("a", { href: "#rfqs", text: "See where they stand →", onclick: (e) => { e.preventDefault(); go("rfqs"); } })]) : null;
}

// ---------- heat map ----------
// Every account without an RFQ as a tile, hottest first, coloured by how close they are to sending one.
// Click a tile for the points behind it. The score comes from Close (opens, replies, repeat talks, promises) and fades when quiet.
const HEAT = {
  hot: ["Hot", "Opened, wrote back, picked up again. Call these first."],
  warm: ["Warm", "Real conversations or repeat opens. One more touch could turn into an RFQ."],
  cool: ["Cool", "One talk and a name. The email cadence is doing the work here."],
  cold: ["Cold", "Nothing beyond the intro call, bounced, or gone quiet for weeks."],
};

// Where the line card stands: a person opened it, it landed but nobody's opened it, or it never arrived.
const CARD = {
  opened: ["Opened", "A person opened the line card."],
  landed: ["Not confirmed", "Delivered, but no person has opened it yet (a spam filter may have). Still in the email sequence every two business days, until you put them on a cooling period."],
  bounced: ["Bounced", "It never arrived: bounced or blocked. They haven't received the line card."],
};
function cardState(a) { return a.seen === "bounced" ? "bounced" : (a.seen === "opened" || a.seen === "replied" || a.seen === "confirmed") ? "opened" : "landed"; }
function cardText(a) {
  const o = a.opens, st = cardState(a);
  return st === "bounced" ? `Bounced: they never got it`
    : st === "opened" ? `Opened ${o.person}×${o.app ? ` in ${o.app}` : ""}${o.last ? `, last ${shortDate(o.last)}` : a.seen === "replied" ? " (they replied)" : a.seen === "confirmed" ? " (they said so on a call)" : ""}`
      : o.filter ? `Landed, not opened (only a spam filter touched it) · in the sequence, unconfirmed` : o.maybe ? `Landed, maybe opened · in the sequence, unconfirmed` : `Landed, not opened yet · in the sequence, unconfirmed`;
}

// RFQ potential: how much PVF buying they do at all, read from their site. Steady accounts are worth more calls at any warmth.
const POT = {
  steady: ["Steady", "Quotes job by job and shops every RFQ: fab shops and contractors doing pressure or alloy work."],
  project: ["Project", "Buys on contract day to day, floods RFQs during projects and turnarounds: plants, utilities, EPCs."],
  occasional: ["Occasional", "Nothing on their site says they buy much PVF."],
  unknown: ["Unknown", "Their site hasn't been read yet, or doesn't say. Ask on the call."],
};
const POT_RANK = { steady: 0, project: 1, occasional: 2, unknown: 3 };
const potTier = (a) => (a.potential && a.potential.tier) || "unknown";

// Opening a lead in Close (Walt 10/6): the extension, if it's installed, moves the Close tab in whichever window it
// lives and brings that window forward (a page can't reach other windows; the extension can). Without the
// extension, one named window the page reuses.
let closeWin = null;
function openInCloseTab(leadId) {
  const url = closeLead(leadId);
  let acked = false;
  const onAck = (e) => { if (e.detail && e.detail.leadId === leadId) acked = true; };
  window.addEventListener("westgate:open-lead-ack", onAck, { once: true });
  window.dispatchEvent(new CustomEvent("westgate:open-lead", { detail: { leadId } }));
  setTimeout(() => {
    window.removeEventListener("westgate:open-lead-ack", onAck);
    if (acked) return;
    try {
      if (closeWin && !closeWin.closed) { closeWin.location.href = url; return; }
      closeWin = window.open(url, "westgate-close");
    } catch { window.open(url, "westgate-close"); }
  }, 400);
}

// What you did last, and what's happened today (Walt 10/7): from the account's own events.
// The objection Walt hears most (10/7): the PMs or subs order their own, so the main office isn't the buyer.
const pmsBuy = (a) => { const w = a.potential && a.potential.profile && a.potential.profile.heard && a.potential.profile.heard.works_through; return !!w && (w.value === "PM" || w.value === "sub"); };
const TODAY_F = {
  none: ["Nothing yet", "No call, no email, nothing from them today."],
  emailed: ["Emailed", "An email went to them today (automatic or by hand)."],
  called: ["Called", "You dialed them today, reached or not."],
  reached: ["Reached", "You had a real conversation with them today."],
  wrote: ["They wrote back", "A reply or an RFQ came in today."],
};
const isToday = (iso) => !!iso && new Date(iso).toDateString() === new Date().toDateString();
// Quiet time (Walt 10/7): how many business days since anyone touched the account, either side. Someone called or
// emailed today sits out of the way; nobody who's gone two business days without a word is allowed to hide.
const HAS_RFQ_STATUS = /rfq|quot|won|customer|order/i;
const QUIET_DUE_DAYS = 2;
function lastTouchAt(a) {
  const y = lastYou(a);
  return [y ? y.at : null, a.warmth && a.warmth.lastSignal, a.touches && a.touches.lastTalk, a.lastIn, a.cardSentAt].filter(Boolean).sort().pop() || null;
}
function businessDaysSince(iso) {
  if (!iso) return 99;
  const from = new Date(iso); from.setHours(0, 0, 0, 0);
  const to = new Date(); to.setHours(0, 0, 0, 0);
  let n = 0;
  for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
const quietDays = (a) => businessDaysSince(lastTouchAt(a));
const isDue = (a) => quietDays(a) >= QUIET_DUE_DAYS;
function lastYou(a) {
  const mine = a.events.filter((e) => e.kind === "call" || e.kind === "email" || e.kind === "line_card").sort((x, y) => y.at.localeCompare(x.at));
  const e = mine[0];
  return e ? { kind: e.kind === "call" ? "call" : "email", at: e.at } : null;
}
function todayState(a) {
  const ev = a.events.filter((e) => isToday(e.at));
  const reached = !!a.touches.lastTalk && isToday(a.touches.lastTalk);
  return {
    emailed: ev.some((e) => e.kind === "email" || e.kind === "line_card"),
    called: ev.some((e) => e.kind === "call"), reached,
    wrote: ev.some((e) => e.kind === "reply" || e.kind === "rfq"),
  };
}
function matchesToday(a) {
  if (!state.heatToday) return true;
  const t = todayState(a);
  if (state.heatToday === "none") return !t.emailed && !t.called && !t.wrote;
  return !!t[state.heatToday];
}

function heatRows() {
  // Nobody with an RFQ in (detected, tapped, or marked RFQ Received / Quoted / Won in Close) belongs here (Walt 10/7): the map is for getting the first one.
  const all = ((state.board && state.board.accounts) || []).filter((a) => !a.rfq && !HAS_RFQ_STATUS.test(a.status || "") && a.warmth);
  // Hottest first; inside a warmth band, the accounts worth the most come first.
  const rows = all.slice().sort((a, b) => b.warmth.bucket === a.warmth.bucket
    ? (POT_RANK[potTier(a)] - POT_RANK[potTier(b)] || b.warmth.score - a.warmth.score || a.company.localeCompare(b.company))
    : b.warmth.score - a.warmth.score);
  const q = state.heatQ.trim().toLowerCase();
  const hit = (a) => !q || `${a.company} ${a.contact.name || ""} ${a.contact.email || ""}`.toLowerCase().includes(q);
  return rows.filter((a) => hit(a) && (!state.heatOnly || a.warmth.bucket === state.heatOnly) && (!state.heatCard || cardState(a) === state.heatCard) && (!state.heatPot || potTier(a) === state.heatPot) && (!state.heatPms || pmsBuy(a)) && matchesToday(a));
}

async function readSites(leadIds) {
  state.potBusy = true; render();
  try { await api("/api/potential/refresh", leadIds ? { lead_ids: leadIds } : {}); await load(true); }
  catch (e) { state.error = e.message; }
  state.potBusy = false; render();
}

async function sayPotential(a, said) {
  state.potBusy = true; render();
  try {
    const { potential } = await api(`/api/potential/${a.leadId}`, { said });
    a.potential = potential;
  } catch (e) { state.error = e.message; }
  state.potBusy = false; render();
}

function heatPage() {
  const rows = heatRows();
  const all = ((state.board && state.board.accounts) || []).filter((a) => !a.rfq && a.warmth);
  const by = { hot: [], warm: [], cool: [], cold: [] };
  for (const a of rows) by[a.warmth.bucket].push(a);
  const pick = state.heatPick && rows.find((a) => a.leadId === state.heatPick);
  const buckets = state.heatOnly ? [state.heatOnly] : ["hot", "warm", "cool", "cold"];
  // Tile shade: within a bucket, the score sets how deep the colour goes.
  const shade = (a) => Math.max(0.35, Math.min(1, (a.warmth.score + 3) / 15));
  return el("section", { class: `heat${pick ? " drawer-open" : ""}` }, [
    el("div", { class: "head pagehead" }, [
      el("h1", { class: "ptitle", text: "Heat map" }),
      el("input", { class: "heatq", type: "search", placeholder: "Find an account, a name, an email", value: state.heatQ, oninput: (e) => { state.heatQ = e.target.value; state.heatPick = null; renderKeepFocus(".heatq"); } }),
      el("span", { class: "muted small3", text: `${all.filter((a) => cardState(a) !== "bounced").length} got the line card and haven't sent an RFQ yet` }),
    ]),
    el("div", { class: "heatsum" }, ["hot", "warm", "cool", "cold"].map((k) => el("button", {
      class: `heatk w-${k}${state.heatOnly === k ? " on" : ""}`, title: HEAT[k][1],
      onclick: () => { state.heatOnly = state.heatOnly === k ? null : k; state.heatPick = null; render(); },
    }, [el("b", { class: "mono", text: all.filter((a) => a.warmth.bucket === k).length }), el("span", { text: HEAT[k][0] })]))),
    el("div", { class: "heatcard" }, [
      el("span", { class: "label", text: "Line card" }),
      ...["opened", "landed", "bounced"].map((k) => el("button", {
        class: `cardk c-${k}${state.heatCard === k ? " on" : ""}`, title: CARD[k][1],
        onclick: () => { state.heatCard = state.heatCard === k ? null : k; state.heatPick = null; render(); },
      }, [el("i", { "aria-hidden": "true" }), el("b", { class: "mono", text: all.filter((a) => cardState(a) === k).length }), CARD[k][0]])),
    ]),
    el("div", { class: "heatcard" }, [
      el("span", { class: "label", text: "RFQ potential" }),
      ...["steady", "project", "occasional", "unknown"].map((k) => el("button", {
        class: `cardk p-${k}${state.heatPot === k ? " on" : ""}`, title: POT[k][1],
        onclick: () => { state.heatPot = state.heatPot === k ? null : k; state.heatPick = null; render(); },
      }, [el("b", { class: "mono", text: all.filter((a) => potTier(a) === k).length }), POT[k][0]])),
      all.some((a) => !a.potential) ? el("button", { class: "linkbtn", disabled: state.potBusy, text: state.potBusy ? "Reading their sites…" : `Read ${all.filter((a) => !a.potential).length} sites now`, onclick: () => readSites(null) }) : null,
    ]),
    el("div", { class: "heatcard" }, [
      el("span", { class: "label", text: "Who buys" }),
      el("button", {
        class: `cardk b-pms${state.heatPms ? " on" : ""}`, title: "They said the project managers or subcontractors order their own materials. Tapped on the call screen, or heard on a call.",
        onclick: () => { state.heatPms = !state.heatPms; state.heatPick = null; render(); },
      }, [el("b", { class: "mono", text: all.filter(pmsBuy).length }), "PMs / subs buy"]),
    ]),
    el("div", { class: "heatcard" }, [
      el("span", { class: "label", text: "Today" }),
      ...Object.keys(TODAY_F).map((k) => el("button", {
        class: `cardk d-${k}${state.heatToday === k ? " on" : ""}`, title: TODAY_F[k][1],
        onclick: () => { state.heatToday = state.heatToday === k ? null : k; state.heatPick = null; render(); },
      }, [el("b", { class: "mono", text: all.filter((a) => { const t = todayState(a); return k === "none" ? !t.emailed && !t.called && !t.wrote : t[k]; }).length }), TODAY_F[k][0]])),
    ]),
    !state.board ? el("p", { class: "loading", text: "Reading your accounts from Close…" }) : null,
    el("p", { class: "muted small3", text: "Everyone here was sent the line card. The goal is an RFQ. Colour is warmth (how they're responding); size is RFQ potential (how much they buy). Big and dark: work these now. Big and grey: worth warming up. Anyone contacted in the last two business days is tucked away under its band; anyone quiet for two days or more is always showing. Everyone stays in the two-day email sequence until you cool them off by hand." }),
    ...buckets.map((k) => { const due = by[k].filter(isDue), fresh = by[k].filter((a) => !isDue(a)), showFresh = !!state.heatFresh[k]; return el("div", { class: `heatband w-${k}` }, [
      el("div", { class: "heatlbl" }, [el("span", { class: "label", text: HEAT[k][0] }), el("span", { class: "mono muted", text: due.length }), el("span", { class: "muted small3 why", text: HEAT[k][1] }),
        // Touched in the last two business days: out of the way until asked for (Walt 10/7).
        fresh.length ? el("button", { class: "linkbtn fresht", text: showFresh ? `hide the ${fresh.length} contacted in the last ${QUIET_DUE_DAYS} days` : `+${fresh.length} contacted in the last ${QUIET_DUE_DAYS} days`, onclick: () => { state.heatFresh[k] = !showFresh; render(); } }) : null,
      ]),
      due.length || (showFresh && fresh.length) ? el("div", { class: "tiles" }, [...due, ...(showFresh ? fresh : [])].map((a) => el("button", {
        class: `tile w-${a.warmth.bucket} t-${potTier(a)}${pick && pick.leadId === a.leadId ? " on" : ""}${isDue(a) ? "" : " fresh"}`,
        style: `--heat:${shade(a).toFixed(2)}`,
        title: `${a.company} · ${a.warmth.score} · ${POT[potTier(a)][0]}\nLine card sent ${shortDate(a.cardSentAt)}: ${cardText(a)}`,
        // One click opens the drawer here, nothing else (Walt 10/6). "Open in Close" in the drawer is the only thing that touches Close.
        onclick: () => { state.heatPick = a.leadId; render(); },
      }, [
        el("span", { class: "co", text: a.company }),
        el("span", { class: `card c-${cardState(a)}` }, [el("i", { "aria-hidden": "true" }), `sent ${shortDate(a.cardSentAt)}`]),
        (() => { const y = lastYou(a); const t = todayState(a); return el("span", { class: `you${t.reached ? " reached" : t.called || t.emailed ? " touched" : ""}` }, [
          t.reached ? "reached today" : t.called ? "called today" : t.emailed ? "emailed today" : y ? `you · ${y.kind} ${shortDate(y.at)}` : "no touch yet",
        ]); })(),
        el("span", { class: "foot" }, [
          el("span", { class: "sc mono", text: a.warmth.score }),
          potTier(a) !== "unknown" ? el("span", { class: "tier", text: POT[potTier(a)][0] }) : null,
          a.warmth.lastSignal ? el("span", { class: "ago", title: "Days since their last sign of life", text: `them · ${daysAgo(a.warmth.lastSignal)}d` }) : null,
          el("span", { class: `quiet${isDue(a) ? " due" : ""}`, title: "Business days since anyone touched this account, you or them", text: quietDays(a) >= 99 ? "never touched" : `quiet ${quietDays(a)}d` }),
        ]),
      ]))) : el("p", { class: "empty small3", text: fresh.length ? `Nobody waiting. ${fresh.length} contacted in the last ${QUIET_DUE_DAYS} days.` : "Nobody here." }),
    ]); }),
    pick ? heatDrawer(pick, rows) : null,
  ]);
}

// Where it stands, in plain words: what we sent, what they did, what you did, what they said, how long it's been quiet, what's next.
function storyFor(a) {
  const c = a.contact, who = (c.name || "").split(/\s+/)[0] || "they";
  const ev = a.events.slice().sort((x, y) => x.at.localeCompare(y.at));
  const out = [];
  const st = cardState(a);
  out.push(`Line card went to ${c.name || c.email || "them"} on ${shortDate(a.cardSentAt)}${st === "bounced" ? ", and it bounced: they never got it" : st === "landed" ? ", not opened by a person yet" : a.opens.person ? `, opened ${a.opens.person}×${a.opens.app ? ` in ${a.opens.app}` : ""}` : ""}.`);
  const replies = ev.filter((e) => e.kind === "reply");
  if (replies.length) out.push(`${who} wrote back ${replies.length === 1 ? `on ${shortDate(replies[replies.length - 1].at)}` : `${replies.length}×, last ${shortDate(replies[replies.length - 1].at)}`}.`);
  const t = a.touches;
  if (t) {
    const talks = t.talked ? `talked ${t.talked}× (last ${t.lastTalk ? shortDate(t.lastTalk) : "–"})` : null;
    const tries = !t.talked && t.dials ? `called ${t.dials}×, nobody picked up` : t.dials > t.talked ? `${t.dials} calls in all` : null;
    const mails = t.emailsOut > 1 ? `${t.emailsOut} emails sent` : null;
    const bits = [talks, tries, mails].filter(Boolean);
    if (bits.length) out.push(`You've ${bits.join(", ")}.`);
  }
  if (a.rfqPromised) out.push(`${who} promised an RFQ.`);
  const heard = a.potential && a.potential.profile.heard;
  if (heard && Object.keys(heard).length) {
    const h = [];
    if (heard.rfq_volume) h.push(`${heard.rfq_volume.value} RFQs`);
    if (heard.vendor_policy) h.push(heard.vendor_policy.value);
    if (heard.incumbent) h.push(`buys from ${heard.incumbent.value}`);
    if (h.length) out.push(`On the phone: ${h.join(", ")}.`);
  }
  // Our own tagged notes ([RFQ potential], [Purchasing]) aren't news; the rep's call notes are.
  const note = ev.filter((e) => e.kind === "note" && !/^\[(RFQ potential|Purchasing|RFQ status)\]/.test(e.text)).pop();
  if (note) out.push(`Last note (${shortDate(note.at)}): ${note.text.replace(/^\d+\/\d+:\s*/, "").slice(0, 140)}${note.text.length > 140 ? "…" : ""}`);
  if (a.rfq) out.push(`RFQ in on ${shortDate(a.rfq.at)}${a.rfq.quotedAt ? `, quoted ${shortDate(a.rfq.quotedAt)}` : ", not quoted yet"}.`);
  const quiet = a.warmth.lastSignal ? daysAgo(a.warmth.lastSignal) : daysAgo(a.cardSentAt);
  if (quiet >= 5) out.push(`Nothing from them in ${quiet} days.`);
  return out;
}

// Re-render without losing the caret in a text box.
function renderKeepFocus(sel) {
  const pos = document.querySelector(sel)?.selectionStart ?? null;
  render();
  const box = document.querySelector(sel);
  if (box) { box.focus(); if (pos != null) box.setSelectionRange(pos, pos); }
}

// Cooling periods (10/7): how long they're out of the automatic emails, picked each time (Walt: a week for some, a month for others).
const COOL_OPTIONS = [[7, "1 week"], [14, "2 weeks"], [30, "1 month"], [90, "3 months"], [null, "for good"]];
// Cooling periods from the drawer (10/7): out of the automatic emails for the period picked, or for good; put back any time.
// "Fire them a meme" (Walt 10/7): search the account, one tap, and a bump with a meme they haven't had goes out in
// the next couple of minutes, in their thread with the PDF, like the automatic ones. Skips the gap rule: this is on purpose.
function memeNowBlock(a) {
  const m = state.memeNow[a.leadId] || {};
  const fire = async () => {
    state.memeNow[a.leadId] = { busy: true }; render();
    try {
      const r = await api("/api/automations/send-now", { lead_ids: [a.leadId], stagger: 0 });
      const row = r.planned && r.planned[0];
      state.memeNow[a.leadId] = row ? { sent: { to: row.to, meme: row.meme, at: row.scheduledFor } } : { error: (r.skipped && r.skipped[0] && r.skipped[0].why) || "Nothing went out." };
    } catch (e) { state.memeNow[a.leadId] = { error: e.message }; }
    render(); load(true);
  };
  return el("div", { class: "dr-cool memenow" }, [
    el("span", { class: "label", text: "Meme" }),
    m.sent ? el("span", { class: "sub2 good", text: `Sent to ${m.sent.to}${m.sent.meme ? ` with ${m.sent.meme.replace(/\.[a-z0-9]+$/i, "")}` : ""}${m.sent.at ? `, goes ${new Date(m.sent.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}.` })
      : m.error ? el("span", { class: "sub2 bad", text: m.error })
      : el("span", { class: "sub2", text: "A bump with a meme they haven't had, in their thread, out in a couple of minutes." }),
    m.sent ? null : el("button", { class: "btn small", disabled: !!m.busy, text: m.busy ? "Sending…" : "Send a meme email now", onclick: fire }),
  ]);
}

function coolingBlock(a) {
  const c = state.cool[a.leadId];
  if (c === undefined) { state.cool[a.leadId] = "loading"; api(`/api/leads/${a.leadId}/hold`).then((r) => { state.cool[a.leadId] = r.cooling; render(); }).catch(() => { state.cool[a.leadId] = null; render(); }); }
  const set = async (days, on = true) => {
    state.cool[a.leadId] = "loading"; render();
    try { const r = await api(`/api/leads/${a.leadId}/hold`, { hold: on, days, why: on ? "cooled off from the heat map" : null }); state.cool[a.leadId] = on ? { until: r.until, why: "cooled off from the heat map" } : null; }
    catch (e) { state.error = e.message; state.cool[a.leadId] = null; }
    render(); load(true);
  };
  const on = c && c !== "loading";
  return el("div", { class: `dr-cool${on ? " on" : ""}` }, [
    el("span", { class: "label", text: "Emails" }),
    c === "loading" ? el("span", { class: "sub2", text: "…" })
      : on ? el("span", { class: "sub2", text: c.until ? `Cooling off until ${shortDate(c.until)}${c.why ? ` · ${c.why}` : ""}` : `On hold${c.why ? ` · ${c.why}` : ""}` })
        : el("span", { class: "sub2", text: "In the two-day sequence" }),
    on ? el("button", { class: "btn small", text: "Put back", onclick: () => set(null, false) })
      : el("span", { class: "askrow" }, [el("span", { class: "sub2", text: "Cool off for" }), ...COOL_OPTIONS.map(([days, label]) => el("button", { class: days ? "btn small" : "linkbtn small3", text: label, onclick: () => set(days) }))]),
  ]);
}

// The drawer on the right: one lead at a time, Previous / Next walk the map in order (← → on the keyboard too).
function heatDrawer(a, rows) {
  const i = rows.findIndex((r) => r.leadId === a.leadId);
  const w = a.warmth, c = a.contact;
  const goTo = (j) => { if (rows[j]) { state.heatPick = rows[j].leadId; render(); document.querySelector(".tile.on")?.scrollIntoView({ block: "nearest" }); } };
  const close = () => { state.heatPick = null; render(); };
  return el("aside", { class: `drawer w-${w.bucket}`, role: "dialog", "aria-label": a.company }, [
    el("div", { class: "dr-top" }, [
      el("span", { class: "mono muted", text: `${i + 1} of ${rows.length}` }),
      el("button", { class: "linkbtn", text: "Close", onclick: close }),
    ]),
    el("span", { class: `warmth w-${w.bucket} big` }, [el("i", { "aria-hidden": "true" }), `${HEAT[w.bucket][0]} · ${w.score}`]),
    el("a", { class: "dr-co", href: closeLead(a.leadId), target: "westgate-close", text: a.company, onclick: (e) => { e.preventDefault(); openInCloseTab(a.leadId); } }),
    el("div", { class: "sub2 dr-who", text: [c.name, c.email].filter(Boolean).join(" · ") }),
    c.phone ? el("a", { class: "mono tel dr-tel", href: `tel:${c.phone}`, text: prettyPhone(c.phone) }) : null,
    (() => { const y = lastYou(a); const t = todayState(a); return el("div", { class: "dr-touch" }, [
      el("span", { class: "label", text: "Last contact" }),
      el("span", { text: y ? `You · ${y.kind === "call" ? "called" : "emailed"} ${shortDate(y.at)} (${daysAgo(y.at)}d ago)` : "You haven't reached out yet" }),
      t.reached ? el("span", { class: "chip3 good", text: "Reached today" }) : t.called ? el("span", { class: "chip3 warn", text: "Called today" }) : null,
      t.emailed ? el("span", { class: "chip3 soft", text: "Emailed today" }) : null,
      t.wrote ? el("span", { class: "chip3 good", text: "Wrote back today" }) : null,
    ]); })(),
    coolingBlock(a),
    memeNowBlock(a),
    el("div", { class: "dr-story" }, [
      el("div", { class: "label", text: "Where it stands" }),
      el("p", {}, storyFor(a).join(" ")),
      el("p", { class: "dr-do" }, [el("span", { class: `next ${a.next.kind}` }, [el("span", { class: "label", text: a.next.tag }), " ", a.next.label])]),
    ]),
    el("div", { class: `dr-card c-${cardState(a)}` }, [
      el("span", { class: "label", text: "Line card" }),
      el("span", { class: "card" }, [el("i", { "aria-hidden": "true" }), `Sent ${shortDate(a.cardSentAt)} (${daysAgo(a.cardSentAt)}d ago)`]),
      el("span", { class: "sub2", text: cardText(a) }),
    ]),
    el("p", { class: "sub2", text: a.next.detail }),
    potentialBlock(a),
    el("div", { class: "label dr-h", text: `Why ${HEAT[w.bucket][0].toLowerCase()} · ${w.score} points` }),
    el("ul", { class: "hp-why" }, w.why.map((t) => el("li", { class: t.startsWith("-") ? "bad" : t.startsWith("fades") ? "fade" : "", text: t }))),
    el("p", { class: "sub2", text: w.lastSignal ? `Last sign of life ${shortDate(w.lastSignal)} (${daysAgo(w.lastSignal)}d ago)` : "No sign of life since the line card" }),
    touchStrip(a),
    el("div", { class: "label dr-h", text: `History · ${a.events.length}` }),
    el("ol", { class: "timeline dr-ev" }, a.events.map((e) => el("li", { class: `ev ${e.kind}` }, [
      el("span", { class: "ic", "aria-hidden": "true", text: EVENT_ICON[e.kind] || "•" }),
      el("span", { class: "when mono", text: shortDate(e.at) }),
      el("span", { class: "what", text: e.text }),
    ]))),
    el("div", { class: "dr-nav" }, [
      el("button", { class: "btn", text: "← Previous", disabled: i <= 0, onclick: () => goTo(i - 1) }),
      el("button", { class: "btn", text: "Open in Close", onclick: () => openInCloseTab(a.leadId) }),
      el("button", { class: "btn primary", text: "Next lead →", disabled: i >= rows.length - 1, onclick: () => goTo(i + 1) }),
    ]),
  ]);
}
// What they buy: the tier, the facts behind it (each from a page on their site), what's still unknown, and the
// one question that settles it after a call.
function potentialBlock(a) {
  const p = a.potential;
  const tier = potTier(a);
  const said = p && p.profile.repSaid;
  const pr = p && p.profile;
  const ask = [["weekly", "Weekly"], ["monthly", "Monthly"], ["projects", "Projects only"], ["contract-elsewhere", "On contract elsewhere"]];
  // One line: what they are, in a few words. Everything behind it is under "why".
  const heard = pr && pr.heard && Object.keys(pr.heard).length ? `${Object.keys(pr.heard).length} answer${Object.keys(pr.heard).length === 1 ? "" : "s"} from calls` : null;
  const gist = !p ? (state.potBusy ? "Reading their site…" : "Site not read yet")
    : heard ? heard
      : pr.type !== "unknown" ? `${pr.type.charAt(0).toUpperCase() + pr.type.slice(1)}${pr.specs.length ? ` · ${pr.specs.slice(0, 2).join(", ")}` : pr.makes ? ` · ${pr.makes.split(/[,.;]/)[0].slice(0, 40)}` : ""}`
        : pr.problem ? "Couldn't read their site" : "Site doesn't say what they do";
  const open = !!state.potOpen[a.leadId];
  return el("div", { class: `dr-pot p-${tier}` }, [
    el("div", { class: "dr-pot-head" }, [
      el("span", { class: "label", text: "RFQ potential" }),
      el("span", { class: `tierchip p-${tier}`, text: POT[tier][0] }),
      el("span", { class: "gist", text: gist }),
      p ? el("button", { class: "linkbtn small3", text: open ? "hide" : "why?", onclick: () => { state.potOpen[a.leadId] = !open; render(); } }) : null,
    ]),
    open && p ? el("div", { class: "dr-pot-why" }, [
      el("ul", { class: "hp-why pot" }, p.why.map((t) => el("li", { text: t }))),
      p.unknown ? el("p", { class: "sub2 unknown", text: p.unknown }) : null,
      pr.evidence.length ? el("ul", { class: "evid" }, pr.evidence.map((e) => el("li", {}, [
        e.fact, " ", el("a", { href: e.source, target: "_blank", rel: "noopener", class: "src", text: `${new URL(e.source).pathname.replace(/\/$/, "") || "home"} · ${shortDate(e.at)}` }),
      ]))) : null,
      pr.website ? el("a", { class: "sub2", href: pr.website, target: "_blank", rel: "noopener", text: pr.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") }) : null,
      !pr.checkedAt || pr.problem ? el("button", { class: "linkbtn small3", disabled: state.potBusy, text: "Read their site", onclick: () => readSites([a.leadId]) }) : null,
    ]) : null,
    el("div", { class: "askrow" }, [
      el("span", { class: "sub2", text: "RFQs:" }),
      ...ask.map(([k, label]) => el("button", { class: `btn small${said === k ? " primary" : ""}`, disabled: state.potBusy, text: label, onclick: () => sayPotential(a, said === k ? null : k) })),
    ]),
  ]);
}

window.addEventListener("keydown", (e) => {
  if (state.page !== "heat" || !state.heatPick || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
  const rows = heatRows(), i = rows.findIndex((r) => r.leadId === state.heatPick);
  if (e.key === "ArrowRight" && rows[i + 1]) { state.heatPick = rows[i + 1].leadId; render(); }
  else if (e.key === "ArrowLeft" && rows[i - 1]) { state.heatPick = rows[i - 1].leadId; render(); }
  else if (e.key === "Escape") { state.heatPick = null; render(); }
  else return;
  document.querySelector(".tile.on")?.scrollIntoView({ block: "nearest" });
});

function rfqsPage() {
  const all = (state.board && state.board.accounts) || [];
  // Waiting on you first, then Westgate, then the buyer, then done; oldest first inside each.
  const order = { you: 0, westgate: 1, buyer: 2, nobody: 3 };
  const rows = all.filter((a) => a.rfq).sort((a, b) => order[a.rfq.status.waitingOn] - order[b.rfq.status.waitingOn] || a.rfq.status.since.localeCompare(b.rfq.status.since));
  return el("section", {}, [
    el("div", { class: "head pagehead" }, [el("h1", { class: "ptitle", text: "RFQs" })]),
    rfqGrowth(state.rfqLine),
    el("p", { class: "muted small3", text: "Everyone who's sent an RFQ. They're out of the email sequence. The status comes from the emails in Close (quote sent, buyer answered, a PO), or from your own update when the handoff happens outside Close." }),
    !state.board ? el("p", { class: "loading", text: "Reading your accounts from Close…" })
      : !rows.length ? el("p", { class: "empty", text: "No RFQs yet." })
        : el("div", { class: "grid rfqgrid" }, [
          el("div", { class: "gr gh" }, ["Account", "RFQ", "Status", "Waiting on", ""].map((h) => el("span", { class: "label", text: h }))),
          ...rows.flatMap(rfqRow),
        ]),
  ]);
}

function rfqRow(a) {
  const r = a.rfq, st = r.status;
  const [who, wcls] = WAITING[st.waitingOn];
  const edit = state.rfqEdit[a.leadId];
  const row = el("div", { class: "gr" }, [
    el("div", { class: "acct" }, [
      el("a", { class: "co", href: closeLead(a.leadId), target: "_blank", rel: "noopener", text: a.company }),
      el("span", { class: "sub2", text: a.contact.name || a.contact.email || "" }),
    ]),
    el("div", { class: "rfqin" }, [
      el("span", { class: "mono", text: shortDate(r.at) }),
      el("span", { class: "files", title: r.files.join(", ") }, [st.stage === "Order in" ? el("span", { class: "pobadge", text: "PO" }) : null, r.files.join(", ")]),
    ]),
    el("div", {}, [
      el("span", { class: "rfqst", text: st.stage }),
      el("span", { class: "sub2", text: [st.note, `${st.manual ? "updated" : "since"} ${shortDate(st.since)}`].filter(Boolean).join(" · ") }),
    ]),
    el("span", { class: `waiting ${wcls}` }, [el("i", { "aria-hidden": "true" }), `${who}${st.waitingOn === "nobody" ? "" : ` · ${daysAgo(st.since)}d`}`]),
    el("div", { class: "acts" }, [el("button", { class: "btn small", text: edit ? "Cancel" : "Update", onclick: () => { state.rfqEdit[a.leadId] = edit ? null : { stage: st.stage, note: "" }; render(); } })]),
  ]);
  if (!edit) return [row];
  const save = async () => {
    edit.busy = true; edit.error = null; render();
    try {
      await api(`/api/leads/${a.leadId}/rfq-status`, { stage: edit.stage, note: edit.note || null });
      state.rfqEdit[a.leadId] = null;
      await load(true);
    } catch (err) { edit.busy = false; edit.error = err.message; render(); }
  };
  return [row, el("div", { class: "detail rfqedit" }, [
    el("select", { "data-key": `rfq-stage-${a.leadId}`, onchange: (e) => { edit.stage = e.target.value; } }, RFQ_STAGES.map((sname) => el("option", { value: sname, selected: sname === edit.stage, text: sname }))),
    el("input", { type: "text", "data-key": `rfq-note-${a.leadId}`, value: edit.note, placeholder: "Who has it, or what's next (e.g. \"Berni pricing it, back Thu\")", maxlength: "200", oninput: (e) => { edit.note = e.target.value; } }),
    el("button", { class: "btn primary small", disabled: edit.busy, text: edit.busy ? "Saving…" : "Save to Close", onclick: save }),
    edit.error ? el("span", { class: "err", text: edit.error }) : el("span", { class: "sub2", text: "Saved as an [RFQ status] note on the lead." }),
  ])];
}

// The Line card column: a dot and a word. Red dot = opened 3+ times (a hot account).
function seenPill(a) {
  const [text, cls] = SEEN[a.seen];
  const o = a.opens;
  const title = a.seen === "bounced" ? "It never arrived: their mail server sent it back" : a.seen === "confirmed" ? "They told you on a call they have it"
    : a.seen === "opened" ? `Opened ${o.person}× by a person${o.app ? ` in ${o.app}` : ""}${o.last ? `, last ${shortDate(o.last)}` : ""}`
      : a.seen === "maybe" ? `${o.maybe} open${o.maybe === 1 ? "" : "s"} we can't place: maybe a person`
        : a.seen === "not_opened" ? (o.filter ? `Only their spam filter touched it (${o.filter}×)` : "No opens at all") : "";
  const hot = a.seen === "opened" && o.person >= 3;
  return el("span", { class: `seen ${cls}${hot ? " hot" : ""}`, title }, [el("i", { "aria-hidden": "true" }), `${text}${a.seen === "opened" && o.person ? ` ${o.person}×` : ""}`]);
}

// Warmth: how close they are to sending an RFQ, scored from opens, replies, repeat talks and promises. Hover for the why.
function warmthChip(a) {
  const w = a.warmth;
  if (!w || a.rfq) return null;
  const label = { hot: "Hot", warm: "Warm", cool: "Cool", cold: "Cold" }[w.bucket];
  return el("span", { class: `warmth w-${w.bucket}`, title: `${label} (${w.score})\n${w.why.join("\n")}` }, [el("i", { "aria-hidden": "true" }), label]);
}

function accountRow(a) {
  const open = !!state.open[a.leadId];
  const fu = state.followUps[a.leadId];
  const c = a.contact;
  const last = a.events[0];
  const toggle = () => { state.open[a.leadId] = !open; render(); };
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const row = el("div", { class: `gr k-${a.next.kind}${open ? " open" : ""}`, onclick: toggle }, [
    el("div", { class: "acct" }, [
      el("a", { class: "co", href: closeLead(a.leadId), target: "_blank", rel: "noopener", text: a.company, onclick: (e) => e.stopPropagation() }),
      el("span", { class: "sub2" }, [warmthChip(a), c.name || c.email || ""]),
    ]),
    c.phone ? el("a", { class: "mono tel", href: `tel:${c.phone}`, text: prettyPhone(c.phone), onclick: (e) => e.stopPropagation() }) : el("span", { class: "muted", text: "–" }),
    el("span", {}, seenPill(a)),
    el("span", { class: `next ${a.next.kind}` }, [el("span", { class: "label", text: a.next.tag }), " ", a.next.label]),
    last ? el("span", { class: "lastev" }, [el("span", { class: "mono when", text: shortDate(last.at) }), " ", last.text]) : el("span"),
    el("div", { class: "acts" }, [
      a.next.rescue ? el("span", { class: `draftchip${a.rescueDraft ? " ready" : ""}`, text: a.rescueDraft ? "Draft ready in Close" : "Drafting…" }) : null,
      a.next.kind === "bump" && !(fu && fu.done) ? el("button", { class: "btn primary small", disabled: fu && fu.busy, text: fu && fu.busy ? "Writing…" : "Bump", onclick: stop(() => { state.open[a.leadId] = true; writeFollowUp(a.leadId, false); }) }) : null,
      el("span", { class: "chev", "aria-hidden": "true", text: open ? "▴" : "▾" }),
    ]),
  ]);
  if (!open) return [row];
  return [row, el("div", { class: "detail" }, [
    touchStrip(a),
    coolingBlock(a),
    memeNowBlock(a),
    el("p", { class: "why" }, a.next.detail),
    a.next.rescue ? rescueSteps(a) : null,
    gotItButton(a),
    // A follow-up email is always an option, not only when the plan says bump (Walt 9/29, South Shore).
    a.next.kind !== "bump" && a.contact.email && !(fu && (fu.busy || fu.done)) ? el("div", { class: "gotit" }, [
      el("button", { class: "btn small", text: "Write a follow-up email", onclick: (e) => { e.stopPropagation(); writeFollowUp(a.leadId, false); } }),
      el("span", { class: "sub2", text: "A short reply in the same thread, saved as a draft in Close for you to send." }),
    ]) : fu && fu.busy ? el("p", { class: "sub2", text: "Writing the follow-up…" }) : null,
    fu && !fu.busy ? followUpBox(a, fu) : null,
    el("ol", { class: "timeline" }, a.events.map((e) => el("li", { class: `ev ${e.kind}` }, [
      el("span", { class: "ic", "aria-hidden": "true", text: EVENT_ICON[e.kind] || "•" }),
      el("span", { class: "when mono", text: shortDate(e.at) }),
      el("span", { class: "what", text: e.text }),
    ]))),
  ])];
}


// Every touch so far, first thing when a row opens (Walt 9/29): calls, talks, voicemails, emails both ways.
function touchStrip(a) {
  const t = a.touches;
  if (!t) return null;
  const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
  const stat = (v, label, cls = "") => el("div", { class: `tstat ${cls}` }, [el("b", { class: "mono", text: v }), el("span", { text: label })]);
  return el("div", { class: "touches" }, [
    stat(t.dials, t.dials === 1 ? "call" : "calls"),
    stat(t.talked, "connected", t.talked ? "good" : ""), // someone picked up (front desk included), not only the buyer
    stat(t.voicemails, t.voicemails === 1 ? "voicemail" : "voicemails"),
    stat(t.noAnswer, "no answer"),
    stat(t.emailsOut, t.emailsOut === 1 ? "email sent" : "emails sent"),
    stat(t.emailsIn, t.emailsIn === 1 ? "reply" : "replies", t.emailsIn ? "good" : ""),
    el("div", { class: "tdates sub2" }, [
      t.firstTouch ? `First touch ${shortDate(t.firstTouch)} (${ago(t.firstTouch)})` : "No touches yet",
      t.lastTalk ? ` · last connected ${shortDate(t.lastTalk)} (${ago(t.lastTalk)})` : t.dials ? ` · no one's picked up yet (${n(t.dials, "try", "tries")})` : "",
    ]),
  ]);
}

// They told you they got the line card but never replied (Walt 9/29): a [Got it] note in Close, which the
// board and automatic emails read, so the account stops being a rescue call and moves on to RFQ check-ins.
function gotItButton(a) {
  if (["replied", "confirmed", "bounced"].includes(a.seen)) return null;
  const g = state.gotIt[a.leadId];
  return el("div", { class: "gotit" }, [
    el("button", { class: "btn small", disabled: g === "saving", text: g === "saving" ? "Saving…" : "They said they got it", onclick: async (e) => {
      e.stopPropagation();
      state.gotIt[a.leadId] = "saving"; render();
      try {
        await api(`/api/leads/${a.leadId}/linecard/got-it`, { name: a.contact.name || null });
        state.gotIt[a.leadId] = null;
        await load(true);
      } catch (err) { state.gotIt[a.leadId] = err.message; render(); }
    } }),
    el("span", { class: "sub2", text: g && g !== "saving" ? `Couldn't save: ${g}` : "Saves a [Got it] note in Close. Use it when they confirm on a call but don't reply to the email." }),
  ]);
}

// ---------- the rescue call: the email is drafted in Close; call from Close and send it there ----------

// Instructions only: sending and "did they find it?" happen in the side panel, on the call.
function rescueSteps(a) {
  return el("div", { class: "rescuebox" }, [
    el("ol", { class: "steps" }, [
      el("li", {}, [el("a", { href: closeLead(a.leadId), target: "_blank", rel: "noopener", text: `Open ${a.company} in Close` }), " with the Chrome extension open, and call ", el("strong", { text: a.contact.name || "the buyer" }), a.contact.phone ? [" at ", el("span", { class: "mono", text: prettyPhone(a.contact.phone) })] : null, "."]),
      el("li", {}, [a.rescueDraft ? "The rescue email is ready (a reply in the same thread, line card attached)." : "The rescue email is being drafted; it'll be ready in a minute.", " Once you have them on the phone, hit ", el("strong", { text: "Send now" }), " in the Chrome extension."]),
      el("li", {}, ["Tell them: ", el("em", { text: `"Check your inbox. If it's not there, check spam and click Not spam."` }), " Then mark whether they found it, in the Chrome extension."]),
    ]),
  ]);
}

// ---------- bump: a short follow-up in the same thread, saved as a draft ----------

async function writeFollowUp(leadId, force) {
  state.followUps[leadId] = { busy: true };
  render();
  try {
    const r = await api(`/api/leads/${leadId}/follow-up`, { force });
    state.followUps[leadId] = r.status === "warn" ? { warn: r.warning } : { done: r };
  } catch (e) {
    state.followUps[leadId] = { error: e.message };
  }
  render();
}

function followUpBox(a, fu) {
  if (fu.warn) return el("div", { class: "fu warn" }, [fu.warn, " ", el("button", { class: "btn small", text: "Write it anyway", onclick: () => writeFollowUp(a.leadId, true) })]);
  if (fu.error) return el("div", { class: "fu err", text: fu.error });
  return el("div", { class: "fu" }, [
    el("p", { class: "label", text: `Draft saved in Close · to ${fu.done.to}${fu.done.threaded ? " · same thread" : ""}` }),
    el("p", { style: "margin-top:6px", text: fu.done.body }),
  ]);
}


// ---------- automatic emails: what's going out today and why, what went out, what didn't ----------

const MAIL_TABS = [["upcoming", "Coming up"], ["sent", "Sent"], ["other", "Skipped / held"]];
const dayOf = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

// Coming up = already scheduled in Close (exact time) + what will be scheduled if nothing changes (the day).
function mailRows(au, tab) {
  if (tab === "upcoming") {
    return [
      ...au.upcoming.map((m) => ({ ...m, sortAt: m.scheduledFor || "" })),
      ...(au.future || []).map((f) => ({ id: `future_${f.leadId}`, future: true, leadId: f.leadId, company: f.company, to: f.to || "", subject: f.label, label: f.label, reason: f.reason, status: "planned", scheduledFor: f.sendOn, sortAt: f.sendOn, meme: f.meme, preview: f.preview })),
    ].sort((a, b) => a.sortAt.localeCompare(b.sortAt));
  }
  if (tab === "other") {
    return [...au.other, ...(au.held || []).map((f) => ({ id: `held_${f.leadId}`, heldRow: true, leadId: f.leadId, company: f.company, to: f.to || "", subject: f.label, label: f.label, reason: f.reason, status: "held", statusAt: null, heldUntil: f.heldUntil || null, heldWhy: f.heldWhy || null }))];
  }
  return au[tab] || [];
}
const timeOf = (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
const STATUS_TEXT = { planned: "Planned", scheduled: "Scheduled", sent: "Sent", skipped: "Skipped", stopped: "Pulled back", failed: "Didn't write", held: "On hold" };

async function reloadAutos() {
  state.autos = await api("/api/automations").catch(() => state.autos);
  render();
}

// ---------- the meme library (Walt 10/5): upload a file or a zip, rename, retire ----------
async function loadLibrary() {
  state.lib = { ...(state.lib || {}), busy: true };
  try { const r = await api("/api/memes"); state.lib = { memes: r.memes, tracking: !!r.tracking, busy: false, msg: state.lib.msg || null, rename: null }; }
  catch (e) { state.lib = { memes: [], busy: false, msg: e.message, rename: null }; }
  render();
}

// Picked files land in a staging list first: a zip is unpacked right here, each image gets a preview, a name you
// can change, and a Remove. Nothing reaches the bucket until "Upload these".
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const cleanStem = (n) => n.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const extOf = (n) => (n.match(/\.([a-z0-9]+)$/i) || [, "jpg"])[1].toLowerCase();

async function stageMemeFiles(files) {
  const lib = state.lib;
  lib.staged = lib.staged || [];
  lib.msg = null;
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      let entries;
      try { entries = fflate.unzipSync(new Uint8Array(await f.arrayBuffer())); } catch { lib.msg = `${f.name} couldn't be opened as a zip.`; continue; }
      for (const [entry, data] of Object.entries(entries)) {
        const base = entry.split("/").pop() || "";
        if (!base || base.startsWith(".") || entry.includes("__MACOSX") || !IMAGE_EXT.test(base) || !data.length) continue;
        lib.staged.push({ id: Math.random().toString(36).slice(2), stem: cleanStem(base), ext: extOf(base), blob: new Blob([data]), url: null, size: data.length });
      }
    } else if (IMAGE_EXT.test(f.name)) {
      lib.staged.push({ id: Math.random().toString(36).slice(2), stem: cleanStem(f.name), ext: extOf(f.name), blob: f, url: null, size: f.size });
    } else {
      lib.msg = `${f.name}: not an image or a zip.`;
    }
  }
  for (const st of lib.staged) if (!st.url) st.url = URL.createObjectURL(st.blob);
  render();
}

async function uploadStaged() {
  const lib = state.lib;
  const files = lib.staged.filter((st) => st.stem);
  lib.busy = true; lib.msg = `Uploading ${files.length}…`; render();
  const added = [];
  try {
    for (const st of files) {
      const name = `${st.stem}.${st.ext}`;
      const res = await fetch(`/api/memes/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: st.blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${name}: ${data.error || `Error ${res.status}`}`);
      added.push(...data.added);
    }
    for (const st of lib.staged) URL.revokeObjectURL(st.url);
    lib.staged = [];
    lib.msg = `Added ${added.length}: ${added.join(", ")}`;
  } catch (e) { lib.msg = e.message; }
  await loadLibrary();
}

function stagingArea(lib) {
  const staged = lib.staged || [];
  if (!staged.length) return null;
  const dupes = new Set(staged.map((st) => `${st.stem}.${st.ext}`).filter((n, i, all) => all.indexOf(n) !== i));
  const taken = new Set(lib.memes.map((m) => m.name));
  return el("div", { class: "staging" }, [
    el("div", { class: "head" }, [
      el("h3", { text: `Ready to upload · ${staged.length}` }),
      el("div", { class: "row" }, [
        el("button", { class: "btn small", text: "Clear", onclick: () => { for (const st of staged) URL.revokeObjectURL(st.url); lib.staged = []; render(); } }),
        el("button", { class: "btn small primary", disabled: lib.busy || !staged.length || dupes.size > 0, text: lib.busy ? "Uploading…" : `Upload ${staged.length}`, onclick: uploadStaged }),
      ]),
    ]),
    el("p", { class: "muted small3", text: "Name each one (this is what you'll see when picking a meme), remove the ones you don't want, then upload." }),
    dupes.size ? el("p", { class: "small3 libmsg", text: `Two have the same name: ${[...dupes].join(", ")}. Change one.` }) : null,
    el("div", { class: "memegrid lib" }, staged.map((st) => el("div", { class: `memecard${dupes.has(`${st.stem}.${st.ext}`) ? " dupe" : ""}` }, [
      el("img", { src: st.url, alt: st.stem }),
      el("input", { class: "rename", value: st.stem, placeholder: "name", oninput: (e) => { st.stem = cleanStem(e.target.value + ".x"); }, onblur: () => render() }),
      el("div", { class: "meta" }, [
        el("span", { class: "mono muted", text: `${taken.has(`${st.stem}.${st.ext}`) ? "replaces · " : ""}${(st.size / 1024).toFixed(0)} KB${st.size > 5 * 1024 * 1024 ? " · too big" : ""}` }),
        el("button", { class: "linkbtn small3", text: "Remove", onclick: () => { URL.revokeObjectURL(st.url); lib.staged = staged.filter((x) => x !== st); render(); } }),
      ]),
    ]))),
  ]);
}

function memeLibrary() {
  if (!state.lib) { state.lib = { memes: [], busy: true, msg: null, rename: null }; loadLibrary(); }
  const lib = state.lib;
  const pick = () => {
    const input = el("input", { type: "file", accept: ".zip,image/*", multiple: true, style: "display:none", onchange: (e) => { if (e.target.files.length) stageMemeFiles([...e.target.files]); } });
    document.body.append(input); input.click(); setTimeout(() => input.remove(), 60000);
  };
  const stem = (n) => n.replace(/\.[a-z0-9]+$/i, "");
  const commitRename = async (m) => {
    const to = (lib.rename.value || "").trim();
    lib.rename = null;
    if (!to || to === stem(m.name)) return render();
    lib.busy = true; render();
    try { const r = await api("/api/memes/rename", { from: m.name, to }); lib.msg = `Renamed to ${r.name}`; } catch (e) { lib.msg = e.message; }
    await loadLibrary();
  };
  const retire = async (m) => {
    if (!confirm(`Retire ${m.name}? It leaves the rotation; what's already been sent stays on record.`)) return;
    lib.busy = true; render();
    try { await api("/api/memes/delete", { name: m.name }); lib.msg = `Retired ${m.name}`; } catch (e) { lib.msg = e.message; }
    await loadLibrary();
  };
  return el("section", { class: "library", ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); }, ondragleave: (e) => e.currentTarget.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); if (e.dataTransfer.files.length) stageMemeFiles([...e.dataTransfer.files]); } }, [
    el("div", { class: "head" }, [
      el("h2", { text: `Memes · ${lib.memes.length}` }),
      el("button", { class: "btn small", disabled: lib.busy, text: lib.busy ? "Working…" : "Add images or a zip", onclick: pick }),
    ]),
    stagingArea(lib),
    el("p", { class: "muted small3", text: "One per bump, never the same one twice to a company. Drop files here, or a zip and it unpacks. Click a name to rename it (everything that remembers the old name follows). Keep them under 5 MB." }),
    lib.msg ? el("p", { class: "small3 libmsg", text: lib.msg }) : null,
    !lib.memes.length && !lib.busy ? el("p", { class: "empty", text: "No memes yet. Upload a zip to start." }) : el("div", { class: "memegrid lib" }, lib.memes.map((m) => el("div", { class: "memecard" }, [
      el("img", { src: m.url, alt: m.name, loading: "lazy" }),
      lib.rename && lib.rename.name === m.name
        ? el("input", { class: "rename", value: lib.rename.value, autofocus: true, oninput: (e) => { lib.rename.value = e.target.value; },
          onkeydown: (e) => { if (e.key === "Enter") commitRename(m); if (e.key === "Escape") { lib.rename = null; render(); } }, onblur: () => commitRename(m) })
        : el("button", { class: "name", title: "Rename", text: stem(m.name), onclick: () => { lib.rename = { name: m.name, value: stem(m.name) }; render(); } }),
      el("div", { class: "meta" }, [
        el("span", { class: "mono muted", title: "Sent: Close has sent it. Queued: scheduled in Close, not out yet.", text: [m.sent ? `sent ${m.sent}` : null, m.queued ? `queued ${m.queued}` : null].filter(Boolean).join(" · ") || "not used yet" }),
        el("button", { class: "linkbtn small3", text: "Retire", onclick: () => retire(m) }),
      ]),
      m.stats && m.stats.sent ? el("div", { class: "mstats", title: "Of the companies that got this meme in a bump: opened the email, wrote back, sent an RFQ, within 2 weeks. Seen: the meme image loaded in their mail app. Clicked: they followed the link under it." }, [
        // Seen and clicked only once tracking is on (a Westgate domain): until then they'd read 0% and crowd the card.
        ["opened", m.stats.opened], ["replied", m.stats.replied], ["RFQ", m.stats.rfq], ...(lib.tracking && m.stats.tracked ? [["seen", m.stats.shown], ["clicked", m.stats.clicked]] : []),
      ].map(([k, v]) => el("span", { class: v ? "good" : "" }, [el("b", { class: "mono", text: `${Math.round((v / (k === "seen" || k === "clicked" ? m.stats.tracked : m.stats.sent)) * 100)}%` }), ` ${k}`]))) : null,
    ]))),
  ]);
}

function emailsSection() {
  const au = state.autos;
  const toggle = async () => {
    state.mailBusy = true; render();
    await api("/api/automations/toggle", { enabled: !au.enabled }).catch((e) => alert(e.message));
    state.mailBusy = false;
    reloadAutos();
  };
  const planNow = async () => {
    state.mailBusy = true; render();
    try {
      const r = await api("/api/automations/plan", {});
      // Always say what happened, including "nothing's due yet, next one is Mercer on Sep 30".
      const next = ((state.board && state.board.accounts) || []).filter((a) => a.next.kind === "waiting" && /^Bump /.test(a.next.label) && a.next.due).sort((a, b) => a.next.due.localeCompare(b.next.due))[0];
      const lines = [
        r.planned.length ? `Scheduled ${r.planned.length} bump${r.planned.length === 1 ? "" : "s"}. They're under Going out.` : `No bumps are due today.${next ? ` The next one is ${next.company}, ${shortDate(next.next.due)}.` : ""}`,
        ...(r.skipped || []).map((x) => `Not scheduled, ${x.company}: ${x.why}`),
      ];
      alert(lines.join("\n"));
    } catch (e) { alert(e.message); }
    state.mailBusy = false;
    await reloadAutos();
    load(true);
  };
  const rows = au ? mailRows(au, state.mailTab) : [];
  return el("section", {}, [
    el("div", { class: "head pagehead" }, [
      el("h1", { class: "ptitle", text: "Automatic emails" }),
      au ? el("div", { class: "acts" }, [
        el("span", { class: `switch${au.enabled ? " on" : ""}` }, [el("i"), au.enabled ? "On" : "Off"]),
        el("button", { class: "btn small", disabled: state.mailBusy, text: au.enabled ? "Turn off" : "Turn on", onclick: toggle }),
        el("button", { class: "btn small", disabled: state.mailBusy, text: state.mailBusy ? "Working…" : "Plan bumps now", onclick: planNow }),
      ]) : null,
    ]),
    au && !au.enabled ? el("p", { class: "offnote", text: "Automatic emails are off. Coming up shows what would go out; nothing sends until you turn them on." }) : null,
    // Test mode (10/1): only Test Lead Fabrication gets them until it's turned off.
    au && au.testMode ? el("div", { class: "testnote" }, [
      el("p", {}, [el("strong", { text: "Test mode: " }), "each morning, one bump goes to ", el("strong", { text: "Test Lead Fabrication" }), " only, with its meme, so you can see how it lands. No real company gets anything. Coming up shows what would go out once test mode is off."]),
      el("button", { class: "btn small", disabled: state.mailBusy, text: "Turn off test mode", onclick: async () => {
        if (!confirm("Turn off test mode? From the next morning run, the bumps in Coming up go to the real companies.")) return;
        state.mailBusy = true; render();
        await api("/api/automations/test-mode", { on: false }).catch((e) => alert(e.message));
        state.mailBusy = false; reloadAutos();
      } }),
    ]) : au ? el("button", { class: "linkbtn", text: "Back to test mode", onclick: async () => { await api("/api/automations/test-mode", { on: true }).catch((e) => alert(e.message)); reloadAutos(); } }) : null,
    au ? el("p", { class: "muted small3", text: `Bumps are written each weekday morning, scheduled in Close for a random minute between 8:11 and 11am their time, and re-checked just before they go: if they've written in, it's pulled back. Up to ${au.dailyCap} a day. Skip any you don't want.` }) : null,
    el("div", { class: "tabs" }, MAIL_TABS.map(([k, label]) => el("button", {
      class: `tab${state.mailTab === k ? " on" : ""}`, onclick: () => { state.mailTab = k; render(); },
    }, [label, el("span", { class: "c mono", text: au ? mailRows(au, k).length : "–" })]))),
    !au ? el("p", { class: "loading", text: "Loading…" })
      : !rows.length ? el("p", { class: "empty", text: { upcoming: "No automatic emails due in the next two weeks.", sent: "Nothing sent automatically in the last week.", other: "Nothing skipped or stopped." }[state.mailTab] })
        : el("div", { class: "grid x3d" }, [
          el("div", { class: "gr mgr gh" }, ["When", "Account", "To", "Why", "Status", ""].map((h) => el("span", { class: "label", text: h }))),
          ...rows.flatMap(mailRow),
        ]),
    memeLibrary(),
  ]);
}

function mailRow(m) {
  const open = !!state.mailOpen[m.id];
  const when = m.status === "sent" ? m.statusAt : ["scheduled", "planned"].includes(m.status) ? m.scheduledFor : m.statusAt;
  const hold = async (e, on, days) => { e.stopPropagation(); e.currentTarget.disabled = true; await api(`/api/leads/${m.leadId}/hold`, { hold: on, days: days || null }).catch((err) => alert(err.message)); await reloadAutos(); load(true); };
  const row = el("div", { class: `gr mgr${open ? " open" : ""}`, onclick: () => { state.mailOpen[m.id] = !open; render(); } }, [
    m.future ? el("span", { class: "whenf" }, [el("span", { class: "mono", text: dayOf(when) }), el("span", { class: "sub2", text: "8:11–11am their time" })])
      : el("span", { class: "mono", text: when ? timeOf(when) : "–" }),
    el("div", { class: "acct macct" }, [
      m.future && m.meme ? el("img", { class: "memethumb", src: m.meme.url, alt: "", loading: "lazy" }) : null,
      el("div", {}, [
        el("a", { class: "co", href: closeLead(m.leadId), target: "_blank", rel: "noopener", text: m.company, onclick: (e) => e.stopPropagation() }),
        el("span", { class: "sub2", text: m.subject }),
      ]),
    ]),
    el("span", { class: "sub2", text: m.to }),
    el("span", { class: "next", text: m.label }),
    el("span", { class: `mstatus ${m.status}`, text: STATUS_TEXT[m.status] || m.status }),
    el("div", { class: "acts" }, [
      ...(m.future ? [el("span", { class: "muted small3", text: "Cool off" }), ...COOL_OPTIONS.map(([days, label]) => el("button", { class: days ? "btn small" : "linkbtn small3", text: label, title: days ? `Out of the automatic emails for ${label}, then back in on their own` : "Out until you put them back", onclick: (e) => hold(e, true, days) }))] : []),
      m.heldRow ? el("button", { class: "btn small", text: "Put back", onclick: (e) => hold(e, false) }) : null,
      m.status === "scheduled" ? el("button", {
        class: "btn small", text: "Skip",
        onclick: async (e) => { e.stopPropagation(); e.currentTarget.disabled = true; await api(`/api/automations/${m.id}/skip`, {}).catch((err) => alert(err.message)); reloadAutos(); },
      }) : null,
      el("span", { class: "chev", "aria-hidden": "true", text: open ? "▴" : "▾" }),
    ]),
  ]);
  if (!open) return [row];
  return [row, el("div", { class: "detail" }, [
    el("p", { class: "why" }, [el("strong", { text: "Why: " }), m.reason]),
    m.future ? el("p", { class: "why muted", text: "It's scheduled that morning as a reply in their thread. It won't go out if they reply, send a file, or you book a callback first." }) : null,
    m.future && m.preview ? bumpPreview(m) : null,
    m.heldRow ? el("p", { class: "why muted", text: m.heldUntil ? `Cooling off until ${dayOf(m.heldUntil)}${m.heldWhy ? ` (${m.heldWhy})` : ""}; back in the automatic emails on its own after that. Put back to end it early.` : `On hold${m.heldWhy ? ` (${m.heldWhy})` : ""}: no automatic emails until you put them back.` }) : null,
    m.note ? el("p", { class: "why muted", text: m.note }) : null,
    m.body ? el("div", { class: "draft" }, [el("p", { class: "label", text: `To ${m.to} · ${m.subject}` }), el("p", { class: "body", text: m.body })]) : null,
  ])];
}

// ---------- the bump as it'll look, with its meme and a picker (9/30) ----------
// A company never gets a meme twice: ones they've had are greyed out.

function bumpPreview(m) {
  const paras = m.preview.split(/\n\s*\n/);
  const sig = paras.pop();
  const pick = state.memePick && state.memePick.leadId === m.leadId ? state.memePick : null;
  const choose = async (name) => {
    try { await api("/api/automations/meme", { lead_id: m.leadId, meme: name }); state.memePick = null; await reloadAutos(); }
    catch (err) { alert(err.message); }
  };
  const openPicker = async (e) => {
    e.stopPropagation();
    state.memePick = { leadId: m.leadId, loading: true }; render();
    try { const r = await api(`/api/memes?lead=${encodeURIComponent(m.leadId)}`); state.memePick = { leadId: m.leadId, memes: r.memes }; }
    catch (err) { state.memePick = { leadId: m.leadId, error: err.message }; }
    render();
  };
  return el("div", { class: "bumpprev", onclick: (e) => e.stopPropagation() }, [
    el("p", { class: "label", text: `The email · reply in their thread to ${m.to}` }),
    el("div", { class: "bumpmail" }, [
      ...paras.map((p) => el("p", { text: p })),
      m.meme ? el("img", { class: "memeimg", src: m.meme.url, alt: "" }) : el("p", { class: "sub2", text: "(no meme)" }),
      el("p", { text: sig }),
    ]),
    el("div", { class: "row" }, [
      el("button", { class: "btn small", text: pick ? "Close" : m.meme ? "Change meme" : "Add a meme", onclick: pick ? (e) => { e.stopPropagation(); state.memePick = null; render(); } : openPicker }),
      m.meme ? el("button", { class: "linkbtn", text: "No meme", onclick: (e) => { e.stopPropagation(); choose(null); } }) : null,
    ]),
    pick ? (pick.loading ? el("p", { class: "loading", text: "Loading memes…" })
      : pick.error ? el("p", { class: "err", text: pick.error })
        : !pick.memes.length ? el("p", { class: "sub2", text: "No memes yet. Drop image files in server/memes and reopen this." })
          : el("div", { class: "memegrid" }, pick.memes.map((mm) => el("button", {
            class: `memeopt${mm.seen ? " seen" : ""}${m.meme && m.meme.name === mm.name ? " on" : ""}`,
            disabled: mm.seen, title: mm.seen ? "Already sent to them" : mm.name,
            onclick: (e) => { e.stopPropagation(); choose(mm.name); },
          }, [el("img", { src: mm.url, alt: mm.name, loading: "lazy" }), mm.seen ? el("span", { text: "sent" }) : null])))) : null,
  ]);
}

// Start last, once everything above is defined.
if (token) load(); else render();
