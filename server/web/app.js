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
  period: (() => { try { return localStorage.getItem("westgate.period") || "today"; } catch { return "today"; } })(),
  periods: {}, // period -> stats (loaded when picked)
  drill: null, // the stat whose rows are showing, e.g. "dials"
  details: {}, // `${period}:${metric}` -> table
};

function pageFromHash() { return location.hash === "#emails" ? "emails" : location.hash === "#rfqs" ? "rfqs" : "accounts"; }

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

async function load(fresh = false) {
  state.error = null;
  render();
  const results = await Promise.allSettled([api("/api/me"), api("/api/stats/today"), api(`/api/accounts${fresh ? "?fresh=1" : ""}`), api("/api/automations"), api(`/api/stats/rfqs${fresh ? "?fresh=1" : ""}`)]);
  const [me, today, board, autos, rfqLine] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
  Object.assign(state, { me, today, board, autos, rfqLine });
  const failed = results.find((r) => r.status === "rejected");
  if (failed && failed.reason.message !== "Signed out") state.error = failed.reason.message;
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
    el("nav", { class: "nav" }, [["accounts", "Accounts"], ["rfqs", "RFQs"], ["emails", "Automatic emails"]].map(([k, label]) => el("button", {
      class: state.page === k ? "on" : "", onclick: () => go(k),
    }, [label,
      k === "emails" && state.autos ? el("span", { class: "navc mono", text: mailRows(state.autos, "upcoming").length }) : null,
      k === "rfqs" && state.board ? el("span", { class: "navc mono", text: state.board.accounts.filter((a) => a.rfq).length }) : null,
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
  const all = (state.board && state.board.accounts) || [];
  const head = () => el("div", { class: "gr gh" }, ["Account", "Phone", "Line card", "Goal", "Last activity", ""].map((h) => el("span", { class: "label", text: h })));
  const groups = SECTIONS.map(([k, title, sub]) => {
    const rows = all.filter((a) => a.section === k);
    if (!rows.length) return null;
    const later = k === "later" || k === "today" || k === "rest"; // collapsed until you open them
    const shut = later && !state.showSect[k];
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
    el("div", { class: "head" }, [el("h2", { text: "Accounts" })]),
    !state.board ? el("p", { class: "loading", text: "Reading your accounts from Close…" })
      : !all.length ? el("p", { class: "empty", text: "None here." })
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
      el("span", { class: "sub2", text: c.name || c.email || "" }),
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
    return [...au.other, ...(au.held || []).map((f) => ({ id: `held_${f.leadId}`, heldRow: true, leadId: f.leadId, company: f.company, to: f.to || "", subject: f.label, label: f.label, reason: f.reason, status: "held", statusAt: null }))];
  }
  return au[tab] || [];
}
const timeOf = (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
const STATUS_TEXT = { planned: "Planned", scheduled: "Scheduled", sent: "Sent", skipped: "Skipped", stopped: "Pulled back", failed: "Didn't write", held: "On hold" };

async function reloadAutos() {
  state.autos = await api("/api/automations").catch(() => state.autos);
  render();
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
    au ? el("p", { class: "muted small3", text: `Bumps are written each weekday morning, scheduled in Close for 9 to 11am their time, and re-checked just before they go: if they've written in, it's pulled back. Up to ${au.dailyCap} a day. Skip any you don't want.` }) : null,
    el("div", { class: "tabs" }, MAIL_TABS.map(([k, label]) => el("button", {
      class: `tab${state.mailTab === k ? " on" : ""}`, onclick: () => { state.mailTab = k; render(); },
    }, [label, el("span", { class: "c mono", text: au ? mailRows(au, k).length : "–" })]))),
    !au ? el("p", { class: "loading", text: "Loading…" })
      : !rows.length ? el("p", { class: "empty", text: { upcoming: "No automatic emails due in the next two weeks.", sent: "Nothing sent automatically in the last week.", other: "Nothing skipped or stopped." }[state.mailTab] })
        : el("div", { class: "grid x3d" }, [
          el("div", { class: "gr mgr gh" }, ["When", "Account", "To", "Why", "Status", ""].map((h) => el("span", { class: "label", text: h }))),
          ...rows.flatMap(mailRow),
        ]),
  ]);
}

function mailRow(m) {
  const open = !!state.mailOpen[m.id];
  const when = m.status === "sent" ? m.statusAt : ["scheduled", "planned"].includes(m.status) ? m.scheduledFor : m.statusAt;
  const hold = async (e, on) => { e.stopPropagation(); e.currentTarget.disabled = true; await api(`/api/leads/${m.leadId}/hold`, { hold: on }).catch((err) => alert(err.message)); await reloadAutos(); load(true); };
  const row = el("div", { class: `gr mgr${open ? " open" : ""}`, onclick: () => { state.mailOpen[m.id] = !open; render(); } }, [
    m.future ? el("span", { class: "whenf" }, [el("span", { class: "mono", text: dayOf(when) }), el("span", { class: "sub2", text: "9–11am their time" })])
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
      m.future ? el("button", { class: "btn small", text: "Hold", title: "Never send this account automatic emails", onclick: (e) => hold(e, true) }) : null,
      m.heldRow ? el("button", { class: "btn small", text: "Resume", onclick: (e) => hold(e, false) }) : null,
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
    m.heldRow ? el("p", { class: "why muted", text: "On hold: this account never gets automatic emails. Resume to put it back." }) : null,
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
