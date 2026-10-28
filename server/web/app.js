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
  mailTab: "upcoming", mailOpen: {}, mailBusy: false, mailStage: null, mailDay: null, heatTag: null, heatOpen: {},
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

function pageFromHash() { return location.hash === "#team" ? "team" : location.hash === "#extension" ? "extension" : location.hash === "#guests" ? "guests" : location.hash === "#emails" ? "emails" : location.hash === "#rfqs" ? "rfqs" : location.hash === "#heat" ? "heat" : location.hash === "#tasks" ? "tasks" : location.hash === "#game" ? "game" : "accounts"; }

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
  // Each one draws the moment it arrives (10/8): the RFQ count no longer waits on the automatic emails list.
  const piece = (path, key) => apiRetry(path).then((v) => { state[key] = v; render(); return v; });
  const results = await Promise.allSettled([piece("/api/stats/today", "today"), piece("/api/automations", "autos"), piece("/api/tasks", "tasks"), piece(`/api/stats/rfqs${fresh ? "?fresh=1" : ""}`, "rfqLine"),
    // The team's RFQs (10/19), for the RFQs page; it never blocks the rest or shows an error of its own.
    piece(`/api/team/rfqs${fresh ? "?fresh=1" : ""}`, "teamRfq").catch(() => null)]);
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

// ---------- keeping the Chrome extension current (Walt 10/26: "there needs to be an update extension in the app") ----------
// The extension tells this page its version (bridge.js); the server knows the newest one it hands out.
const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
const installedExt = () => document.documentElement.dataset.westgateExt || null;
window.addEventListener("westgate:ext", () => { if (token) render(); });
function loadExtInfo() {
  if (state.ext === undefined) { state.ext = null; api("/api/extension").then((r) => { state.ext = r; render(); }).catch((e) => { state.ext = { error: e.message }; render(); }); }
}
/** True when this computer's extension is older than the one the app hands out. */
function extBehind() { const have = installedExt(), latest = state.ext && state.ext.version; return !!(have && latest && newer(latest, have)); }
// One-click update (Walt 10/26: "when you click it, it makes sure the files you have locally are the newest"). Chrome
// lets a page write into a folder the person picks: the first time they pick their westgate-assistant folder, then the
// app remembers it, writes the newest files into it, and asks the extension to reload itself.
const kv = (() => {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open("westgate", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const run = async (mode, fn) => { const d = await db(); return new Promise((res) => { const q = fn(d.transaction("kv", mode).objectStore("kv")); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); }); };
  return { get: (k) => run("readonly", (st) => st.get(k)).catch(() => null), set: (k, v) => run("readwrite", (st) => st.put(v, k)).catch(() => null) };
})();
/** The extension's folder at or under the one picked, up to two levels down (Downloads → westgate-assistant-extension → westgate-assistant). */
async function findExtFolder(dir, depth = 2) {
  if (await isExtFolder(dir)) return dir;
  if (depth === 0) return null;
  const kids = [];
  try { for await (const [name, h] of dir.entries()) if (h.kind === "directory" && !name.startsWith(".")) kids.push([name, h]); } catch { return null; }
  // Likely names first, so a big Downloads folder is quick.
  kids.sort(([a], [b]) => (/westgate/i.test(b) ? 1 : 0) - (/westgate/i.test(a) ? 1 : 0));
  for (const [, h] of kids.slice(0, 200)) { const hit = await findExtFolder(h, depth - 1); if (hit) return hit; }
  return null;
}
const isExtFolder = async (dir) => {
  try { const m = JSON.parse(await (await (await dir.getFileHandle("manifest.json")).getFile()).text()); return m.name === "Westgate Sales Assistant"; } catch { return false; }
};
// Tell the server how an update went, so a failure on a teammate's computer can be read without a screenshot.
function reportUpdate(outcome, detail) {
  api("/api/extension/update-report", { outcome, detail: String(detail || ""), picker: !!window.showDirectoryPicker, secure: !!window.isSecureContext,
    framed: window.top !== window, installed: installedExt(), ua: navigator.userAgent, url: location.href }).catch(() => {});
}
async function updateExtension() {
  if (state.upd && state.upd.busy) return;
  reportUpdate("clicked", "");
  // Say exactly why it can't, per browser (10/26: it worked on Walt's computer and sent a teammate to the download).
  if (!window.showDirectoryPicker) {
    const ua = navigator.userAgent;
    const why = navigator.brave ? "Brave has this turned off. Go to brave://flags, search \"File System Access API\", set it to Enabled, relaunch Brave, and click Update again."
      : /Firefox\//.test(ua) ? "Firefox can't update the extension from a page. Open this page in Google Chrome (where the extension is) and click Update there."
      : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? "Safari can't update the extension from a page. Open this page in Google Chrome (where the extension is) and click Update there."
      : !window.isSecureContext ? "This page has to be opened at https://sales-assist-fawn.vercel.app to update the extension."
      : "This browser can't update the extension from a page. Open this page in Google Chrome on a computer and click Update there.";
    state.upd = { error: why }; render(); reportUpdate("no-folder-access", why); return;
  }
  state.upd = { busy: true, text: "Getting your extension folder…" }; render();
  try {
    let dir = await kv.get("extDir");
    if (dir && dir.requestPermission && (await dir.requestPermission({ mode: "readwrite" })) !== "granted") dir = null;
    if (!dir) {
      state.upd = { busy: true, text: "Chrome is asking which folder: pick Downloads (or wherever you unzipped the extension). The app finds it inside." }; render();
      const picked = await window.showDirectoryPicker({ id: "westgate-ext", mode: "readwrite", startIn: "downloads" });
      state.upd = { busy: true, text: `Looking for the extension in "${picked.name}"…` }; render();
      dir = await findExtFolder(picked);
      if (!dir) throw new Error(`Couldn't find the extension in "${picked.name}". Click Update again and pick the folder you unzipped it into (usually Downloads).`);
    }
    if (!(await isExtFolder(dir))) throw new Error(`"${dir.name}" isn't the extension's folder anymore. Click Update again and pick Downloads.`);
    await kv.set("extDir", dir);
    state.upd = { busy: true, text: "Writing the newest files…" }; render();
    const { version, files } = await api("/api/extension/files");
    for (const f of files) {
      const parts = f.path.split("/");
      let here = dir;
      for (const p of parts.slice(0, -1)) here = await here.getDirectoryHandle(p, { create: true });
      const w = await (await here.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
      await w.close();
    }
    const couldReload = !!installedExt(); // 2.84 and later reload when asked; older ones need the button in chrome://extensions once
    if (couldReload) window.dispatchEvent(new CustomEvent("westgate:reload-ext"));
    reportUpdate("updated", `${version}, reload ${couldReload ? "automatic" : "by hand"}, folder ${dir.name}`);
    state.upd = { done: true, text: couldReload
      ? `Updated to ${version}. The extension restarted: close and reopen the side panel.`
      : `The files are updated to ${version}. One last time, go to chrome://extensions and click the reload arrow on Westgate Sales Assistant. After that, this button does it all.` };
    render();
    if (couldReload) setTimeout(() => { delete document.documentElement.dataset.westgateExt; location.reload(); }, 2500);
  } catch (e) {
    const name = e && e.name;
    reportUpdate(name === "AbortError" ? "cancelled" : "failed", `${name || "error"}: ${(e && e.message) || e}`);
    state.upd = name === "AbortError" ? null
      : name === "SecurityError" || name === "NotAllowedError" ? { error: `Chrome didn't allow it (${name}). Click Update again and choose "Allow" or "Edit files" when Chrome asks. If Chrome says it can't open that folder because it has system files, move the westgate-assistant folder into Documents, load it again in chrome://extensions, and try once more.` }
      : { error: `Couldn't update: ${e.message || String(e)} (${name || "error"}). Send Walt a screenshot of this.` };
    render();
  }
}
const updateButton = (cls = "btn primary") => el("button", { class: cls, disabled: !!(state.upd && state.upd.busy), text: state.upd && state.upd.busy ? "Updating…" : "Update extension", onclick: updateExtension });
const updateStatus = () => state.upd ? el("p", { class: state.upd.error ? "bad small" : state.upd.done ? "extok" : "muted small3", text: state.upd.error || state.upd.text }) : null;

function updateBanner() {
  if (state.page === "extension" || ((!extBehind() || state.extBannerOff === state.ext.version) && !state.upd)) return null;
  return el("div", { class: "extbanner" }, [
    el("span", {}, [el("b", { text: "Your Chrome extension is out of date. " }), `You have ${installedExt()}, the newest is ${state.ext.version}.`]),
    updateButton("btn small primary"), updateStatus(),
    el("button", { class: "linkbtn", text: "Later", onclick: () => { state.extBannerOff = state.ext.version; render(); } }),
  ]);
}

function render() {
  if (!token) return $app.replaceChildren(signIn());
  loadExtInfo();
  const err = state.error ? el("p", { class: "empty", text: `Couldn't load everything: ${state.error}` }) : null;
  // A sidebar (Walt 10/28): the pages down the left, you and the extension at the bottom; the page beside it.
  $app.replaceChildren(el("div", { class: "shell" }, [topBar(), el("div", { class: "content" }, [updateBanner() || "", el("main", {}, state.page === "emails" ? [err, emailsSection()]
    : state.page === "rfqs" ? [err, rfqsPage()]
    : state.page === "tasks" ? [err, tasksPage()]
    : state.page === "guests" ? [err, guestsPage()]
    : state.page === "extension" ? [extensionPage()]
    : state.page === "team" ? [teamPage()]
    : state.page === "game" ? [gamePage()]
      : state.page === "heat" ? [err, heatPage()]
        : [hello(), err, accountsSection()])])]));
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
    } else if (auth.step === "reset") {
      if (f.password.value !== f.confirm.value) throw new Error("Those passwords don't match.");
      done(await authPost("/api/auth/reset", { email: auth.email, password: f.password.value, close_api_key: f.key.value }));
    } else {
      if (f.password.value !== f.confirm.value) throw new Error("Those passwords don't match.");
      done(await authPost("/api/auth/signup", { email: auth.email, password: f.password.value, close_api_key: f.key ? f.key.value : undefined }));
    }
  });
  const enter = (e) => { if (e.key === "Enter") next(); };
  const field = (name, attrs) => (f[name] = el("input", { ...attrs, onkeydown: enter }));
  const title = { email: "Sign in", password: "Welcome back", reset: "New password", create: auth.needsCloseKey ? "Create your account" : "Set your password" }[auth.step];
  const intro = {
    email: "Use your Westgate email.",
    password: auth.email,
    reset: `Pick a new password for ${auth.email}. To prove it's you, paste your Close API key (in Close: Settings, then API Keys; you can make a new one there).`,
    create: auth.needsCloseKey
      ? `${auth.email} isn't connected to Close yet. Pick a password and paste your Close API key (Close → Settings → API Keys). It stays on the server.`
      : `First time here: pick a password for ${auth.email}.`,
  }[auth.step];
  const form = el("div", { class: "signin x3d" }, [
    el("img", { src: "brand/world-mark-filled.svg", alt: "", style: "height:28px;width:auto;align-self:flex-start" }),
    el("h1", { text: title }),
    el("p", { class: "muted", text: intro }),
    auth.step === "email" ? field("email", { type: "email", placeholder: "you@westgatesupply.com", autocomplete: "username", value: auth.email }) : null,
    auth.step !== "email" ? field("password", { type: "password", placeholder: auth.step === "password" ? "Password" : "New password (10+ characters)", autocomplete: auth.step === "password" ? "current-password" : "new-password" }) : null,
    auth.step === "create" || auth.step === "reset" ? field("confirm", { type: "password", placeholder: "Same password again", autocomplete: "new-password" }) : null,
    (auth.step === "create" && auth.needsCloseKey) || auth.step === "reset" ? field("key", { type: "password", placeholder: "Close API key", autocomplete: "off" }) : null,
    auth.error ? el("p", { class: "err", text: auth.error }) : null,
    el("button", { class: "btn primary", disabled: auth.busy, text: auth.busy ? "One sec…" : { email: "Continue", password: "Sign in", reset: "Save and sign in", create: "Create account" }[auth.step], onclick: next }),
    auth.step === "password" ? el("button", { class: "linkbtn", style: "align-self:flex-start", text: "Forgot password?", onclick: () => { Object.assign(auth, { step: "reset", error: "" }); render(); } }) : null,
    auth.step !== "email" ? el("button", { class: "linkbtn", style: "align-self:flex-start", text: "Use a different email", onclick: () => { Object.assign(auth, { step: "email", error: "" }); render(); } }) : null,
  ]);
  setTimeout(() => (f.email || f.password)?.focus(), 0);
  return form;
}


