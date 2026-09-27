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
  tab: "now", open: {}, followUps: {}, error: null,
  mailTab: "upcoming", mailOpen: {}, mailBusy: false,
  page: location.hash === "#emails" ? "emails" : "accounts",
  period: (() => { try { return localStorage.getItem("westgate.period") || "today"; } catch { return "today"; } })(),
  periods: {}, // period -> stats (loaded when picked)
  drill: null, // the stat whose rows are showing, e.g. "dials"
  details: {}, // `${period}:${metric}` -> table
};

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
  const results = await Promise.allSettled([api("/api/me"), api("/api/stats/today"), api(`/api/accounts${fresh ? "?fresh=1" : ""}`), api("/api/automations")]);
  const [me, today, board, autos] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
  Object.assign(state, { me, today, board, autos });
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
  $app.replaceChildren(topBar(), el("main", {}, state.page === "emails"
    ? [err, emailsSection()]
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
    el("nav", { class: "nav" }, [["accounts", "Accounts"], ["emails", "Automatic emails"]].map(([k, label]) => el("button", {
      class: state.page === k ? "on" : "", onclick: () => go(k),
    }, [label, k === "emails" && state.autos ? el("span", { class: "navc mono", text: mailRows(state.autos, "upcoming").length }) : null]))),
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
  history.replaceState(null, "", page === "emails" ? "#emails" : "#");
  window.scrollTo(0, 0);
  render();
}
window.addEventListener("hashchange", () => { state.page = location.hash === "#emails" ? "emails" : "accounts"; render(); });

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"; };
const NOW_KINDS = ["reply", "quote", "call_due", "rescue", "bump"];

function hello() {
  const name = state.me ? state.me.rep.name.split(" ")[0] : "";
  const c = state.board && state.board.counts;
  const now = c ? NOW_KINDS.reduce((n, k) => n + c[k], 0) : null;
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

const TABS = [
  ["now", "Needs you", (a) => NOW_KINDS.includes(a.next.kind)],
  ["scheduled", "Upcoming tasks", (a) => a.next.kind === "scheduled"],
  ["waiting", "Waiting on them", (a) => a.next.kind === "waiting"],
  ["all", "All", () => true],
];
const SEEN = {
  bounced: ["Bounced", "s-bounced"],
  replied: ["Replied", "s-replied"],
  confirmed: ["Has it", "s-has"],
  opened: ["Opened", "s-opened"],
  maybe: ["Maybe opened", "s-maybe"],
  not_opened: ["Not opened", "s-not"],
};
const EVENT_ICON = { auto: "⟳", line_card: "✉", email: "✉", reply: "↩", rfq: "★", quote: "$", opened: "◉", filter: "⚠", call: "☎", note: "✎" };

function accountsSection() {
  const all = (state.board && state.board.accounts) || [];
  const [, , filter] = TABS.find(([k]) => k === state.tab) || TABS[0];
  const shown = all.filter(filter);
  return el("section", {}, [
    el("div", { class: "head" }, [el("h2", { text: "Accounts" })]),
    el("div", { class: "tabs" }, TABS.map(([k, label, f]) => {
      const n = all.filter(f).length;
      return el("button", { class: `tab${state.tab === k ? " on" : ""}${k === "now" && n ? " alert" : ""}`, onclick: () => { state.tab = k; render(); } }, [label, el("span", { class: "c mono", text: n })]);
    })),
    !state.board ? el("p", { class: "loading", text: "Reading your accounts from Close…" })
      : !shown.length ? el("p", { class: "empty", text: state.tab === "now" ? "Nothing needs you right now." : "None here." })
        : el("div", { class: "grid x3d" }, [
          el("div", { class: "gr gh" }, ["Account", "Phone", "Line card", "Goal", "Last activity", ""].map((h) => el("span", { class: "label", text: h }))),
          ...shown.flatMap(accountRow),
        ]),
  ]);
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
    el("p", { class: "why" }, a.next.detail),
    a.next.rescue ? rescueSteps(a) : null,
    fu && !fu.busy ? followUpBox(a, fu) : null,
    el("ol", { class: "timeline" }, a.events.map((e) => el("li", { class: `ev ${e.kind}` }, [
      el("span", { class: "ic", "aria-hidden": "true", text: EVENT_ICON[e.kind] || "•" }),
      el("span", { class: "when mono", text: shortDate(e.at) }),
      el("span", { class: "what", text: e.text }),
    ]))),
  ])];
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
      ...(au.future || []).map((f) => ({ id: `future_${f.leadId}`, future: true, leadId: f.leadId, company: f.company, to: f.to || "", subject: f.label, label: f.label, reason: f.reason, status: "planned", scheduledFor: f.sendOn, sortAt: f.sendOn })),
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
    el("div", { class: "acct" }, [
      el("a", { class: "co", href: closeLead(m.leadId), target: "_blank", rel: "noopener", text: m.company, onclick: (e) => e.stopPropagation() }),
      el("span", { class: "sub2", text: m.subject }),
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
    m.future ? el("p", { class: "why muted", text: "The email is written that morning, from the latest thread and notes, and scheduled then. It won't go out if they reply, send a file, or you book a callback first." }) : null,
    m.heldRow ? el("p", { class: "why muted", text: "On hold: this account never gets automatic emails. Resume to put it back." }) : null,
    m.note ? el("p", { class: "why muted", text: m.note }) : null,
    m.body ? el("div", { class: "draft" }, [el("p", { class: "label", text: `To ${m.to} · ${m.subject}` }), el("p", { class: "body", text: m.body })]) : null,
  ])];
}

// Start last, once everything above is defined.
if (token) load(); else render();