// The sidebar folds to a rail of icons (10/28); the choice is remembered on this computer.
let sideFolded = (() => { try { return localStorage.getItem("sideFolded") === "1"; } catch { return false; } })();
function foldSide() { sideFolded = !sideFolded; try { localStorage.setItem("sideFolded", sideFolded ? "1" : "0"); } catch {} render(); }
// Line icons for the pages, one path each, drawn in the sidebar's ink.
const PAGE_ICONS = {
  accounts: "M4 6h16v12H4z M4 10h16 M9 10v8",
  tasks: "M5 5h14v14H5z M8 12l3 3 5-6",
  heat: "M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z",
  rfqs: "M7 3h7l4 4v14H7z M14 3v4h4 M10 12h5 M10 16h5",
  emails: "M4 6h16v12H4z M4 7l8 6 8-6",
  guests: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 20a6 6 0 0 1 12 0 M16 11a3 3 0 1 0 0-6 M21 20a6 6 0 0 0-6-6",
  game: "M6 21V4 M6 4h12l-3 4 3 4H6",
};
function icon(k) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [a, v] of Object.entries({ class: "navicon", viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(a, v);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", PAGE_ICONS[k]);
  svg.append(path);
  return svg;
}

function topBar() {
  const line = state.me && state.me.lines && state.me.lines[0];
  const initials = state.me ? state.me.rep.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() : "";
  return el("aside", { class: `sidebar${sideFolded ? " folded" : ""}` }, [
    el("div", { class: "sidetop" }, [
      el("div", { class: "brand" }, [el("img", { src: "brand/world-mark-filled.svg", alt: "" }), el("span", { class: "brandtext" }, ["Westgate", el("span", { class: "sub", text: "Assistant" })])]),
      el("button", { class: "fold", title: sideFolded ? "Open the menu" : "Collapse the menu", "aria-label": sideFolded ? "Open the menu" : "Collapse the menu", text: sideFolded ? "»" : "«", onclick: foldSide }),
    ]),
    el("nav", { class: "nav" }, [["accounts", "Accounts"], ["tasks", "Tasks"], ["heat", "Heat map"], ["rfqs", "RFQs"], ["emails", "Automatic emails"], ["guests", "Guests"], ["game", "West Game"]].map(([k, label]) => el("button", {
      class: state.page === k ? "on" : "", title: label, onclick: () => go(k),
    }, [icon(k), el("span", { class: "navlabel", text: label }),
      k === "emails" && state.autos ? el("span", { class: "navc mono", text: mailRows(state.autos, "upcoming").length }) : null,
      k === "tasks" && state.tasks ? el("span", { class: `navc mono${state.tasks.today.length ? " hotc" : ""}`, text: state.tasks.today.length }) : null,
      // Companies that have sent an RFQ, the same 32 as the RFQs page (10/12), not just the ones on the board.
      k === "rfqs" && (state.teamRfq?.line || state.rfqLine || state.board) ? el("span", { class: "navc mono", text: state.teamRfq?.line ? state.teamRfq.line.companies : state.rfqLine ? state.rfqLine.companies : state.board.accounts.filter((a) => a.rfq).length }) : null,
      k === "heat" && state.board ? el("span", { class: "navc mono hotc", text: state.board.accounts.filter((a) => a.heat && a.heat.band === "today" && !a.rfq).length }) : null,
    ]))),
    sideFolded ? el("div", { class: "who" }, [
      el("button", { class: "avatar", title: `${state.me ? state.me.rep.name : ""} · open the menu for your line, phone and sign out`, text: initials || "…", onclick: foldSide }),
      el("button", { class: `linkbtn foldext${extBehind() ? " extbehind" : ""}`, title: extBehind() ? "Update extension" : "Update or get the extension", text: extBehind() ? "Upd" : "Ext", onclick: () => go("extension") }),
    ]) : el("div", { class: "who" }, [
      state.me ? el("span", { class: "whoname", text: state.me.rep.name }) : null,
      line ? el("button", {
        class: "myline", title: "Copy your Close number",
        onclick: (e) => { navigator.clipboard?.writeText(line); e.currentTarget.lastChild.textContent = "Copied"; setTimeout(render, 1200); },
      }, [el("span", { class: "k", text: "My line" }), el("span", { text: prettyPhone(line) })]) : null,
      // The phone that goes in your emails (10/19, each rep their own).
      state.me ? el("button", { class: "linkbtn", title: "The phone number in your line card emails", text: state.me.rep.phone ? `Email phone ${prettyPhone(state.me.rep.phone)}` : "Add your phone", onclick: setPhone }) : null,
      el("button", { class: `linkbtn${extBehind() ? " extbehind" : ""}`, text: extBehind() ? "Update extension" : "Update or get the extension", onclick: () => go("extension") }),
      state.me && state.me.owner ? el("button", { class: "linkbtn", text: "Team", onclick: () => go("team") }) : null,
      el("button", { class: "linkbtn", text: "Sign out", onclick: signOut }),
    ]),
  ]);
}

// ---------- West Game (10/28): the same race as the side panel's, open on its own tab, with Today and Week ----------
// One element kept across redraws: the game draws into it and keeps its own timers, so a page redraw doesn't reset it.
const gameHost = el("div", { class: "gamehost" }, [el("p", { class: "muted", text: "Loading West Game…" })]);
let game = null;
function gamePage() {
  if (!game && window.WestGame) {
    game = WestGame.create({
      mount: gameHost,
      webApp: "#team",
      load: (fresh) => api(`/api/race${fresh ? "?fresh=1" : ""}`),
      live: () => api("/api/race/live"),
      chat: (text) => api("/api/race/chat", { text }),
      store: { get: async (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }, set: async (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } },
    });
  }
  return el("section", { class: "gamepage" }, [gameHost]);
}

async function setPhone() {
  const now = state.me && state.me.rep.phone ? prettyPhone(state.me.rep.phone) : "";
  const v = window.prompt("The phone number that goes in your line card emails (leave blank for none):", now);
  if (v === null) return;
  try {
    const r = await api("/api/me/profile", { phone: v.trim() || null });
    state.me.rep.phone = r.phone; render();
  } catch (err) { window.alert(err.message); }
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

function rfqGrowth(t, isTeam = false) {
  if (!t) return el("section", { class: "rfqline" }, [el("p", { class: "loading", text: "Counting RFQs…" })]);
  const days = t.days;
  // Unique companies (Walt 10/12): "how many new companies have I brought in this week, this month". A company counts
  // once, on the day of its first RFQ; repeat RFQs from a company already in don't move these numbers.
  const companiesNow = days.length ? days[days.length - 1].companiesTotal ?? t.companies : t.companies;
  const tile = (n, label, vs) => el("div", { class: "rfqtile" }, [
    el("b", { class: "mono", text: n ?? 0 }), el("span", { text: label }),
    vs != null ? el("span", { class: "sub2", text: vs }) : null,
  ]);
  const hero = el("div", { class: "rfqhero" }, [
    el("div", {}, [el("span", { class: "big mono", text: companiesNow }), el("span", { class: "sub2", text: ` compan${companiesNow === 1 ? "y has" : "ies have"} sent ${isTeam ? "the team" : "you"} an RFQ` })]),
    el("div", { class: "rfqtiles" }, [
      tile(t.firstToday, "new today"),
      tile(t.newThisWeek, "new this week", `${t.newLastWeek ?? 0} last week`),
      tile(t.newThisMonth, "new this month", `${t.newLastMonth ?? 0} last month`),
      // Total RFQs stays on the page, but small (10/12): repeats from the same company aren't new companies.
      el("div", { class: "rfqtile rfqtile-total" }, [el("b", { class: "mono", text: t.total }), el("span", { text: "RFQs in all" }), el("span", { class: "sub2", text: "counting repeats" })]),
    ]),
  ]);
  const allRfqs = el("p", { class: "sub2 rfqall", text: `Since ${isTeam ? "the team's" : "your"} first line card, ${dayLabel(days[0].day)}. A company counts once, on the day of its first RFQ.` });
  if (days.length < 2) return el("section", { class: "rfqline" }, [el("h2", { class: "rfqh", text: "New companies" }), hero, allRfqs]);

  // Plot: companies brought in so far, one step up per new company.
  const W = 760, H = 240, L = 34, R = 28, T = 14, B = 30;
  const val = (dd) => dd.companiesTotal ?? 0;
  const max = Math.max(4, Math.ceil(companiesNow * 1.15));
  const step = max <= 12 ? 2 : max <= 30 ? 5 : max <= 60 ? 10 : max <= 150 ? 25 : 50;
  const x = (i) => L + (i * (W - L - R)) / (days.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const kids = [];
  for (let v = 0; v <= max; v += step) {
    kids.push(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? "base" : "grid" }));
    kids.push(svg("text", { x: L - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, [String(v)]));
  }
  // Date labels: evenly spaced, plus the last day; a regular label too close to the last one is dropped so they never overlap.
  const every = Math.max(1, Math.ceil(days.length / 8));
  days.forEach((dd, i) => {
    const lastI = days.length - 1;
    if (!(i === lastI || (i % every === 0 && lastI - i >= Math.max(2, every * 0.6)))) return;
    kids.push(svg("text", { x: x(i), y: H - 8, class: "tick", "text-anchor": i === 0 ? "start" : i === lastI ? "end" : "middle" }, [dayLabel(dd.day)]));
  });
  kids.push(svg("path", { d: days.map((dd, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val(dd)).toFixed(1)}`).join(""), class: "line" }));
  days.forEach((dd, i) => { if (dd.newCompanies) kids.push(svg("circle", { cx: x(i), cy: y(val(dd)), r: 4.5, class: "dot" })); });
  const last = days[days.length - 1];
  kids.push(svg("text", { x: x(days.length - 1) + 8, y: y(val(last)) + 4, class: "endlabel" }, [String(val(last))]));
  const hair = svg("line", { y1: T, y2: H - B, class: "hair", visibility: "hidden" });
  const focus = svg("circle", { r: 6, class: "focus", visibility: "hidden" });
  kids.push(hair, focus);
  const hit = svg("rect", { x: L, y: T, width: W - L - R, height: H - T - B, class: "hit", tabindex: "0", "aria-label": "New companies over time; use the arrow keys to move between days" });
  kids.push(hit);
  const plot = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "rfqsvg", role: "img", "aria-label": `Companies that have sent an RFQ: ${companiesNow} since ${dayLabel(days[0].day)}` }, kids);
  const tip = el("div", { class: "rfqtip", hidden: true });
  const wrap = el("div", { class: "rfqplot" }, [plot, tip]);

  const how = (a) => (a.how === "marked" ? " (marked)" : a.how === "email" ? " (in the email)" : "");
  let at = -1;
  const show = (i) => {
    at = Math.max(0, Math.min(days.length - 1, i));
    const dd = days[at];
    const fresh = dd.accounts.filter((a) => a.first), repeat = dd.accounts.filter((a) => !a.first);
    hair.setAttribute("x1", x(at)); hair.setAttribute("x2", x(at)); hair.setAttribute("visibility", "visible");
    focus.setAttribute("cx", x(at)); focus.setAttribute("cy", y(val(dd))); focus.setAttribute("visibility", "visible");
    tip.replaceChildren(
      el("p", { class: "tipday", text: dayLabel(dd.day, { weekday: "short", month: "short", day: "numeric" }) }),
      el("p", {}, [el("b", { class: "mono", text: dd.newCompanies ?? 0 }), ` new compan${dd.newCompanies === 1 ? "y" : "ies"} · `, el("b", { class: "mono", text: val(dd) }), " so far"]),
      ...fresh.map((a) => el("p", { class: "sub2", text: `${a.company}${how(a)}` })),
      repeat.length ? el("p", { class: "sub2 muted", text: `Again: ${repeat.map((a) => a.company).join(", ")}` }) : null,
    );
    tip.hidden = false;
    const r = plot.getBoundingClientRect(), px = (x(at) / W) * r.width;
    const tw = tip.offsetWidth || 200;
    tip.style.left = `${px > r.width / 2 ? Math.max(px - tw - 14, 0) : Math.min(px + 14, r.width - tw)}px`;
    tip.style.top = `${Math.max((y(val(dd)) / H) * r.height - 20, 0)}px`;
  };
  const hide = () => { hair.setAttribute("visibility", "hidden"); focus.setAttribute("visibility", "hidden"); tip.hidden = true; };
  hit.addEventListener("pointermove", (e) => { const r = plot.getBoundingClientRect(); const vx = ((e.clientX - r.left) / r.width) * W; show(Math.round(((vx - L) / (W - L - R)) * (days.length - 1))); });
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(days.length - 1));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") { show(at - 1); e.preventDefault(); } if (e.key === "ArrowRight") { show(at + 1); e.preventDefault(); } });

  const table = el("details", { class: "rfqtable" }, [
    el("summary", { text: "See the companies, by the day they came in" }),
    el("table", {}, [
      el("thead", {}, [el("tr", {}, ["Day", "New", "So far", "Companies"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, days.filter((dd) => dd.newCompanies).reverse().map((dd) => el("tr", {}, [
        el("td", { text: dayLabel(dd.day, { weekday: "short", month: "short", day: "numeric" }) }), el("td", { class: "mono", text: dd.newCompanies }), el("td", { class: "mono", text: val(dd) }),
        el("td", { text: dd.accounts.filter((a) => a.first).map((a) => a.company).join(", ") }),
      ]))),
    ]),
  ]);
  return el("section", { class: "rfqline" }, [el("h2", { class: "rfqh", text: "New companies" }), hero, wrap, allRfqs, table]);
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
  // Paused (cooling, snoozed until a date, bounced, or said no) is off the call bands (10/12); see the Paused list.
  const all = ((state.board && state.board.accounts) || []).filter((a) => !a.rfq && !HAS_RFQ_STATUS.test(a.status || "") && a.warmth && !a.warmth.paused);
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

// ---------- the heat map, v3 (Walt 10/14: "a cool and coherent UI that looks sick") ----------
// One question: who is most likely to send an RFQ soon, and why. The same order drives Calls to make.
const HEAT_BANDS = [
  ["today", "Call today", "Most likely to send an RFQ now"],
  ["week", "This week", "Warm, nothing due today"],
  ["emails", "Emails only", "The sequence carries them for now"],
  ["later", "Later", "They gave a date. A task in Close has them, and they're back on the map that day"],
  ["off", "Off", "Said no, or stop"],
];
const HEAT_CHIPS = [
  ["promised", "Promised", (t) => t.startsWith("promised")],
  ["day", "Their day", (t) => /their day/.test(t)],
  ["asked", "Asked something", (t) => t === "asked something"],
  ["clicked", "Clicked", (t) => t === "clicked"],
  ["next", "Next one is yours", (t) => t === "next one is yours"],
  ["repeat", "Repeat customer", (t) => t === "repeat"],
];
const PIPS = { steady: 4, project: 3, occasional: 2, unknown: 1 };
const pips = (a) => { const n = PIPS[potTier(a)] || 1; return el("span", { class: "pips", title: `How much they buy: ${POT[potTier(a)][0]}`, "aria-label": `How much they buy: ${POT[potTier(a)][0]}` }, Array.from({ length: 4 }, (_, i) => el("i", { class: i < n ? "on" : "" }))); };
const heatBand = (a) => (a.heat ? a.heat.band : "emails");
const BAND_W = { today: "hot", week: "warm", emails: "cool", later: "cool", off: "cold" };

function heatList() {
  const q = (state.heatQ || "").trim().toLowerCase();
  const chip = HEAT_CHIPS.find(([k]) => k === state.heatTag);
  const order = (a) => HEAT_BANDS.findIndex(([k]) => k === heatBand(a));
  return ((state.board && state.board.accounts) || [])
    // An RFQ in lives on the RFQs page; a repeat customer (quoted two weeks ago) is back here.
    .filter((a) => a.heat && (!a.rfq || a.heat.tags.includes("repeat")))
    .filter((a) => !q || [a.company, a.contact.name, a.contact.email].some((v) => (v || "").toLowerCase().includes(q)))
    .filter((a) => !chip || a.heat.tags.some(chip[2]))
    .sort((x, y) => order(x) - order(y) || y.heat.score - x.heat.score);
}

function heatPage() {
  const rows = heatList();
  const all = ((state.board && state.board.accounts) || []).filter((a) => a.heat && (!a.rfq || a.heat.tags.includes("repeat")));
  const by = Object.fromEntries(HEAT_BANDS.map(([k]) => [k, rows.filter((a) => heatBand(a) === k)]));
  const counts = Object.fromEntries(HEAT_BANDS.map(([k]) => [k, all.filter((a) => heatBand(a) === k).length]));
  const pick = state.heatPick && rows.find((a) => a.leadId === state.heatPick);
  const open = (a) => { state.heatPick = a.leadId; render(); };
  const tel = (a) => (a.contact.phone ? el("a", { class: "htel mono", href: `tel:${a.contact.phone}`, text: prettyPhone(a.contact.phone), onclick: (e) => e.stopPropagation() }) : null);
  const tags = (a) => el("span", { class: "htags" }, a.heat.tags.slice(0, 3).map((t) => el("span", { class: "htag", text: t })));
  // Already reached out today: it stays, faded, so you can see what's left (10/14).
  const doneToday = (a) => { const t = todayState(a); return t.reached ? "Reached today" : t.called ? "Called today" : null; };
  const card = (a) => el("button", { class: `hcard${pick && pick.leadId === a.leadId ? " on" : ""}${doneToday(a) ? " done" : ""}`, onclick: () => open(a) }, [
    el("span", { class: "htop" }, [el("span", { class: "co", text: a.company }), doneToday(a) ? el("span", { class: "hdone", text: doneToday(a) }) : pips(a)]),
    el("span", { class: "hwhy", text: a.heat.reason }),
    a.heat.promise && a.heat.promise.quote ? el("span", { class: "hquote", text: `“${a.heat.promise.quote}”` }) : null,
    tags(a),
    el("span", { class: "hfoot" }, [el("span", { class: "sub2", text: a.heat.who || a.contact.name || "" }), tel(a)]),
  ]);
  const row = (a) => el("button", { class: `hrow b-${heatBand(a)}${pick && pick.leadId === a.leadId ? " on" : ""}`, onclick: () => open(a) }, [
    el("i", { class: "hbar", "aria-hidden": "true" }),
    el("span", { class: "co", text: a.company }),
    el("span", { class: "hwhy2", text: a.heat.reason }),
    pips(a),
    tel(a) || el("span"),
  ]);
  const meta = (k) => HEAT_BANDS.find(([b]) => b === k);
  const folded = (k, list) => el("details", { class: `hband b-${k}`, open: !!state.heatOpen[k], ontoggle: (e) => { state.heatOpen[k] = e.currentTarget.open; } }, [
    el("summary", {}, [el("span", { class: "hlbl", text: meta(k)[1] }), el("b", { class: "mono", text: list.length }), el("span", { class: "sub2", text: meta(k)[2] })]),
    el("div", { class: "hrows" }, (state.heatOpen[`${k}All`] ? list : list.slice(0, 60)).map(row)),
    list.length > 60 && !state.heatOpen[`${k}All`] ? el("button", { class: "linkbtn small3", text: `Show all ${list.length}`, onclick: () => { state.heatOpen[`${k}All`] = true; render(); } }) : null,
  ]);
  const total = Math.max(1, all.length);
  return el("section", { class: `heat hv3${pick ? " drawer-open" : ""}` }, [
    el("div", { class: "head pagehead" }, [
      el("h1", { class: "ptitle", text: "Heat map" }),
      el("input", { class: "heatq", type: "search", placeholder: "Find an account, a name, an email", value: state.heatQ, oninput: (e) => { state.heatQ = e.target.value; state.heatPick = null; renderKeepFocus(".heatq"); } }),
    ]),
    el("p", { class: "sub2 wrap hlede", text: "Who's most likely to send an RFQ soon, from what they said and did: promises, the day they said work comes, questions in their replies, clicks, real conversations and how much they buy. Never from how many times you've called. The same order runs Calls to make." }),
    !state.board ? el("p", { class: "loading", text: "Reading your accounts from Close…" }) : el("div", { class: "hstrip" }, HEAT_BANDS.map(([k, label]) => el("button", {
      class: `hseg b-${k}`, style: `flex-grow:${Math.max(counts[k], total * 0.07).toFixed(1)}`, title: `${counts[k]} · ${label}`,
      onclick: () => { if (k === "emails" || k === "later" || k === "off") { state.heatOpen[k] = true; render(); } document.getElementById(`hb-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); },
    }, [el("b", { class: "mono", text: counts[k] }), el("span", { text: label })]))),
    el("div", { class: "hchips" }, [
      el("button", { class: `hchip${!state.heatTag ? " on" : ""}`, onclick: () => { state.heatTag = null; render(); } }, ["All"]),
      ...HEAT_CHIPS.map(([k, label, test]) => el("button", { class: `hchip${state.heatTag === k ? " on" : ""}`, onclick: () => { state.heatTag = state.heatTag === k ? null : k; state.heatPick = null; render(); } }, [label, el("b", { class: "mono", text: all.filter((a) => a.heat.tags.some(test)).length })])),
    ]),
    el("div", { id: "hb-today", class: "hsec" }, [
      el("div", { class: "hhead" }, [el("h2", { text: "Call today" }), el("b", { class: "mono", text: by.today.filter((a) => !doneToday(a)).length }), by.today.some(doneToday) ? el("span", { class: "sub2", text: `+ ${by.today.filter(doneToday).length} done today ·` }) : null, el("span", { class: "sub2", text: "Most likely to send an RFQ now. The reason is in red." })]),
      by.today.length ? el("div", { class: "hcards" }, [...by.today.filter((a) => !doneToday(a)), ...by.today.filter(doneToday)].map(card)) : el("p", { class: "empty", text: "Nobody's red-hot right now. Work This week." }),
    ]),
    el("div", { id: "hb-week", class: "hsec" }, [
      el("div", { class: "hhead" }, [el("h2", { text: "This week" }), el("b", { class: "mono", text: by.week.length }), el("span", { class: "sub2", text: "Warm: talked recently, said the next one is yours, or wrote back." })]),
      by.week.length ? el("div", { class: "hrows" }, (state.heatOpen.weekAll ? by.week : by.week.slice(0, 40)).map(row)) : el("p", { class: "empty", text: "Nobody here." }),
      by.week.length > 40 && !state.heatOpen.weekAll ? el("button", { class: "linkbtn small3", text: `Show all ${by.week.length}`, onclick: () => { state.heatOpen.weekAll = true; render(); } }) : null,
    ]),
    el("div", { id: "hb-emails" }, [folded("emails", by.emails)]),
    el("div", { id: "hb-later" }, [folded("later", by.later.slice().sort((x, y) => (x.heat.expected || "").localeCompare(y.heat.expected || "")))]),
    el("div", { id: "hb-off" }, [folded("off", by.off)]),
    pick ? heatDrawer(pick, rows) : null,
  ]);
}

// Paused (10/12): not for calling now. Why, and when they come back on their own.
const PAUSE = { out: ["Said no", 0], no_emails: ["No more emails", 1], later: ["Come back later", 2], not_now: ["Not now", 3], cooling: ["Cooling off", 4], bounced: ["Needs a working email", 5] };
function pausedBand(list) {
  if (!list.length) return null;
  const open = !!state.heatPausedOpen;
  const rows = list.slice().sort((a, b) => PAUSE[a.warmth.paused.kind][1] - PAUSE[b.warmth.paused.kind][1] || (a.warmth.paused.until || "9").localeCompare(b.warmth.paused.until || "9"));
  const counts = Object.keys(PAUSE).map((k) => [k, list.filter((a) => a.warmth.paused.kind === k).length]).filter(([, n]) => n);
  return el("div", { class: "heatband paused" }, [
    el("div", { class: "heatlbl", onclick: () => { state.heatPausedOpen = !open; render(); }, style: "cursor:pointer" }, [
      el("span", { class: "label", text: "Paused" }), el("span", { class: "mono muted", text: list.length }),
      el("span", { class: "muted small3 why", text: counts.map(([k, n]) => `${n} ${PAUSE[k][0].toLowerCase()}`).join(" · ") + ". Not for calling now; they come back on their own." }),
      el("button", { class: "linkbtn", text: open ? "Hide" : "Show" }),
    ]),
    open ? el("div", { class: "pausedlist" }, rows.map((a) => { const p = a.warmth.paused; return el("div", { class: `prow p-${p.kind}` }, [
      el("a", { class: "co", href: closeLead(a.leadId), target: "westgate-close", text: a.company, onclick: (e) => { e.preventDefault(); openInCloseTab(a.leadId); } }),
      el("span", { class: "pk", text: PAUSE[p.kind][0] }),
      el("span", { class: "pu mono", text: p.until ? `back ${shortDate(p.until)}` : p.kind === "out" ? "off the map" : "" }),
      el("span", { class: "pw muted", text: p.why }),
    ]); })) : null,
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
        : el("span", { class: "sub2", text: a.cadence ? `In the email sequence · next email ${a.cadence.dueAt ? shortDate(a.cadence.dueAt) : "when due"}` : "In the email sequence" }),
    on ? el("button", { class: "btn small", text: "Put back", onclick: () => set(null, false) })
      : el("span", { class: "askrow" }, [el("span", { class: "sub2", text: "Cool off for" }), ...COOL_OPTIONS.map(([days, label]) => el("button", { class: days ? "btn small" : "linkbtn small3", text: label, onclick: () => set(days) }))]),
  ]);
}

// The drawer on the right: one lead at a time, Previous / Next walk the map in order (← → on the keyboard too).
// The whole email thread in the drawer (Walt 10/14: "put the entire thread in, and it should be scrollable"):
// a conversation, oldest at the top, every message in full, in its own scrolling panel that opens at the newest.
function emailThread(a) {
  state.threads = state.threads || {};
  const t = state.threads[a.leadId];
  if (!t) {
    state.threads[a.leadId] = { loading: true };
    api(`/api/leads/${a.leadId}/emails`).then((r) => { state.threads[a.leadId] = { emails: r.emails.slice().reverse() }; render(); })
      .catch((e) => { state.threads[a.leadId] = { error: e.message }; render(); });
  }
  const who = (e) => {
    if (e.direction === "outgoing") return "You";
    const m = (e.from || "").match(/^\s*"?([^"<]+?)"?\s*</);
    return (m && m[1].trim()) || (e.from || "Them").replace(/<.*/, "").trim();
  };
  const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const list = (t && t.emails) || [];
  const theirs = list.filter((e) => e.direction !== "outgoing").length;
  // The message and the sign-off ("Thanks,\nNicolette Watson"); the contact block under it (title, address, phone,
  // links) folds away. Duplicate mailto links come out.
  const tidy = (txt) => (txt || "").replace(/<mailto:[^>]+>/gi, "").replace(/\[(cid|image)[^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  const splitSig = (txt) => {
    const lines = tidy(txt).split("\n");
    const off = lines.findIndex((l) => /^\s*(thanks|thank you|regards|best regards|best|sincerely|cheers|respectfully)[,!.]?\s*$/i.test(l));
    if (off >= 0) {
      let end = off + 1;
      while (end < lines.length && !lines[end].trim()) end++;
      end = Math.min(lines.length, end + 1); // the name
      const rest = lines.slice(end).join("\n").trim();
      return { body: lines.slice(0, end).join("\n").trim(), sig: rest.length > 2 ? rest : "" };
    }
    // No sign-off: fold from the first line that looks like contact details.
    const c = lines.findIndex((l, i) => i > 1 && /(\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}|@[a-z0-9-]+\.[a-z]{2,}|www\.|\b(direct|office|cell|mobile|fax)\b\s*[:~])/i.test(l));
    return c > 0 ? { body: lines.slice(0, c).join("\n").trim(), sig: lines.slice(c).join("\n").trim() } : { body: lines.join("\n"), sig: "" };
  };
  const kids = [];
  let lastDay = null, lastSubject = null;
  for (const e of list) {
    const d = day(e.at);
    if (d !== lastDay) { kids.push(el("div", { class: "tday2" }, [el("span", { text: d })])); lastDay = d; }
    const subj = (e.subject || "").replace(/^(re|fw|fwd):\s*/gi, "").trim();
    if (subj && subj !== lastSubject) { kids.push(el("div", { class: "tsubj", text: e.subject })); lastSubject = subj; }
    const out = e.direction === "outgoing";
    const qk = `${a.leadId}:${e.id}`;
    kids.push(el("div", { class: `bub ${out ? "out" : "in"}${e.status === "scheduled" ? " sched" : ""}` }, [
      el("div", { class: "bhead" }, [
        el("span", { class: "bwho", text: who(e) }),
        el("span", { class: "bwhen mono", text: e.status === "scheduled" ? `scheduled · ${time(e.at)}` : time(e.at) }),
      ]),
      ...(() => { const sp = splitSig(e.own); const sk = `${qk}:sig`; const open = !!(state.quoteOpen || {})[sk]; return [
        el("div", { class: "btext", text: sp.body || "(no text)" }),
        sp.sig ? (open ? el("div", { class: "bsig", text: sp.sig }) : null) : null,
        sp.sig ? el("button", { class: "linkbtn small3 bsigt", text: open ? "Hide signature" : "Signature", onclick: () => { state.quoteOpen = { ...(state.quoteOpen || {}), [sk]: !open }; render(); } }) : null,
      ]; })(),
      e.files.length ? el("div", { class: "bfiles" }, e.files.map((f) => el("span", { class: "bfile", text: f }))) : null,
      el("div", { class: "bfoot" }, [
        out && e.status !== "scheduled" ? el("span", { class: e.opens ? "bopen yes" : "bopen", text: e.opens ? `Opened ${e.opens}×` : "No open seen" }) : el("span", { class: "sub2", text: e.to && e.to.length && !out ? `to ${e.to.join(", ")}` : "" }),
        e.quoted ? el("button", { class: "linkbtn small3", text: state.quoteOpen && state.quoteOpen[qk] ? "Hide quoted text" : "Show quoted text", onclick: () => { state.quoteOpen = { ...(state.quoteOpen || {}), [qk]: !(state.quoteOpen || {})[qk] }; render(); } }) : null,
      ]),
      e.quoted && state.quoteOpen && state.quoteOpen[qk] ? el("div", { class: "bquote", text: e.quoted }) : null,
    ]));
  }
  const panel = el("div", { class: "tpanel" }, kids);
  // Open at the newest message, once per account.
  if (list.length && state.threadScrolled !== a.leadId) {
    state.threadScrolled = a.leadId;
    requestAnimationFrame(() => { const p = document.querySelector(".tpanel"); if (p) p.scrollTop = p.scrollHeight; });
  }
  return el("div", { class: "dr-thread2" }, [
    el("div", { class: "thead" }, [
      el("span", { class: "label", text: "Email thread" }),
      list.length ? el("span", { class: "sub2", text: `${list.length} emails · ${theirs} from them` }) : null,
      el("a", { class: "linkbtn small3", href: closeLead(a.leadId), target: "westgate-close", text: "Open in Close", onclick: (ev) => { ev.preventDefault(); openInCloseTab(a.leadId); } }),
    ]),
    !t || t.loading ? el("p", { class: "loading tpanel-msg", text: "Reading the emails from Close…" })
      : t.error ? el("p", { class: "sub2 tpanel-msg", text: `Couldn't load them: ${t.error}` })
        : !list.length ? el("p", { class: "sub2 tpanel-msg", text: "No emails yet." }) : panel,
  ]);
}

function heatDrawer(a, rows) {
  const i = rows.findIndex((r) => r.leadId === a.leadId);
  const w = { ...a.warmth, bucket: a.heat ? BAND_W[a.heat.band] : a.warmth.bucket }, c = a.contact;
  const goTo = (j) => { if (rows[j]) { state.heatPick = rows[j].leadId; render(); document.querySelector(".hcard.on, .hrow.on")?.scrollIntoView({ block: "nearest" }); } };
  const close = () => { state.heatPick = null; render(); };
  return el("aside", { class: `drawer w-${w.bucket}`, role: "dialog", "aria-label": a.company }, [
    el("div", { class: "dr-top" }, [
      el("span", { class: "mono muted", text: `${i + 1} of ${rows.length}` }),
      el("button", { class: "linkbtn", text: "Close", onclick: close }),
    ]),
    a.heat ? el("div", { class: `dr-heat b-${a.heat.band}` }, [
      el("span", { class: "label", text: HEAT_BANDS.find(([k]) => k === a.heat.band)[1] }),
      el("strong", { text: a.heat.reason }),
      a.heat.promise && a.heat.promise.quote ? el("span", { class: "hquote", text: `${a.heat.who || "They"} said: “${a.heat.promise.quote}”` }) : null,
      a.heat.tags.length ? el("span", { class: "htags" }, a.heat.tags.map((t) => el("span", { class: "htag", text: t }))) : null,
    ]) : el("span", { class: `warmth w-${w.bucket} big` }, [el("i", { "aria-hidden": "true" }), `${HEAT[w.bucket][0]} · ${w.score}`]),
    // Click the name to copy it (Walt 10/12), e.g. to search for it in Close; "Open in Close" is right under it.
    el("button", { class: "dr-co", title: "Copy the company name", text: a.company, onclick: (e) => {
      navigator.clipboard?.writeText(a.company).catch(() => {});
      const b = e.currentTarget; b.dataset.copied = "1"; setTimeout(() => { delete b.dataset.copied; }, 1200);
    } }),
    el("a", { class: "linkbtn dr-open", href: closeLead(a.leadId), target: "westgate-close", text: "Open in Close", onclick: (e) => { e.preventDefault(); openInCloseTab(a.leadId); } }),
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
    emailThread(a),
    el("div", { class: `dr-card c-${cardState(a)}` }, [
      el("span", { class: "label", text: "Line card" }),
      el("span", { class: "card" }, [el("i", { "aria-hidden": "true" }), `Sent ${shortDate(a.cardSentAt)} (${daysAgo(a.cardSentAt)}d ago)`]),
      el("span", { class: "sub2", text: cardText(a) }),
    ]),
    el("p", { class: "sub2", text: a.next.detail }),
    potentialBlock(a),
    el("p", { class: "sub2", text: (a.heat && a.heat.lastSignal) ? `Last sign of life ${shortDate(a.heat.lastSignal)} (${daysAgo(a.heat.lastSignal)}d ago)` : "No sign of life since the line card" }),
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
  const rows = heatList(), i = rows.findIndex((r) => r.leadId === state.heatPick);
  if (e.key === "ArrowRight" && rows[i + 1]) { state.heatPick = rows[i + 1].leadId; render(); }
  else if (e.key === "ArrowLeft" && rows[i - 1]) { state.heatPick = rows[i - 1].leadId; render(); }
  else if (e.key === "Escape") { state.heatPick = null; render(); }
  else return;
  document.querySelector(".hcard.on, .hrow.on")?.scrollIntoView({ block: "nearest" });
});

function rfqsPage() {
  // The whole team's RFQs (10/19); your own until the team list arrives.
  const team = state.teamRfq;
  const isTeam = !!team && team.reps.length > 1;
  const all = team ? team.accounts : (state.board && state.board.accounts) || [];
  // Waiting on you first, then Westgate, then the buyer, then done; oldest first inside each.
  const order = { you: 0, westgate: 1, buyer: 2, nobody: 3 };
  const sorted = all.filter((a) => a.rfq).sort((a, b) => order[a.rfq.status.waitingOn] - order[b.rfq.status.waitingOn] || a.rfq.status.since.localeCompare(b.rfq.status.since));
  // First-time RFQs (10/8): from the RFQ line, the companies whose first one came in today or this week.
  const t = (team && team.line) || state.rfqLine, days = (t && t.days) || [];
  // Calendar week (since Monday) and month, the same spans as the tiles above (10/12).
  const lastDay = days.length ? days[days.length - 1].day : "";
  const monday = lastDay ? new Date(Date.parse(`${lastDay}T12:00:00Z`) - ((new Date(`${lastDay}T12:00:00Z`).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10) : "";
  const firstIn = (from) => new Set(days.filter((dd) => dd.day >= from).flatMap((dd) => dd.accounts.filter((x) => x.first).map((x) => x.leadId)));
  const newToday = firstIn(lastDay), newWeek = firstIn(monday), newMonth = firstIn(lastDay.slice(0, 7));
  const pick = state.rfqFilter || "all";
  // Companies the RFQ count found that aren't on the accounts board (no line card from the app, 10/8: 7 counted, 4
  // listed): a plain row from the count, so every one counted is listed.
  const onBoard = new Set(sorted.map((a) => a.leadId));
  const offBoard = new Map();
  for (const dd of days) for (const x of dd.accounts) if (!onBoard.has(x.leadId)) offBoard.set(x.leadId, { leadId: x.leadId, company: x.company, how: x.how, reps: x.reps || [], day: offBoard.get(x.leadId)?.day ?? dd.day });
  const extras = [...offBoard.values()].filter((x) => pick === "today" ? newToday.has(x.leadId) : pick === "week" ? newWeek.has(x.leadId) : pick === "month" ? newMonth.has(x.leadId) : true);
  const rows = pick === "today" ? sorted.filter((a) => newToday.has(a.leadId)) : pick === "week" ? sorted.filter((a) => newWeek.has(a.leadId)) : pick === "month" ? sorted.filter((a) => newMonth.has(a.leadId)) : sorted;
  const chip = (k, label, n) => el("button", { class: `cardk${pick === k ? " on" : ""}`, onclick: () => { state.rfqFilter = k; render(); } }, [el("b", { class: "mono", text: n }), label]);
  const filters = el("div", { class: "heatcard" }, [el("span", { class: "label", text: "Show" }), chip("all", "All RFQs", sorted.length + offBoard.size), chip("today", "New today", newToday.size), chip("week", "New this week", newWeek.size), chip("month", "New this month", newMonth.size)]);
  const fresh = new Set([...newWeek]);
  return el("section", {}, [
    el("div", { class: "head pagehead" }, [el("h1", { class: "ptitle", text: "RFQs" })]),
    rfqGrowth(t, isTeam),
    filters,
    el("p", { class: "muted small3", text: (isTeam ? `The whole team's RFQs (${team.reps.join(", ")}). ` : "") + "Everyone who's sent an RFQ. They're out of the email sequence. The status comes from the emails in Close (quote sent, buyer answered, a PO), or from your own update when the handoff happens outside Close." }),
    !team && !state.board ? el("p", { class: "loading", text: "Reading your accounts from Close…" })
      : !rows.length && !extras.length ? el("p", { class: "empty", text: pick === "today" ? "No new companies today yet." : pick === "week" ? "No new companies this week yet." : pick === "month" ? "No new companies this month yet." : "No RFQs yet." })
        : el("div", { class: "grid rfqgrid" }, [
          el("div", { class: "gr gh" }, ["Account", "RFQ", "Status", "Waiting on", ""].map((h) => el("span", { class: "label", text: h }))),
          ...rows.flatMap((a) => rfqRow(a, fresh.has(a.leadId), isTeam)),
          ...extras.map((x) => el("div", { class: "gr" }, [
            el("div", { class: "acct" }, [
              el("a", { class: "co", href: closeLead(x.leadId), target: "_blank", rel: "noopener", text: x.company }),
              el("span", { class: "sub2" }, [fresh.has(x.leadId) ? el("span", { class: "newbadge", text: "First RFQ" }) : null, isTeam && x.reps.length ? `${x.reps.join(" & ")} · ` : "", "Not on the line card board"]),
            ]),
            el("div", { class: "rfqin" }, [el("span", { class: "mono", text: dayLabel(x.day) }), el("span", { class: "files", text: x.how === "file" ? "Came with a file" : x.how === "email" ? "In the email" : "Marked in Close" })]),
            el("div", {}, [el("span", { class: "rfqst", text: "RFQ in" }), el("span", { class: "sub2", text: "open it in Close for the thread" })]),
            el("span", { class: "waiting" }, [el("i", { "aria-hidden": "true" }), "Check in Close"]),
            el("div", { class: "acts" }, [el("a", { class: "btn small", href: closeLead(x.leadId), target: "_blank", rel: "noopener", text: "Open" })]),
          ])),
        ]),
  ]);
}

function rfqRow(a, isNew = false, isTeam = false) {
  const r = a.rfq, st = r.status;
  const [who, wcls] = WAITING[st.waitingOn];
  const edit = state.rfqEdit[a.leadId];
  const row = el("div", { class: "gr" }, [
    el("div", { class: "acct" }, [
      el("a", { class: "co", href: closeLead(a.leadId), target: "_blank", rel: "noopener", text: a.company }),
      el("span", { class: "sub2" }, [isNew ? el("span", { class: "newbadge", text: "First RFQ" }) : null, isTeam && a.reps ? el("b", { text: `${a.reps.join(" & ")} · ` }) : null, a.contact.name || a.contact.email || ""]),
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
// "New line card!" (Walt 10/28): the one-time wave to everyone who only had the old card.
async function loadNewCard() {
  if (state.newCard === null) return;
  state.newCard = null; // loading
  state.newCard = await api("/api/automations/new-card").catch(() => undefined);
  render();
}
function newCardCard() {
  const nc = state.newCard;
  if (nc === undefined) { loadNewCard(); return null; }
  if (!nc) return null;
  const sum = nc.summary;
  if (!sum && !nc.owner) return null;
  const first = (n) => n.split(/\s+/)[0];
  const run = async (path, body, msg) => {
    if (msg && !confirm(msg)) return;
    state.mailBusy = true; render();
    try { const r = await api(path, body || {}); state.newCardMsg = r.planned ? `${r.planned.length} scheduled${r.skipped && r.skipped.length ? `, ${r.skipped.length} skipped` : ""}${r.reason ? ` · ${r.reason}` : ""}.` : "List built."; }
    catch (e) { alert(e.message); }
    state.mailBusy = false; state.newCard = undefined;
    render(); reloadAutos();
  };
  return el("section", { class: "mcard" }, [
    el("div", { class: "pagehead row" }, [el("p", { class: "label", text: "New line card!" }), el("span", { class: "muted small", text: sum ? `built ${shortDate(sum.builtAt)}` : "" })]),
    sum
      ? el("p", {}, [`${sum.total} compan${sum.total === 1 ? "y" : "ies"} that only ever got the old card. `, ...sum.reps.map((r, i) => el("span", {}, `${i ? " · " : ""}${first(r.name)}: ${r.sent} sent, ${r.waiting} to go${r.skipped ? `, ${r.skipped} skipped` : ""}`))])
      : el("p", { text: "One email to everyone who only ever got the old line card, from whoever sent them a line card last (you, Chase or Liam), in a new thread with the new PDF and a meme. You're CC'd on the ones you don't send. Each person's share goes out on their mornings at their usual pace." }),
    el("div", { class: "extrow" }, [
      nc.owner && !sum ? el("button", { class: "btn small primary", disabled: state.mailBusy, text: "Build the list", onclick: () => run("/api/automations/new-card/plan") }) : null,
      nc.owner && sum ? el("button", { class: "btn small", disabled: state.mailBusy, text: "Rebuild the list", onclick: () => run("/api/automations/new-card/plan") }) : null,
      sum && nc.mine ? el("button", { class: "btn small primary", disabled: state.mailBusy, text: `Send my share now (${nc.mine} waiting)`, onclick: () => run("/api/automations/new-card/send-now", {}, `Schedule up to your daily pace of these ${nc.mine} right now, for a morning slot their time? The rest go on the next mornings.`) }) : null,
      sum && !nc.mine ? el("span", { class: "muted small", text: "Nothing waiting for you." }) : null,
      state.newCardMsg ? el("span", { class: "muted small", text: state.newCardMsg }) : null,
    ]),
  ]);
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

// Is the sequence working (10/12)? Emails sent, RFQs that came in within a week of one, and stop requests, by where
// the account was in the sequence. The number that matters is RFQs per 100 emails.
function scoreboardTable(rows) {
  const per = (r) => (r.sent ? `${((r.rfqs / r.sent) * 100).toFixed(1)}` : "–");
  const tot = rows.reduce((t, r) => ({ sent: t.sent + r.sent, rfqs: t.rfqs + r.rfqs, stops: t.stops + r.stops }), { sent: 0, rfqs: 0, stops: 0 });
  return el("details", { class: "rfqtable scoreboard", open: true }, [
    el("summary", { text: `Scoreboard, last 60 days: ${tot.rfqs} RFQ${tot.rfqs === 1 ? "" : "s"} from ${tot.sent} automatic emails` }),
    el("table", {}, [
      el("thead", {}, [el("tr", {}, ["Where they were", "Emails", "RFQs within a week", "RFQs per 100", "Asked to stop or slow down"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows.map((r) => el("tr", {}, [
        el("td", { text: r.label }), el("td", { class: "mono", text: r.sent }), el("td", { class: "mono", text: r.rfqs }), el("td", { class: "mono", text: per(r) }), el("td", { class: "mono", text: r.stops }),
      ]))),
    ]),
  ]);
}

// ---------- the Automatic emails dashboard (Walt 10/12: "make it super intuitive, I don't know what's going on") ----------
// Four questions, top to bottom: what's going out, where every account is in the sequence, who to call, and is it
// producing RFQs. The full list of emails is under that.

// Where an account is in the sequence, one stage each, in the order the sequence moves them.
const MAIL_STAGES = [
  { k: "intro", label: "Intro emails", sub: "Talked to the buyer: 3 emails", tone: "navy" },
  { k: "cold", label: "Cold intro", sub: "Email from the front desk: 2 emails", tone: "navy" },
  { k: "call", label: "Call them", sub: "Clicked, intro done, or 3 days quiet", tone: "red" },
  { k: "rhythm", label: "Rhythm", sub: "Every few days to 3 weeks, by how much they buy", tone: "ink" },
  { k: "monthly", label: "Monthly", sub: "6 emails, nothing back", tone: "muted" },
];
const MAIL_SIDE = [
  { k: "you", label: "Waiting on you", sub: "A reply to answer, or a bad address", tone: "red" },
  { k: "paused", label: "Paused", sub: "Replied, cooling off, or on hold", tone: "amber" },
  { k: "rfq", label: "RFQ in", sub: "Out of the emails, into quoting", tone: "green" },
  { k: "out", label: "Off for good", sub: "Said no or stop", tone: "muted" },
];
function mailStageOf(a, held) {
  if (a.rfq) return "rfq";
  const p = a.warmth && a.warmth.paused;
  if (p && (p.kind === "out" || p.kind === "no_emails")) return "out";
  if (a.next.kind === "reply" || a.seen === "bounced" || a.next.kind === "rescue" && /working email|mail filter/i.test(a.next.label)) return "you";
  const replied = a.lastReplyAt && Date.now() - Date.parse(a.lastReplyAt) < 10.5 * 864e5;
  if (held.has(a.leadId) || replied || (p && p.until && p.until > new Date().toISOString())) return "paused";
  if (a.next.kind === "bump" && a.next.tag === "Call") return "call";
  const c = a.cadence;
  if (!c || !c.eligible) return "paused";
  if (c.phase === "intro") return c.track === "cold" ? "cold" : "intro";
  return c.phase === "monthly" ? "monthly" : "rhythm";
}
// "talked:r1:intro" (a sent row's tag) or the forecast label → a short step for the list.
function stepOf(m) {
  const v = m.variant || "";
  const t = /^(cold|talked):r(\d+):(intro|rhythm|monthly)$/.exec(v);
  if (t) return t[1] === "cold" ? `Cold ${t[3]}` : `Round ${t[2]} ${t[3]}`;
  if (v === "friday") return "Sent by hand";
  if (m.future) return m.label;
  return m.status === "sent" ? "Old sequence" : m.label || "";
}
const localDay = (iso) => new Date(iso).toLocaleDateString("en-CA");

function mailDashboard(au) {
  const accounts = (state.board && state.board.accounts) || [];
  const held = new Set((au.held || []).map((f) => f.leadId));
  const upcoming = mailRows(au, "upcoming");
  const today = localDay(new Date().toISOString());
  const byDay = new Map();
  for (const m of upcoming) { const d = localDay(m.sortAt); byDay.set(d, (byDay.get(d) || 0) + 1); }
  const days = [...byDay.keys()].sort();
  const nextDay = days.find((d) => d > today);
  const tot = (au.scoreboard || []).reduce((t, r) => ({ sent: t.sent + r.sent, rfqs: t.rfqs + r.rfqs, stops: t.stops + r.stops }), { sent: 0, rfqs: 0, stops: 0 });
  const tile = (n, label, sub, tone, onclick) => el(onclick ? "button" : "div", { class: `mtile t-${tone}${onclick ? " click" : ""}`, onclick }, [
    el("b", { class: "mono", text: n }), el("span", { class: "tl", text: label }), sub ? el("span", { class: "sub2", text: sub }) : null,
  ]);
  const pickDay = (d) => { state.mailTab = "upcoming"; state.mailDay = state.mailDay === d ? null : d; render(); document.querySelector(".mlist")?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  // 1. At a glance. The daily goal (Walt 10/12): every account in the sequence hears from you, email or phone, at
  // least every 3 business days: about 50-100 a day.
  const inSeq = accounts.filter((a) => ["intro", "cold", "call", "rhythm", "monthly"].includes(mailStageOf(a, held)));
  const touched = inSeq.filter((a) => a.touchedToday).length;
  const callsLeft = accounts.filter((a) => a.next.kind === "bump" && a.next.tag === "Call" && !a.touchedToday).length;
  const tiles = el("div", { class: "mtiles" }, [
    tile(touched, "Touched today", `of ${inSeq.length} in the sequence · ${callsLeft} call${callsLeft === 1 ? "" : "s"} to go`, touched ? "green" : "muted", () => { state.mailStage = "call"; render(); }),
    tile(byDay.get(today) || 0, "Emails today", (byDay.get(today) || 0) ? "around 8am their time" : "nothing due today", "navy", () => pickDay(today)),
    tile(nextDay ? byDay.get(nextDay) : 0, nextDay ? `Going out ${dayOf(`${nextDay}T12:00:00`).split(",")[0]}` : "Next run", nextDay ? shortDate(`${nextDay}T12:00:00`) : "", "navy", nextDay ? () => pickDay(nextDay) : null),
    tile(tot.rfqs, "RFQs from emails", `last 60 days, from ${tot.sent} emails`, "green"),
    tile(tot.stops, "Asked to stop or slow down", "they're off or paused", tot.stops ? "red" : "muted"),
  ]);

  // 2. Where everyone is: the sequence, left to right, and the ones off to the side.
  const counts = {};
  const members = {};
  for (const a of accounts) { const k = mailStageOf(a, held); counts[k] = (counts[k] || 0) + 1; (members[k] = members[k] || []).push(a); }
  const stageCard = (st, arrow) => el("button", { class: `stage s-${st.tone}${state.mailStage === st.k ? " on" : ""}`, onclick: () => { state.mailStage = state.mailStage === st.k ? null : st.k; render(); } }, [
    el("b", { class: "mono", text: counts[st.k] || 0 }), el("span", { class: "tl", text: st.label }), el("span", { class: "sub2", text: st.sub }),
    arrow ? el("i", { class: "arrow", "aria-hidden": "true", text: "→" }) : null,
  ]);
  const picked = state.mailStage && (members[state.mailStage] || []);
  const stageList = picked ? el("div", { class: "stagelist" }, [
    el("div", { class: "head" }, [
      el("h3", { text: `${[...MAIL_STAGES, ...MAIL_SIDE].find((x) => x.k === state.mailStage).label} · ${picked.length}` }),
      el("button", { class: "linkbtn small3", text: "Close", onclick: () => { state.mailStage = null; render(); } }),
    ]),
    !picked.length ? el("p", { class: "empty", text: "Nobody here right now." }) : el("div", { class: "slrows" }, picked
      .sort((x, y) => (x.cadence?.dueAt || "z").localeCompare(y.cadence?.dueAt || "z"))
      .map((a) => el("div", { class: "slrow" }, [
        el("a", { class: "co", href: closeLead(a.leadId), target: "_blank", rel: "noopener", text: a.company }),
        el("span", { class: "sub2", text: [a.contact.name, a.contact.email].filter(Boolean).join(" · ") }),
        el("span", { class: "sl-step", text: state.mailStage === "call" || state.mailStage === "you" ? a.next.label
          : a.cadence ? `${a.cadence.nth} email${a.cadence.nth === 1 ? "" : "s"} ${a.cadence.track === "cold" ? "so far, haven't talked yet" : "since you talked"}` : "" }),
        el("span", { class: "sub2", text: ["intro", "cold", "rhythm", "monthly", "call"].includes(state.mailStage) && a.cadence?.dueAt ? `next email ${shortDate(a.cadence.dueAt)}` : a.warmth?.paused?.why || "" }),
      ]))),
  ]) : null;
  const flow = el("section", { class: "mcard" }, [
    el("div", { class: "mhead" }, [el("h2", { text: "Where everyone is" }), el("span", { class: "sub2", text: `${accounts.length} accounts with a line card. Click a box to see who.` })]),
    el("div", { class: "stages" }, MAIL_STAGES.map((st, i) => stageCard(st, i < MAIL_STAGES.length - 1))),
    el("div", { class: "stages side" }, MAIL_SIDE.map((st) => stageCard(st, false))),
    stageList,
  ]);

  // 3. The next two weeks, a bar a day.
  const max = Math.max(1, ...byDay.values());
  const cal = el("section", { class: "mcard" }, [
    el("div", { class: "mhead" }, [el("h2", { text: "Next two weeks" }), el("span", { class: "sub2", text: state.mailDay ? `Showing ${dayOf(`${state.mailDay}T12:00:00`)} below.` : "Click a day to see who." })]),
    el("div", { class: "cal" }, days.slice(0, 12).map((d) => el("button", { class: `calday${state.mailDay === d ? " on" : ""}${d === today ? " today" : ""}`, title: `${byDay.get(d)} emails`, onclick: () => pickDay(d) }, [
      el("span", { class: "mono n", text: byDay.get(d) }),
      el("span", { class: "bar", style: `height:${Math.max(4, Math.round((byDay.get(d) / max) * 64))}px` }),
      el("span", { class: "dl", text: d === today ? "Today" : new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short" }) }),
      el("span", { class: "sub2", text: shortDate(`${d}T12:00:00`) }),
    ]))),
  ]);

  // 4. Calls the sequence is asking for.
  // In the board's priority order: clicks, then the intro-done flags, then the longest quiet.
  const calls = (members.call || []).slice().sort((x, y) => ((x.callAsk && x.callAsk.rank) ?? 999) - ((y.callAsk && y.callAsk.rank) ?? 999));
  const callCard = el("section", { class: "mcard" }, [
    el("div", { class: "mhead" }, [el("h2", { text: `Calls to make · ${calls.length}` }), el("span", { class: "sub2", text: "Top first: clicked your email, intro done with nothing back, then quiet 3 business days. Work down; what's left is here tomorrow." })]),
    !calls.length ? el("p", { class: "empty", text: "None right now." }) : el("div", { class: "slrows" }, calls.slice(0, 12).map((a) => el("div", { class: "slrow" }, [
      el("a", { class: "co", href: closeLead(a.leadId), target: "_blank", rel: "noopener", text: a.company }),
      el("span", { class: "sub2", text: a.contact.phone || a.contact.email || "" }),
      el("span", { class: `sl-step${/clicked/.test(a.next.label) ? " hot" : ""}`, text: a.next.label }),
      el("span", { class: "sub2", text: a.cadence?.dueAt ? `emails keep going, next ${shortDate(a.cadence.dueAt)}` : "" }),
    ]))),
    calls.length > 12 ? el("p", { class: "sub2", text: `And ${calls.length - 12} more: click "Call them" above.` }) : null,
  ]);

  // 5. Added today (10/14): every account whose line card went out today, and where it starts.
  const added = accounts.filter((a) => a.cardSentAt && localDay(a.cardSentAt) === today).sort((x, y) => x.cardSentAt.localeCompare(y.cardSentAt));
  const talkedN = added.filter((a) => a.cadence && a.cadence.track === "talked").length;
  const addedCard = el("section", { class: "mcard" }, [
    el("div", { class: "mhead" }, [
      el("h2", { text: `Added today · ${added.length}` }),
      el("span", { class: "sub2", text: added.length ? `${talkedN} talked to the buyer, ${added.length - talkedN} from the front desk. Tap a result after every call so each one lands on the right track.` : "Line cards you send today show up here." }),
    ]),
    !added.length ? el("p", { class: "empty", text: "No new line cards yet today." }) : el("div", { class: "slrows" }, added.map((a) => el("div", { class: "slrow" }, [
      el("a", { class: "co", href: closeLead(a.leadId), target: "_blank", rel: "noopener", text: a.company }),
      el("span", { class: "sub2", text: [new Date(a.cardSentAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), a.contact.name].filter(Boolean).join(" · ") }),
      el("span", { class: `sl-step${a.cadence && a.cadence.track === "talked" ? "" : " cold"}`, text: a.cadence && a.cadence.track === "talked" ? "Talked to the buyer" : "Email from the front desk" }),
      el("span", { class: a.cadence && a.cadence.eligible ? "sub2" : "sub2 bad", text: a.cadence && a.cadence.eligible && a.cadence.dueAt ? `first email ${dayOf(a.cadence.dueAt).split(",")[0]} ${shortDate(a.cadence.dueAt)}` : `out: ${a.next.label}` }),
    ]))),
  ]);

  const how = el("details", { class: "mhow" }, [
    el("summary", { text: "How the sequence works" }),
    el("ol", {}, [
      "You reach the buyer, or the front desk gives you their email. The line card goes out.",
      "Talked to the buyer: 3 emails (next morning, then 3 and 5 business days later). Email from the front desk: 2 emails (2 and 5 business days later).",
      "Then the app flags a call. The emails keep going while it waits: every 3 business days for steady buyers, weekly for project buyers and anyone you haven't talked to, every 3 weeks for occasional ones. After 6 with nothing back, monthly.",
      "Nobody goes more than 3 business days without hearing from you (occasional buyers: 2 weeks). When no email is due, they're on Calls to make. No daily limit on calls; the list is in priority order. Emails go at most 80 a day; extras go the next morning.",
      "After you reach someone, pick Next email in the side panel (tomorrow to 2 weeks) if you want a different start for the next round.",
      "Reach the buyer again and the next round starts from the top.",
      "Any time: a reply pauses it, a click on your email makes it a call today, an RFQ takes them out for good, and \"no\" or \"stop\" ends it.",
      "Every email ends with the same ask: please send me over an RFQ and we'll get you a quote back. They go out around 8am their time, Mondays after 10.",
    ].map((t) => el("li", { text: t }))),
  ]);
  return [tiles, newCardCard(), addedCard, flow, el("div", { class: "mcols" }, [cal, callCard]), how];
}

// ---------- Tasks (Walt 10/14: "why wouldn't you just create a new tasks section?") ----------
// Your open Close tasks: today first, then the next 7 days, then the overdue pile, folded.
// ---------- guest links (Walt 10/15): a private link that only sends line cards from your account ----------
async function loadGuests() {
  try { state.guests = (await api("/api/guests")).guests; } catch (e) { state.guestsErr = e.message; }
  render();
}
// ---------- the team (10/19): each rep's stats, and a password reset for a teammate. Admin (owner) only. ----------
async function loadTeam() {
  try { state.team = await api("/api/team"); } catch (e) { state.team = { error: e.message }; }
  render();
}
async function loadRoster() {
  try { state.roster = await api("/api/race/roster"); } catch (e) { state.roster = { error: e.message }; }
  render();
}
async function setRacing(r, racing) {
  state.rosterBusy = r.email; render();
  try { state.roster = await api("/api/race/roster", { email: r.email, racing }); }
  catch (e) { state.teamMsg = e.message; }
  state.rosterBusy = null; render();
}
async function loadTeamStats() {
  const p = state.teamPeriod || "week";
  state.teamStatsLoading = true; render();
  try { state.teamStats = await api(`/api/team/stats?p=${p}`); } catch (e) { state.teamStats = { error: e.message }; }
  state.teamStatsLoading = false; render();
}
function teamPage() {
  if (state.team === undefined) { state.team = null; loadTeam(); }
  if (state.teamStats === undefined) { state.teamStats = null; loadTeamStats(); }
  if (state.roster === undefined) { state.roster = null; loadRoster(); }
  const t = state.team, ts = state.teamStats;
  const period = state.teamPeriod || "week";
  const reset = async (r) => {
    if (!confirm(`Reset ${r.name}'s password?\n\nThey'll make a new one the next time they sign in: open the web app, type ${r.email}, and pick a new password. Their Close connection, leads and emails all stay.`)) return;
    state.teamBusy = r.email; render();
    try { await api("/api/team/reset-password", { email: r.email }); state.teamMsg = `Done. Tell ${r.name.split(" ")[0]} to open ${location.origin}, type ${r.email}, and make a new password (10+ characters). Then use the same one in the extension.`; }
    catch (e) { state.teamMsg = e.message; }
    state.teamBusy = null; await loadTeam();
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  const tile = (n, label, sub) => el("div", { class: "tstat" }, [el("b", { class: "mono", text: n ?? "–" }), el("span", { text: label }), sub ? el("span", { class: "sub2", text: sub }) : null]);
  const tiles = (s, rfqCompanies) => s ? [
    tile(s.dials, "Calls", `${s.companies} compan${s.companies === 1 ? "y" : "ies"}`),
    tile(s.reached, "Connections", `${pct(s.reached, s.dials)} of calls`),
    tile(s.voicemails, "Voicemails"),
    tile(s.lineCards, "Line cards sent"),
    tile(s.emailsSent, "Emails sent"),
    tile(s.replied, "Wrote back"),
    tile(s.rfqs, "RFQs promised"),
    tile(s.rfqReceived, "RFQs in"),
    rfqCompanies != null ? tile(rfqCompanies, "Companies with an RFQ", "all time") : null,
  ] : [];
  const statsOf = (email) => (ts && ts.reps ? ts.reps.find((x) => x.email === email) : null);
  const people = t && t.reps ? t.reps : [];
  const total = ts && ts.reps ? ts.reps.filter((x) => x.stats).reduce((acc, x) => { for (const k of ["dials", "companies", "reached", "voicemails", "lineCards", "emailsSent", "replied", "rfqs", "rfqReceived"]) acc[k] = (acc[k] || 0) + (x.stats[k] || 0); return acc; }, {}) : null;
  const chip = (k, label) => el("button", { class: `cardk${period === k ? " on" : ""}`, onclick: () => { state.teamPeriod = k; loadTeamStats(); } }, [label]);
  const card = (r) => {
    const st = statsOf(r.email);
    return el("div", { class: "tcard" }, [
      el("div", { class: "tcardhead" }, [
        el("div", {}, [el("h3", { text: r.name }), el("span", { class: "muted small3", text: `${r.email}${r.you ? " · you" : ""} · ${r.hasPassword ? `last sign-in ${when(r.lastLogin)}` : "hasn't signed in yet"}` })]),
        el("div", { class: "tcardacts" }, [
          gameSwitch(r),
          r.you || !r.hasPassword ? null : el("button", { class: "btn small", disabled: state.teamBusy === r.email, text: state.teamBusy === r.email ? "Resetting…" : "Reset password", onclick: () => reset(r) }),
        ]),
      ]),
      !ts || state.teamStatsLoading && !st ? el("p", { class: "loading", text: "Counting from Close…" })
        : st && st.error ? el("p", { class: "empty", text: `Couldn't load their numbers: ${st.error}` })
          : el("div", { class: "tstats" }, tiles(st && st.stats, st && st.rfqCompanies)),
    ]);
  };
  // West Game (10/25): who's in the competition on the Chrome extension. People who call but aren't BDRs can sit out.
  const gameSwitch = (r) => {
    const ro = state.roster;
    if (!ro || ro.error) return null;
    const on = !ro.excluded.includes(r.email.toLowerCase());
    return el("label", { class: `gameswitch${on ? " on" : ""}`, title: on ? "In West Game. Untick to leave them out." : "Not in West Game. Tick to put them in." }, [
      el("input", { type: "checkbox", checked: on, disabled: state.rosterBusy === r.email, onchange: (e) => setRacing(r, e.currentTarget.checked) }),
      el("span", { text: "West Game" }),
    ]);
  };
  return el("section", { class: "teampage" }, [
    el("div", { class: "head pagehead" }, [el("h1", { class: "ptitle", text: "Team" })]),
    el("p", { class: "muted small3", text: "Each person's numbers from Close, the same ones they see on their own home page. Only you can see this page. Tick West Game for the people who should be in the competition on the Chrome extension." }),
    el("div", { class: "heatcard" }, [el("span", { class: "label", text: "Show" }), chip("today", "Today"), chip("week", "This week"), chip("month", "This month"), chip("all", "All time"),
      state.teamStatsLoading ? el("span", { class: "muted small3", text: "Updating…" }) : null]),
    state.teamMsg ? el("p", { class: "gmsgok", text: state.teamMsg }) : null,
    !t ? el("p", { class: "loading", text: "Loading the team…" })
      : t.error ? el("p", { class: "empty", text: t.error })
        : el("div", { class: "teamlist" }, [
          ...people.map(card),
          total && people.length > 1 ? el("div", { class: "tcard ttotal" }, [el("div", { class: "tcardhead" }, [el("h3", { text: "Team total" })]), el("div", { class: "tstats" }, tiles(total, null))]) : null,
        ]),
  ]);
}

// ---------- the Chrome extension (10/19): download it, set it up, or have Claude set it up ----------
function extensionPrompt(server) {
  return [
    "Help me install the Westgate Sales Assistant Chrome extension on this computer. I just downloaded westgate-assistant-extension.zip (it's in my Downloads folder).",
    "",
    "1. Unzip it so the extension sits at ~/Westgate/westgate-assistant (make the folder if it's missing). If there's an older copy there, replace it. Don't change any of the extension's files.",
    "2. Open Google Chrome to chrome://extensions for me (on a Mac: open -a \"Google Chrome\" \"chrome://extensions\"). If that doesn't open it, tell me to type chrome://extensions into Chrome's address bar.",
    "3. Walk me through it one step at a time: turn on \"Developer mode\" (top right), click \"Load unpacked\", and pick the ~/Westgate/westgate-assistant folder. If it's already installed, I just click the reload arrow on its card instead.",
    "4. Pin it: click the puzzle piece next to Chrome's address bar, then the pin next to Westgate Sales Assistant.",
    `5. Click the extension's icon, then Sign in. The server address should already say ${server}. I sign in with my @westgatesupply.com email and the password I made in the web app. I'll type my password myself; never ask me for it.`,
    "6. To check it worked: open any lead in Close (app.close.com) and click the extension icon. The call card should open on the right.",
    "",
    "If anything looks different from these steps, tell me exactly what you see and wait for me before going on.",
  ].join("\n");
}
function extensionPage() {
  loadExtInfo();
  const x = state.ext || {};
  const server = location.origin;
  const prompt = extensionPrompt(server);
  const download = async () => {
    state.extBusy = true; state.extErr = null; render();
    try {
      const res = await fetch("/api/extension.zip", { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      const a = el("a", { href: url, download: "westgate-assistant-extension.zip" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { state.extErr = e.message; }
    state.extBusy = false; render();
  };
  const copy = () => { navigator.clipboard?.writeText(prompt).then(() => { state.extCopied = true; render(); setTimeout(() => { state.extCopied = false; render(); }, 2000); }).catch(() => {}); };
  const step = (n, kids) => el("li", {}, kids);
  // Already installed: update it in three steps, with a button that reloads it once the new files are in place.
  const have = installedExt();
  const behind = extBehind();

  // The one button that matters; the by-hand steps stay underneath for anyone it doesn't work for.
  const byHand = el("details", { class: "extbyhand" }, [
    el("summary", { text: "Or update it by hand" }),
    el("ol", { class: "extsteps" }, [
      el("li", {}, [el("button", { class: "btn small", disabled: !!state.extBusy, text: state.extBusy ? "Downloading…" : `Download ${x.version || "the update"}`, onclick: download })]),
      el("li", {}, ["Unzip it and put the new ", el("b", { text: "westgate-assistant" }), " folder where the old one is, replacing it."]),
      el("li", {}, ["In ", el("code", { text: "chrome://extensions" }), ", click the reload arrow on Westgate Sales Assistant."]),
    ]),
  ]);
  const updateBox = have && !behind && !state.upd
    ? el("div", { class: "extupdate" }, [el("p", { class: "extok", text: `✓ You're on the newest version (${have}).` }), el("div", { class: "extrow" }, [updateButton("btn small"), el("span", { class: "muted small3", text: "Puts the newest files in your extension folder again." })])])
    : el("div", { class: "extupdate behind" }, [
      el("h2", { class: "rfqh", text: have ? `Update from ${have} to ${x.version || "the newest"}` : `Update to ${x.version || "the newest version"}` }),
      el("p", { class: "muted small3", text: "No reinstalling: the app puts the newest files into the extension you already have. The first time only, Chrome asks which folder: pick Downloads (or wherever you unzipped it) and click Allow. After that it's one click." }),
      el("div", { class: "extrow" }, [updateButton(), updateStatus()]),
      byHand,
    ]);
  return el("section", { class: "extpage" }, [
    el("div", { class: "head pagehead" }, [el("h1", { class: "ptitle", text: "Chrome extension" })]),
    el("p", { class: "muted small3", text: "The side panel next to Close: the call card for each lead, after-call notes, line cards, your automatic emails and My leads. It uses this app, so there's nothing to run on your computer." }),
    updateBox,
    el("h2", { class: "rfqh", text: have ? "Installing it on another computer" : "First time? Install it" }),
    el("div", { class: "gnew" }, [
      el("button", { class: "btn primary", disabled: !!state.extBusy, text: state.extBusy ? "Downloading…" : `Download the extension${x.version ? ` (v${x.version})` : ""}`, onclick: download }),
      state.extErr || x.error ? el("span", { class: "bad small", text: state.extErr || x.error }) : null,
    ]),
    el("h2", { class: "rfqh", text: "Set it up yourself" }),
    el("ol", { class: "extsteps" }, [
      step(1, ["Unzip the download. Keep the ", el("b", { text: "westgate-assistant" }), " folder somewhere it'll stay, like a Westgate folder in your home folder (Chrome runs it from there)."]),
      step(2, ["In Chrome, go to ", el("code", { text: "chrome://extensions" }), " and turn on ", el("b", { text: "Developer mode" }), " (top right)."]),
      step(3, ["Click ", el("b", { text: "Load unpacked" }), " and pick the westgate-assistant folder."]),
      step(4, ["Pin it: the puzzle piece next to the address bar, then the pin next to Westgate Sales Assistant."]),
      step(5, ["Click its icon and sign in with your @westgatesupply.com email and this app's password. The server is already set to ", el("code", { text: server }), "."]),
      step(6, ["Open a lead in Close and click the icon: the call card opens on the right."]),
    ]),
    el("p", { class: "muted small3", text: "Before your emails can go out, your @westgatesupply.com email has to be connected in Close (Settings, Connected Accounts). To update later: download again, replace the folder, and click the reload arrow on the extension's card in chrome://extensions." }),
    el("h2", { class: "rfqh", text: "Or have Claude set it up" }),
    el("p", { class: "muted small3", text: "Download the zip first, then paste this into Claude (the Claude desktop app with Claude Code, so it can reach your files). It walks you through the clicks." }),
    el("textarea", { class: "extprompt", readonly: true, rows: 14, onclick: (e) => e.target.select() }, [prompt]),
    el("div", {}, [el("button", { class: "btn", text: state.extCopied ? "Copied" : "Copy the prompt", onclick: copy })]),
  ]);
}

function guestUpload(x) {
  const u = (state.guestUp || {})[x.id] || {};
  const set = (v) => { state.guestUp = { ...(state.guestUp || {}), [x.id]: v }; render(); };
  const input = el("input", { type: "file", accept: ".csv,.xlsx,.xls", style: "display:none", onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (x.list && !confirm(`Replace ${x.name}'s list "${x.list.name}" (${x.list.called} of ${x.list.total} called) with ${f.name}? Their outcomes on the old list go with it, so download it first if you want them.`)) return;
    set({ busy: true });
    try {
      const rows = await window.readSheet(f);
      const r = await api(`/api/guests/${x.id}/list`, { name: f.name.replace(/\.[^.]+$/, ""), rows });
      set({ msg: `${r.list.total} companies loaded for ${x.name.split(" ")[0]}${r.filled ? ` (${r.filled} phones filled in from Close)` : ""}.${r.notFound ? ` ${r.notFound} had no phone in Close and were left out.` : ""} They'll see them when they open their link.` });
      await loadGuests();
    } catch (err) { set({ error: err.message }); }
  } });
  return el("div", { class: "gi-up" }, [
    el("button", { class: "btn small", disabled: !!u.busy, text: u.busy ? "Loading… (filling phones in from Close can take a minute)" : x.list ? "Upload a new list for them" : "Upload their list", onclick: () => input.click() }), input,
    el("span", { class: "sub2", text: "CSV or Excel. A Close export works too: phones, states and contacts are filled in from Close." }),
    u.msg ? el("span", { class: "gmsgok small3", text: u.msg }) : null,
    u.error ? el("span", { class: "bad small", text: u.error }) : null,
  ]);
}

function guestsPage() {
  if (state.guests === undefined) { state.guests = null; loadGuests(); }
  const g = state.guestNew || {};
  const create = async () => {
    // What's typed now (10/21): the snapshot above is from before they typed, so it always looked empty.
    const box = document.querySelector(".gnew input.heatq");
    const cur = { ...(state.guestNew || {}), ...(box ? { name: box.value } : {}) };
    const name = (cur.name || "").trim();
    if (!name) { state.guestNew = { ...cur, error: "Type their name first." }; return render(); }
    state.guestNew = { ...cur, busy: true, error: null }; render();
    try {
      const r = await api("/api/guests", { name });
      state.guestNew = { link: r.link, for: r.guest.name };
      await loadGuests();
    } catch (e) { state.guestNew = { ...cur, busy: false, error: e.message }; render(); }
  };
  const toggle = async (x) => {
    try { await api(`/api/guests/${x.id}/active`, { active: !x.active }); await loadGuests(); } catch (e) { state.guestsErr = e.message; render(); }
  };
  const copy = (text) => { try { navigator.clipboard.writeText(text); state.guestNew = { ...state.guestNew, copied: true }; render(); } catch {} };
  const today = (x) => x.sends.filter((s) => new Date(s.at).toDateString() === new Date().toDateString()).length;
  return el("section", {}, [
    el("div", { class: "head pagehead" }, [el("h1", { class: "ptitle", text: "Guests" })]),
    el("p", { class: "muted small3", text: "A guest link does two things: a call list they upload and work through (outcomes go to Close as notes on the company), and line cards sent from your email. They type a company, a name and an email; it goes out from your Close account with the PDF, the lead is found or added in Close with a note saying who sent it, and the account joins your email sequence like any line card. Turn a link off and it stops working at once." }),
    el("div", { class: "gnew" }, g.link ? [
      el("p", {}, [el("strong", { text: `Link for ${g.for}` }), " (copy it now; it isn't shown again):"]),
      el("div", { class: "glinkrow" }, [el("input", { class: "glink", value: g.link, readonly: true, onclick: (e) => e.target.select() }), el("button", { class: "btn small", text: g.copied ? "Copied" : "Copy", onclick: () => copy(g.link) })]),
      el("button", { class: "linkbtn small3", text: "Make another", onclick: () => { state.guestNew = {}; render(); } }),
    ] : [
      el("input", { class: "heatq", placeholder: "Guest's name, e.g. Jake Miller", value: g.name || "", oninput: (e) => { state.guestNew = { ...state.guestNew, name: e.target.value }; }, onkeydown: (e) => { if (e.key === "Enter") create(); } }),
      el("button", { class: "btn", disabled: !!g.busy, text: g.busy ? "Making it…" : "Make a guest link", onclick: create }),
      g.error ? el("span", { class: "bad small", text: g.error }) : null,
    ]),
    state.guestsErr ? el("p", { class: "empty", text: state.guestsErr }) : null,
    state.guests === null ? el("p", { class: "loading", text: "Loading guests…" })
      : !state.guests.length ? el("p", { class: "empty", text: "No guest links yet." })
        : el("div", { class: "glist2" }, state.guests.slice().reverse().map((x) => el("div", { class: `gitem${x.active ? "" : " off"}` }, [
          el("div", { class: "gi-head" }, [
            el("strong", { text: x.name }),
            el("span", { class: "sub2", text: `${x.active ? "Active" : `Off since ${new Date(x.offAt).toLocaleDateString()}`} · ${today(x)} today · ${x.sends.length} total · made ${new Date(x.createdAt).toLocaleDateString()}` }),
            el("button", { class: x.active ? "btn small" : "btn small primary", text: x.active ? "Turn off" : "Turn back on", onclick: () => toggle(x) }),
          ]),
          // Their call list (10/15): how far along, how it's going, and the sheet back with their outcomes.
          x.list ? el("div", { class: "gi-list" }, [
            el("span", {}, [el("strong", { text: x.list.name }), ` · ${x.list.called} of ${x.list.total} called`]),
            ...Object.entries(x.list.by).sort((a, b) => b[1] - a[1]).map(([o, n]) => el("span", { class: "gi-oc", text: `${o} ${n}` })),
            el("button", { class: "linkbtn small3", text: "Download with their outcomes", onclick: async () => {
              const res = await fetch(`/api/guests/${x.id}/list.csv`, { headers: { authorization: `Bearer ${token}` } });
              if (!res.ok) { state.guestsErr = "Couldn't download that list."; return render(); }
              const url = URL.createObjectURL(await res.blob());
              const a = el("a", { href: url, download: `${x.list.name} - ${x.name}.csv` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
            } }),
          ]) : el("p", { class: "sub2", text: "No call list uploaded yet." }),
          // Upload their leads for them (10/21): the same as they would from their link.
          guestUpload(x),
          x.sends.length ? el("details", { class: "gi-sends" }, [el("summary", { text: "What they sent" }),
            el("ul", {}, x.sends.slice(0, 100).map((s) => el("li", {}, [
              el("a", { href: closeLead(s.leadId), target: "_blank", rel: "noopener", text: s.company }),
              ` · ${s.name ? `${s.name} ` : ""}${s.to}${s.newLead ? " · new lead" : ""} · ${new Date(s.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
            ])))]) : null,
        ]))),
  ]);
}

function tasksPage() {
  const tk = state.tasks;
  const done = async (t, btn) => {
    btn.disabled = true; btn.textContent = "…";
    try {
      await api(`/api/tasks/${t.id}/done`, {});
      for (const k of ["today", "upcoming", "overdue"]) tk[k] = tk[k].filter((x) => x.id !== t.id);
      render();
    } catch (e) { btn.disabled = false; btn.textContent = "Done"; alert(e.message); }
  };
  const when = (iso, withDay) => new Date(iso).toLocaleString([], withDay ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" });
  const row = (t, withDay) => el("div", { class: "trow" }, [
    el("span", { class: "mono twhen", text: when(t.due, withDay) }),
    el("a", { class: "co", href: closeLead(t.leadId), target: "_blank", rel: "noopener", text: t.company || "Open lead" }),
    el("details", { class: "ttext" }, [el("summary", { text: t.title }), el("p", { class: "sub2 wrap", text: t.text })]),
    el("button", { class: "btn small", text: "Done", title: "Mark it complete in Close", onclick: (e) => done(t, e.currentTarget) }),
  ]);
  if (!tk) return el("section", { class: "mdash" }, [el("div", { class: "head pagehead" }, [el("h1", { class: "ptitle", text: "Tasks" })]), el("p", { class: "loading", text: "Reading your tasks from Close…" })]);
  const byDay = new Map();
  for (const t of tk.upcoming) { const d = new Date(t.due).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }); (byDay.get(d) || byDay.set(d, []).get(d)).push(t); }
  const showAll = !!state.tasksAll;
  return el("section", { class: "mdash" }, [
    el("div", { class: "head pagehead" }, [
      el("h1", { class: "ptitle", text: "Tasks" }),
      el("button", { class: "btn small", text: "Refresh", onclick: async () => { state.tasks = null; render(); state.tasks = await api("/api/tasks").catch(() => null); render(); } }),
    ]),
    el("p", { class: "muted small3", text: "Your open tasks in Close. Since 10/12 a task is only made for a name to call or a time the buyer gave you; the rest of your calls come from Calls to make on the Automatic emails tab. Done marks it complete in Close." }),
    el("section", { class: "mcard" }, [
      el("div", { class: "mhead" }, [el("h2", { text: `Due today · ${tk.today.length}` })]),
      !tk.today.length ? el("p", { class: "empty", text: "Nothing due today." }) : el("div", { class: "trows" }, tk.today.map((t) => row(t, false))),
    ]),
    el("section", { class: "mcard" }, [
      el("div", { class: "mhead" }, [el("h2", { text: `Next 7 days · ${tk.upcoming.length}` })]),
      !tk.upcoming.length ? el("p", { class: "empty", text: "Nothing coming up this week." })
        : el("div", { class: "trows" }, [...byDay.entries()].flatMap(([d, list]) => [el("p", { class: "label tday", text: d }), ...list.map((t) => row(t, false))])),
    ]),
    el("details", { class: "mcard tover" }, [
      el("summary", {}, [el("span", { class: "h2like", text: `Overdue · ${tk.overdue.length}` }), el("span", { class: "sub2", text: " Mostly from before 10/12, when every voicemail and no-answer made a callback." })]),
      el("div", { class: "trows" }, (showAll ? tk.overdue : tk.overdue.slice(-50).reverse()).map((t) => row(t, true))),
      tk.overdue.length > 50 ? el("button", { class: "linkbtn small3", text: showAll ? "Show the newest 50" : `Show all ${tk.overdue.length}`, onclick: () => { state.tasksAll = !showAll; render(); } }) : null,
    ]),
  ]);
}

// Slow down (Walt 10/19): fewer automatic emails a day, without turning them off. The rest wait their turn.
function paceBox(au) {
  const pick = async (cap) => {
    state.mailBusy = true; render();
    try {
      const dry = await api("/api/automations/pace", { daily_cap: cap, dry_run: true });
      let pull = false;
      if (dry.pulled > 0) pull = confirm(`${dry.queued} emails are queued to go out this morning. Pull back ${dry.pulled} so only ${cap} go today? They go back in line for the next mornings.\n\nOK: pull them back. Cancel: today stays as is, the new limit starts tomorrow.`);
      const r = await api("/api/automations/pace", { daily_cap: cap, pull_back_today: pull });
      state.paceMsg = cap >= au.fullCap ? "Back to full speed." : `Slowed to ${cap} a day.${r.today && r.today.pulled ? ` Pulled back ${r.today.pulled} of today's.` : ""}`;
      state.paceOpen = false;
    } catch (e) { alert(e.message); }
    state.mailBusy = false;
    await reloadAutos();
  };
  const label = (n) => (n === au.fullCap ? `Full speed · ${n} a day` : `${n} a day`);
  return el("div", { class: "pacebox" }, [
    el("p", {}, [el("strong", { text: "How many automatic emails a day? " }), "Anyone over the limit waits for the next morning, most overdue first. Nobody's dropped."]),
    el("div", { class: "pacechips" }, (au.paces || [au.fullCap, 40, 20, 10]).map((n) => el("button", { class: `btn small${n === au.dailyCap ? " primary" : ""}`, disabled: state.mailBusy || n === au.dailyCap, text: label(n), onclick: () => pick(n) }))),
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
      const lines = [
        r.planned.length ? `Scheduled ${r.planned.length} email${r.planned.length === 1 ? "" : "s"}. They're under Coming up.` : "No emails are due today.",
        ...(r.skipped || []).map((x) => `Not scheduled, ${x.company}: ${x.why}`),
      ];
      alert(lines.join("\n"));
    } catch (e) { alert(e.message); }
    state.mailBusy = false;
    await reloadAutos();
    load(true);
  };
  let rows = au ? mailRows(au, state.mailTab) : [];
  if (au && state.mailTab === "upcoming" && state.mailDay) rows = rows.filter((m) => localDay(m.sortAt) === state.mailDay);
  return el("section", { class: "mdash" }, [
    el("div", { class: "head pagehead" }, [
      el("h1", { class: "ptitle", text: "Automatic emails" }),
      au ? el("div", { class: "acts" }, [
        el("span", { class: `switch${au.enabled ? " on" : ""}` }, [el("i"), au.enabled ? "On" : "Off"]),
        el("button", { class: "btn small", disabled: state.mailBusy, text: au.enabled ? "Turn off" : "Turn on", onclick: toggle }),
        el("button", { class: `btn small${au.dailyCap < au.fullCap ? " slowon" : ""}`, disabled: state.mailBusy, text: au.dailyCap < au.fullCap ? `Slowed: ${au.dailyCap} a day` : "Slow down", onclick: () => { state.paceOpen = !state.paceOpen; render(); } }),
        el("button", { class: "btn small", disabled: state.mailBusy, text: state.mailBusy ? "Working…" : "Plan today's emails now", onclick: planNow }),
      ]) : null,
    ]),
    au && state.paceOpen ? paceBox(au) : null,
    state.paceMsg ? el("p", { class: "muted small3", text: state.paceMsg }) : null,
    au && !au.enabled ? el("p", { class: "offnote", text: "Automatic emails are off. Everything below shows what would go out; nothing sends until you turn them on." }) : null,
    // Test mode (10/1): only Test Lead Fabrication gets them until it's turned off.
    au && au.testMode ? el("div", { class: "testnote" }, [
      el("p", {}, [el("strong", { text: "Test mode: " }), "each morning, one email goes to ", el("strong", { text: "Test Lead Fabrication" }), " only, with its meme, so you can see how it lands. No real company gets anything."]),
      el("button", { class: "btn small", disabled: state.mailBusy, text: "Turn off test mode", onclick: async () => {
        if (!confirm("Turn off test mode? From the next morning run, the emails in Coming up go to the real companies.")) return;
        state.mailBusy = true; render();
        await api("/api/automations/test-mode", { on: false }).catch((e) => alert(e.message));
        state.mailBusy = false; reloadAutos();
      } }),
    ]) : null,
    ...(au ? mailDashboard(au) : [el("p", { class: "loading", text: "Loading…" })]),
    au && au.scoreboard && au.scoreboard.length ? scoreboardTable(au.scoreboard) : null,
    el("div", { class: "mlist" }, [
      el("div", { class: "mhead" }, [el("h2", { text: "Every email" }), state.mailDay && state.mailTab === "upcoming" ? el("button", { class: "linkbtn small3", text: `Showing ${dayOf(`${state.mailDay}T12:00:00`)} · show all`, onclick: () => { state.mailDay = null; render(); } }) : null]),
      el("div", { class: "tabs" }, MAIL_TABS.map(([k, label]) => el("button", {
        class: `tab${state.mailTab === k ? " on" : ""}`, onclick: () => { state.mailTab = k; if (k !== "upcoming") state.mailDay = null; render(); },
      }, [label, el("span", { class: "c mono", text: au ? mailRows(au, k).length : "–" })]))),
      !au ? null
        : !rows.length ? el("p", { class: "empty", text: { upcoming: "No automatic emails due in the next two weeks.", sent: "Nothing sent automatically in the last week.", other: "Nothing skipped or stopped." }[state.mailTab] })
          : el("div", { class: "grid x3d" }, [
            el("div", { class: "gr mgr gh" }, ["When", "Account", "Step", "Status", ""].map((h) => el("span", { class: "label", text: h }))),
            ...rows.flatMap(mailRow),
          ]),
    ]),
    au ? el("details", { class: "mhow" }, [el("summary", { text: "Memes" }), memeLibrary()]) : null,
  ]);
}

function mailRow(m) {
  const open = !!state.mailOpen[m.id];
  const when = m.status === "sent" ? m.statusAt : ["scheduled", "planned"].includes(m.status) ? m.scheduledFor : m.statusAt;
  const hold = async (e, on, days) => { e.stopPropagation(); e.currentTarget.disabled = true; await api(`/api/leads/${m.leadId}/hold`, { hold: on, days: days || null }).catch((err) => alert(err.message)); await reloadAutos(); load(true); };
  const row = el("div", { class: `gr mgr${open ? " open" : ""}`, onclick: () => { state.mailOpen[m.id] = !open; render(); } }, [
    m.future ? el("span", { class: "whenf" }, [el("span", { class: "mono", text: dayOf(when) }), el("span", { class: "sub2", text: new Date(when).getDay() === 1 ? "after 10am their time" : "around 8am their time" })])
      : el("span", { class: "mono", text: when ? timeOf(when) : "–" }),
    el("div", { class: "acct macct" }, [
      m.future && m.meme ? el("img", { class: "memethumb", src: m.meme.url, alt: "", loading: "lazy" }) : null,
      el("div", {}, [
        el("a", { class: "co", href: closeLead(m.leadId), target: "_blank", rel: "noopener", text: m.company, onclick: (e) => e.stopPropagation() }),
        el("span", { class: "sub2", text: m.to }),
      ]),
    ]),
    el("span", { class: "steppill", text: stepOf(m) }),
    el("span", { class: `mstatus ${m.status}`, text: STATUS_TEXT[m.status] || m.status }),
    el("div", { class: "acts" }, [
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
    m.future ? el("div", { class: "row coolrow", onclick: (e) => e.stopPropagation() }, [el("span", { class: "muted small3", text: "Cool them off for" }), ...COOL_OPTIONS.map(([days, label]) => el("button", { class: days ? "btn small" : "linkbtn small3", text: label, title: days ? `Out of the automatic emails for ${label}, then back in on their own` : "Out until you put them back", onclick: (e) => hold(e, true, days) }))]) : null,
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
