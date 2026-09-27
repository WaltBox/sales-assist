// Westgate Assistant side panel.
//
// Screens (per the side panel design):
//   pre-call  → call card for the lead open in Close
//   on call   → dark, large script + "before you hang up" checklist
//   ended     → one tap (Reached buyer / Got a name / Voicemail / No answer) saves
//               status + callback to Close now; the rest builds in the background
//   queue     → follow-ups ready to approve, one card per call
//   review    → one call's proposed contacts/tasks/email/status, approve or edit
//
// The panel watches the lead's calls through the server at all times, so a new
// dial always switches to the on-call screen, even if an old call's follow-ups
// are pending (those live in the queue, not on the call screen).
// All server text is rendered with textContent, never as HTML.

const PREVIEW = typeof chrome === "undefined" || !chrome.tabs;
const POLL_MS = 3000;
const EMPTY = () => ({ note: null, contacts: [], contact_updates: [], tasks: [], email: null, status: null });

let settings = { server: "", token: "", theme: "light" };
let view = "lead"; // lead | queue | item | draft | site | stats | week
const leads = new Map(); // leadId -> state; S is the lead open in Close
let S = null;
let queue = { items: [], ready: 0, building: 0 };
let itemView = null; // { id, off:Set, open:Set, busy, results, chat:[], chatBusy, error }
let listView = null;
let listInfo = null;
let siteAccess = PREVIEW;
let myLine = null; // the rep's own Close number, from /api/me
let myEmail = null; // the rep's sending address, read back on the call
let myName = null; // "Walt", for the follow-up script
const drafts = {}; // text typed into inputs, kept across re-renders

// ---------- server ----------

async function api(path, body) {
  const res = await fetch(`${settings.server}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${settings.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

// ---------- DOM helpers ----------

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "value") n.value = v;
    else if (k === "checked") n.checked = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

/** An input/textarea whose text survives re-renders (stored in drafts[key]). */
function draftInput(key, props = {}, multiline = false) {
  const n = el(multiline ? "textarea" : "input", { ...props, "data-key": key, value: drafts[key] ?? props.value ?? "" });
  n.addEventListener("input", () => { drafts[key] = n.value; if (props.oninput) props.oninput(n.value); });
  return n;
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const agoText = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`;
};
const prettyPhone = (p) => {
  const m = (p || "").replace(/[^\d]/g, "").match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p || "";
};

// ---------- which lead is open ----------

const leadFromUrl = (url) => ((url || "").match(/^https:\/\/app\.close\.com\/lead\/(lead_[A-Za-z0-9]+)/) || [])[1] || null;
const smartViewFromUrl = (url) => ((url || "").match(/^https:\/\/app\.close\.com\/.*?(save_[A-Za-z0-9]+)/) || [])[1] || null;

async function activeUrl() {
  if (PREVIEW) return "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return (tab && tab.url) || "";
}

function newLead(leadId) {
  return {
    leadId, phase: "loading", header: null, brief: null, flags: [], error: null,
    since: new Date(Date.now() - 15_000).toISOString(), // calls placed after the lead was opened
    callId: null, callStartedAt: null, handledCallId: null, ended: null, outcome: null,
    captured: new Set(), chat: [], chatBusy: false, draft: null,
  };
}

async function syncLead() {
  const url = await activeUrl();
  const sv = smartViewFromUrl(url);
  if (sv && sv !== listView) { listView = sv; if (!PREVIEW) chrome.storage.local.set({ listView: sv }); warmList(null); }
  const id = PREVIEW ? new URLSearchParams(location.search).get("lead") : leadFromUrl(url);
  if (S && S.leadId === id) return;
  if (!id) { S = null; if (view !== "queue" && view !== "item") view = "lead"; render(); return; }
  const known = leads.get(id);
  S = known || newLead(id);
  leads.set(id, S);
  if (view === "site" || view === "draft") view = "lead";
  render();
  warmList(id);
  if (!known) loadBrief(S);
}

async function openLead(leadId) {
  if (PREVIEW) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.update(tab.id, { url: `https://app.close.com/lead/${leadId}/` });
}

async function warmList(leadId) {
  if (!listView || !settings.token) return;
  try { listInfo = await api(`/api/smart-views/${listView}/warm`, { lead_id: leadId }); } catch { listInfo = null; }
}

// ---------- call card ----------

async function loadBrief(st, refresh = false) {
  st.error = null;
  if (!st.brief) st.phase = "loading";
  render();
  try {
    const [r, rescue] = await Promise.all([
      api(`/api/leads/${st.leadId}/brief${refresh ? "?refresh=1" : ""}`),
      api(`/api/leads/${st.leadId}/rescue`).catch(() => ({ draft: null })),
    ]);
    // Their line card was never opened: the rescue email is drafted, ready to send once they pick up.
    if (!st.rescue || !st.rescue.sent) st.rescue = rescue.draft ? { draft: rescue.draft } : null;
    st.header = r.header;
    st.brief = r.brief;
    st.flags = r.flags || [];
    if (r.list) listInfo = r.list;
  } catch (e) {
    st.error = e.message;
  }
  if (st.phase === "loading") st.phase = "pre";
  if (st === S) render();
}

// ---------- following the call ----------

const SUGGEST = { answered: "reached_buyer", "vm-left": "voicemail", "vm-answer": "voicemail" };

async function poll() {
  const st = S;
  if (!st || !settings.token || st.phase === "loading") return;
  let cs;
  try { cs = await api(`/api/leads/${st.leadId}/call-state?since=${encodeURIComponent(st.since)}`); } catch { return; }
  if (st !== S || !cs || cs.state === "idle" || cs.callId === st.handledCallId) return;
  if (cs.state === "on_call" && cs.callId !== st.hungUpCallId && (st.phase !== "on" || st.callId !== cs.callId)) {
    st.phase = "on";
    st.lc = null; // a new call: a fresh line card send
    st.callId = cs.callId;
    st.callStartedAt = cs.startedAt || new Date().toISOString();
    st.captured = new Set();
    st.outcome = null;
    view = "lead";
    render();
  } else if (cs.state === "ended" && (st.phase !== "ended" || st.callId !== cs.callId)) {
    st.phase = "ended";
    st.callId = cs.callId;
    countDial(cs.callId);
    bumpCallCount(st, cs.callId);
    st.ended = { disposition: cs.disposition, duration: cs.duration, suggested: SUGGEST[cs.disposition] || "no_answer" };
    st.outcome = null;
    drafts[`note:${st.leadId}`] = "";
    view = "lead";
    render();
  }
}

function hungUp() {
  const st = S;
  st.hungUpCallId = st.callId; // Close may still say "in progress" for a few seconds
  countDial(st.callId);
  bumpCallCount(st, st.callId);
  st.phase = "ended";
  st.ended = { disposition: null, duration: st.callStartedAt ? (Date.now() - new Date(st.callStartedAt).getTime()) / 1000 : null, suggested: "reached_buyer" };
  st.outcome = null;
  render();
}

async function pickOutcome(outcome) {
  const st = S;
  if (st.outcome) return;
  st.outcome = { picked: outcome, busy: true };
  render();
  try {
    const r = await api(`/api/leads/${st.leadId}/outcome`, {
      outcome, note: drafts[`note:${st.leadId}`] || null, call_id: st.callId, rating: st.brief ? st.brief.rating : null,
    });
    st.outcome = { picked: outcome, busy: false, result: r, noteSent: drafts[`note:${st.leadId}`] || "" };
    st.handledCallId = st.callId;
    if (outcome === "reached_buyer" || outcome === "got_name") countReached(st.callId);
    refreshQueue();
    if (r.queued) watchBuild(st, st.outcome, r.queued);
  } catch (e) {
    st.outcome = { picked: outcome, busy: false, error: e.message };
  }
  render();
}

// Keep the call-ended screen current: when the transcript is read, show the
// callback it set ("call back in an hour or two" → today 12:30) and what was saved.
async function watchBuild(st, o, itemId) {
  o.watching = true;
  if (st === S) render();
  const until = Date.now() + 6 * 60 * 1000;
  while (Date.now() < until && st.outcome === o) {
    await new Promise((r) => setTimeout(r, 5000));
    let it;
    try { it = (await api("/api/queue")).items.find((x) => x.id === itemId); } catch { continue; }
    if (!it || it.state === "building") continue;
    o.watching = false;
    o.built = it;
    if (it.smartTask && o.result.task) {
      const oldWhen = o.result.task.when;
      o.result.saved = o.result.saved.map((x) => (x.endsWith(oldWhen) ? `${it.smartTask.title} ${it.smartTask.when}` : x));
      Object.assign(o.result.task, { when: it.smartTask.when, due_at: it.savedTaskAt || o.result.task.due_at });
    }
    refreshQueue();
    if (st === S && S.phase === "ended") render();
    return;
  }
  o.watching = false;
  if (st === S && S.phase === "ended") render();
}

// After the tap, Enter sends the note so it can set the callback ("call back in an hour").
function noteInput(st) {
  const key = `note:${st.leadId}`;
  const input = draftInput(key, { placeholder: 'e.g. "call back in an hour" or "Renee covering for Rob, back Oct 12"', maxlength: 1000, style: "margin-top:6px" });
  input.addEventListener("keydown", async (e) => {
    const o = st.outcome;
    if (e.key !== "Enter" || !o || !o.result || !o.result.queued) return;
    e.preventDefault();
    const note = (drafts[key] || "").trim();
    if (!note || note === o.noteSent) return;
    o.noteSent = note;
    try { await api(`/api/queue/${o.result.queued}/note`, { note }); } catch { return; }
    o.built = null;
    watchBuild(st, o, o.result.queued);
  });
  return input;
}

async function leaveEnded(next) {
  const st = S;
  // A line typed after the tap still reaches the background build.
  const note = drafts[`note:${st.leadId}`] || "";
  if (st.outcome && st.outcome.result && st.outcome.result.queued && note !== st.outcome.noteSent) {
    api(`/api/queue/${st.outcome.result.queued}/note`, { note }).catch(() => {});
  }
  st.phase = "pre";
  st.outcome = null;
  if (next) openLead(next.id); else render();
}

// ---------- queue ----------

async function loadMe() {
  if (!settings.token) return;
  try {
    const me = await api("/api/me");
    const line = (me.lines && me.lines[0]) || null;
    if (me.rep && me.rep.email && me.rep.email !== myEmail) { myEmail = me.rep.email; render(); }
    if (me.rep && me.rep.name) myName = me.rep.name.split(" ")[0];
    if (line && line !== myLine) {
      myLine = line;
      if (!PREVIEW) chrome.storage.local.set({ myLine: line });
      render();
    }
  } catch {}
}

async function refreshQueue() {
  if (!settings.token) return;
  try { queue = await api("/api/queue"); } catch { return; }
  if (view === "queue" || view === "item" || view === "lead") render();
}

// ---------- daily stats ----------
//
// The strip counts locally between syncs (a dial the moment a call ends, a
// reach the moment Reached/Got a name is tapped), deduped by call id, and
// re-syncs from Close every 10 minutes, on open, and once recent transcripts
// are in. When the two disagree, Close wins and the difference is logged.

const STATS_SYNC_MS = 10 * 60_000;
const TRANSCRIPT_GRACE_MS = 3 * 60_000;
let stats = null; // { day, server, dials, reached, dialIds:[], reachedIds:[], approxUntil, syncedAt }
let week = null;
let statsTimer = null;

async function loadStats() {
  if (PREVIEW) return;
  stats = (await chrome.storage.local.get("stats")).stats || null;
}
function saveStats() {
  if (!PREVIEW && stats) chrome.storage.local.set({ stats });
}

async function syncStats(fresh = false) {
  if (!settings.token) return;
  const local = stats && stats.server ? stats.dials : null;
  let s;
  try {
    s = await api(`/api/stats/today?${new URLSearchParams({ ...(fresh ? { fresh: "1" } : {}), ...(local !== null ? { local_dials: String(local) } : {}) })}`);
  } catch { return; }
  if (stats && stats.day === s.day && stats.server && (stats.dials !== s.dials || stats.reached !== s.reached)) {
    console.info(`[stats] Close wins: dials ${stats.dials} → ${s.dials}, reached ${stats.reached} → ${s.reached}`);
  }
  const sameDay = stats && stats.day === s.day;
  // Calls the panel saw end that Close hasn't listed yet still count, once.
  const pending = sameDay ? stats.dialIds.filter((id) => !s.callIds.includes(id) && Date.now() - (stats.seenAt[id] || 0) < 60_000) : [];
  stats = {
    day: s.day, server: s,
    dials: s.dials + pending.length,
    reached: s.reached,
    dialIds: [...s.callIds, ...pending],
    reachedIds: [],
    seenAt: sameDay ? stats.seenAt : {},
    approxUntil: sameDay ? stats.approxUntil : 0,
    syncedAt: Date.now(),
  };
  saveStats();
  scheduleStatsSync();
  if (view !== "item" && view !== "draft") render();
}

function scheduleStatsSync() {
  clearTimeout(statsTimer);
  // Sooner when a recent call's transcript is still on its way, so "~" clears on its own.
  const approx = stats && Math.max(stats.approxUntil || 0, stats.server && stats.server.approximate ? Date.now() + 60_000 : 0);
  const wait = approx && approx > Date.now() ? approx - Date.now() + 5_000 : STATS_SYNC_MS;
  statsTimer = setTimeout(() => syncStats(true), Math.min(wait, STATS_SYNC_MS));
}

/** Count a call that just ended (Close's ended event or "I just hung up"), once per call id. */
function countDial(callId) {
  if (!stats || !callId || stats.dialIds.includes(callId)) return;
  stats.dialIds.push(callId);
  stats.seenAt[callId] = Date.now();
  stats.dials += 1;
  stats.approxUntil = Date.now() + TRANSCRIPT_GRACE_MS;
  saveStats();
  scheduleStatsSync();
}
function countReached(callId) {
  if (!stats || !callId || stats.reachedIds.includes(callId)) return;
  stats.reachedIds.push(callId);
  stats.reached += 1;
  saveStats();
}

const statsApprox = () => !!stats && ((stats.server && stats.server.approximate) || Date.now() < (stats.approxUntil || 0));

function statsStrip() {
  const n = (v, word) => [el("b", { text: String(v) }), ` ${word}`];
  const sep = () => el("span", { class: "sep", text: " · " });
  if (!stats || !stats.server) return el("button", { class: "stats", text: "Today", onclick: openStats });
  const s = stats.server;
  const tilde = statsApprox() ? "~" : "";
  return el("button", { class: `stats${view === "stats" || view === "week" ? " on" : ""}`, title: "Today's numbers from Close", onclick: openStats }, [
    ...n(stats.dials, stats.dials === 1 ? "dial" : "dials"), sep(),
    ...n(tilde + stats.reached, "reached"), sep(),
    ...n(s.emailsSent, s.emailsSent === 1 ? "email" : "emails"), sep(),
    ...n(tilde + s.rfqs, s.rfqs === 1 ? "RFQ" : "RFQs"),
  ]);
}

function openStats() {
  if (view === "stats" || view === "week") { view = "lead"; render(); return; }
  view = "stats";
  render();
  syncStats(true);
}

function renderStats() {
  const s = stats && stats.server;
  const back = el("button", { class: "link", style: "align-self:flex-start", text: S && S.header ? `← Back to ${S.header.company}` : "← Back", onclick: () => { view = "lead"; render(); } });
  if (!s) return [header(null), el("main", { class: "page" }, [back, el("p", { class: "empty", text: "Loading today's numbers from Close…" })])];
  const t = statsApprox() ? "~" : "";
  const row = (label, value, sub) => el("div", { class: "srow" }, [
    el("span", { class: "k", text: label }),
    el("span", { class: "v" }, [el("b", { text: String(value) }), sub ? el("span", { class: "muted", text: ` ${sub}` }) : null]),
  ]);
  const synced = new Date(stats.syncedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return [header(null), el("main", { class: "page" }, [
    back,
    el("div", { class: "qhead" }, [el("h1", { text: "Today" }), el("span", { class: "muted", text: `Synced ${synced}` })]),
    el("div", { class: "card stable" }, [
      row("Dials", stats.dials),
      row("Companies", s.companies),
      row("Reached", t + stats.reached),
      row("Voicemails", t + s.voicemails),
      row("Emails sent", s.emailsSent),
      row("Line cards sent", s.lineCards),
      row("RFQ asked", t + (s.rfqAsked || 0), "benchmark"),
      row("RFQ promised → received", `${t}${s.rfqs} → ${s.rfqReceived || 0}`),
      row("Tasks created", s.tasks),
    ]),
    s.best ? el("button", { class: "card sbest", title: "Open in Close", onclick: () => openLeadTab(s.best.leadId) }, [
      el("p", { class: "label", text: "Best call" }),
      el("p", {}, [el("b", { text: s.best.company }), el("span", { class: "muted", text: ` · ${mmss(s.best.seconds)}` })]),
    ]) : null,
    s.pace ? el("div", { class: "card space" }, [
      el("p", { class: "label", text: "Pace" }),
      el("p", {}, [el("b", { text: `On pace for ${s.pace.onPaceFor}` }), el("span", { class: "muted", text: ` · ${s.pace.perHour}/hr until 5 PM` })]),
    ]) : null,
    t ? el("p", { class: "muted small", text: "~ Reached, voicemails and RFQs update when the last few minutes of transcripts land." }) : null,
    el("button", { class: "btn", text: "This week →", onclick: openWeek }),
  ])];
}

async function openWeek() {
  view = "week";
  render();
  try { week = await api("/api/stats/week"); } catch (e) { week = { error: e.message }; }
  if (view === "week") render();
}

function renderWeek() {
  const back = el("button", { class: "link", style: "align-self:flex-start", text: "← Today", onclick: () => { view = "stats"; render(); } });
  const page = el("main", { class: "page" }, [back, el("div", { class: "qhead" }, [el("h1", { text: "This week" }), el("span", { class: "legend" }, [
    el("i", { class: "dot dials" }), " Dials ", el("i", { class: "dot reached" }), " Reached",
  ])])]);
  if (!week) page.append(el("p", { class: "empty", text: "Loading the week from Close…" }));
  else if (week.error) page.append(el("p", { class: "empty", text: week.error }));
  else {
    const max = Math.max(1, ...week.days.map((d) => d.dials));
    page.append(el("div", { class: "card week" }, week.days.map((d) => {
      // Today's bars use the live strip counts.
      const dials = d.today && stats ? Math.max(d.dials, stats.dials) : d.dials;
      const reached = d.today && stats ? Math.max(d.reached, stats.reached) : d.reached;
      return el("div", { class: `wday${d.today ? " today" : ""}` }, [
        el("span", { class: "nums", text: `${dials} · ${reached}` }),
        el("div", { class: "bars" }, [
          el("div", { class: "bar dials", style: `height:${(dials / max) * 100}%` }),
          el("div", { class: "bar reached", style: `height:${(reached / max) * 100}%` }),
        ]),
        el("span", { class: "day", text: d.label }),
      ]);
    })));
  }
  return [header(null), page];
}

function openLeadTab(leadId) {
  const url = `https://app.close.com/lead/${leadId}/`;
  if (PREVIEW) window.open(url, "_blank");
  else chrome.tabs.update({ url });
}

function openItem(id) {
  itemView = { id, off: new Set(), open: new Set(), busy: false, results: null, chat: [], chatBusy: false, error: null };
  view = "item";
  render();
}

function itemSummary(it) {
  const p = it.proposals || EMPTY();
  const bits = [];
  for (const u of p.contact_updates || []) bits.push(`update ${u.contact}${u.name ? ` → ${u.name}` : ""}`);
  if (p.contacts.length === 1) bits.push(`Contact: ${[p.contacts[0].name, p.contacts[0].title].filter(Boolean).join(", ")}${p.contacts[0].phone ? ` (${prettyPhone(p.contacts[0].phone)})` : ""}`);
  else if (p.contacts.length) bits.push(`${p.contacts.length} contacts`);
  if (p.note) bits.push("note");
  for (const t of p.tasks) bits.push(`task ${taskWhen(t.due_at, true)}`);
  if (p.email) bits.push(`email draft to ${p.email.to.map((r) => r.name || r.email).join(" and ")}`);
  if (p.status) bits.push(`status ${p.status.label}`);
  return bits.join(" · ") || it.summary || "Nothing new to save.";
}

function taskWhen(iso, short = false) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return new Intl.DateTimeFormat("en-US", short ? { month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

async function approveItem(it, proposals) {
  itemView && (itemView.busy = true);
  render();
  try {
    const r = await api(`/api/queue/${it.id}/approve`, proposals ? { proposals } : {});
    if (itemView && itemView.id === it.id) itemView.results = r.results;
    await refreshQueue();
    if (view === "item" && r.results.every((x) => x.ok)) setTimeout(() => { if (view === "item") { view = "queue"; render(); } }, 1200);
  } catch (e) {
    if (itemView) itemView.error = e.message; else alert(e.message);
  }
  if (itemView) itemView.busy = false;
  render();
}

// ---------- chat ----------

async function sendChat(text) {
  if (view === "item") {
    const iv = itemView;
    const history = iv.chat.slice(-20);
    iv.chat.push({ role: "user", text });
    iv.chatBusy = true;
    render();
    try {
      const r = await api(`/api/queue/${iv.id}/chat`, { message: text, history });
      iv.chat.push({ role: "assistant", text: r.reply });
      const i = queue.items.findIndex((x) => x.id === iv.id);
      if (i >= 0) queue.items[i] = { ...queue.items[i], ...r.item };
      iv.off = new Set();
    } catch (e) {
      iv.chat.push({ role: "assistant", text: `Sorry, that didn't work: ${e.message}` });
    }
    iv.chatBusy = false;
    render();
    return;
  }
  const st = S;
  if (!st) return;
  const history = st.chat.slice(-20);
  st.chat.push({ role: "user", text });
  st.chatBusy = true;
  render();
  try {
    const r = await api(`/api/leads/${st.leadId}/chat`, {
      message: text, history, proposals: (st.draft && st.draft.proposals) || EMPTY(), rating: st.brief ? st.brief.rating : null,
    });
    st.chat.push({ role: "assistant", text: r.reply });
    const n = countProps(r.proposals);
    if (n > 0) {
      st.draft = { proposals: r.proposals, off: new Set(), open: new Set(), warnings: r.warnings || [], results: null, busy: false };
      view = "draft";
    }
  } catch (e) {
    st.chat.push({ role: "assistant", text: `Sorry, that didn't work: ${e.message}` });
  }
  st.chatBusy = false;
  render();
}

const countProps = (p) => (p ? (p.note ? 1 : 0) + p.contacts.length + (p.contact_updates || []).length + p.tasks.length + (p.email ? 1 : 0) + (p.status ? 1 : 0) : 0);

function approved(p, off) {
  const on = (k) => !off.has(k);
  return {
    note: p.note && on("note") ? p.note : null,
    contacts: p.contacts.filter((_, i) => on(`contact:${i}`)),
    contact_updates: (p.contact_updates || []).filter((_, i) => on(`update:${i}`)),
    tasks: p.tasks.filter((_, i) => on(`task:${i}`)),
    email: p.email && on("email") ? p.email : null,
    status: p.status && on("status") ? p.status : null,
  };
}

// ---------- rendering ----------

function render() {
  // Keep focus and caret in whichever input the rep is typing in.
  const active = document.activeElement;
  const key = active && active.getAttribute && active.getAttribute("data-key");
  const caret = key && "selectionStart" in active ? active.selectionStart : null;

  const app = document.getElementById("app");
  if (!settings.token) app.replaceChildren(header(null), el("main", { class: "page" }, [
    el("p", { class: "empty", text: "Sign in with your Westgate email to get started." }),
    el("button", { class: "btn primary", text: "Sign in", onclick: () => chrome.runtime.openOptionsPage() }),
  ]));
  else if (view === "queue") app.replaceChildren(...renderQueue());
  else if (view === "item") app.replaceChildren(...renderItem());
  else if (view === "stats") app.replaceChildren(...renderStats());
  else if (view === "week") app.replaceChildren(...renderWeek());
  else if (view === "draft" && S && S.draft) app.replaceChildren(...renderDraft());
  else if (view === "site" && S) app.replaceChildren(...renderSite());
  else if (!S) app.replaceChildren(header(null), el("main", { class: "page" }, [
    el("p", { class: "empty", text: "Open a lead in Close to see its call card. Open a Smart View first and the next few leads get ready while you talk." }),
  ]));
  else if (S.phase === "on") app.replaceChildren(renderOnCall());
  else if (S.phase === "ended") app.replaceChildren(...renderEnded());
  else app.replaceChildren(...renderPre());

  if (key) {
    const n = app.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (n) { n.focus(); if (caret !== null) try { n.setSelectionRange(caret, caret); } catch {} }
  }
}

// The rep's own Close number, on every top bar, so it's there when a prospect asks for it.
function myLineButton(extra = "") {
  if (!myLine) return null;
  return el("button", {
    class: `myline ${extra}`.trim(),
    title: "Your Close number. Tap to copy.",
    text: myLine,
    onclick: (e) => { navigator.clipboard.writeText(myLine).catch(() => {}); e.currentTarget.classList.add("copied"); e.currentTarget.textContent = "Copied"; setTimeout(render, 900); },
  });
}

function header(phase, phaseClick) {
  return el("header", { class: "header" }, [
    el("div", { class: "brand" }, [el("b", { text: "Westgate" }), " Assistant"]),
    view !== "queue" && view !== "item" ? el("button", {
      class: `pill ${queue.ready ? "attn" : queue.building ? "neutral clickable" : "recent"}`,
      text: queue.ready ? `${queue.ready} to check` : queue.building ? `${queue.building} saving…` : "Recent",
      title: "Recent calls and what was saved to Close",
      onclick: () => { view = "queue"; refreshQueue(); render(); },
    }) : null,
    phase ? el(phaseClick ? "button" : "span", { class: `pill ${phase.cls || "phase"}`, text: phase.text, onclick: phaseClick }) : null,
    settings.token ? el("div", { class: "hrow2" }, [
      statsStrip(),
      myLineButton(),
    ]) : null,
  ]);
}

function chatBar(log, busy, placeholder) {
  const input = draftInput(`chat:${view}:${view === "item" ? itemView.id : S && S.leadId}`, { placeholder, maxlength: 4000, autocomplete: "off" });
  return el("footer", { class: "chatbar" }, [
    el("div", { class: "chatlog" }, log.map((m) => el("div", { class: `msg ${m.role}`, text: m.text }))),
    el("form", {
      class: "chatform",
      onsubmit: (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || busy) return;
        drafts[input.getAttribute("data-key")] = "";
        sendChat(text);
      },
    }, [input, el("button", { class: "send", type: "submit", "aria-label": "Send", text: "Send", disabled: busy })]),
  ]);
}

// --- pre-call ---

const FIT = { A: "Great fit", B: "Decent fit", C: "Weak fit", D: "Skip" };

function theirClock(h) {
  if (!h || !h.timeZoneId) return null;
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: h.timeZoneId, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const weekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  const time = new Intl.DateTimeFormat("en-US", { timeZone: h.timeZoneId, hour: "numeric", minute: "2-digit" }).format(now);
  const open = !weekend && mins >= 8 * 60 && mins < 16 * 60 + 30;
  const why = weekend ? "Weekend." : mins < 8 * 60 ? "Too early." : !open ? "After hours." : null;
  return { time, open, why };
}

// ---------- opener: highlight what we supply ----------

// Product words from the playbook's lines, plus the lead's own "what they'd buy".
const PRODUCTS = [
  "pipe", "pipes", "fittings", "flanges", "valves", "gaskets", "bolting", "bolts", "stud bolts", "fasteners", "hardware",
  "threaded rod", "all-thread", "anchors", "anchor bolts", "beam clamps", "u-bolts", "pipe supports", "hangers", "strut",
  "plate", "bar", "angle", "structural steel", "steel", "nuts", "washers", "hdg hardware", "hdg bolting", "tube fittings",
  "needle valves", "hydraulic fittings", "gauges", "coatings", "embeds", "pvf", "bar stock", "heavy hex nuts",
];
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The opener as text + <mark> nodes: runs of products ("pipe, fittings, hardware and fasteners") become one highlight. */
function highlightSupplies(text, buys) {
  const terms = new Set(PRODUCTS);
  for (const b of buys || []) for (const t of b.toLowerCase().split(/\s*(?:&|,|\/|\band\b)\s*/)) if (t.trim().length > 2) terms.add(t.trim());
  const re = new RegExp(`\\b(?:${[...terms].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})\\b`, "gi");
  const hits = [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
  // Merge products joined by commas, "and", "&" or "/" into one run.
  const runs = [];
  for (const h of hits) {
    const last = runs[runs.length - 1];
    if (last && /^(,\s*|\s+and\s+|,\s+and\s+|\s*&\s*|\s*\/\s*|,\s*&\s*)$/i.test(text.slice(last[1], h[0]))) last[1] = h[1];
    else runs.push([...h]);
  }
  const out = [];
  let at = 0;
  for (const [a, b] of runs) {
    if (a > at) out.push(text.slice(at, a));
    out.push(el("mark", { text: text.slice(a, b) }));
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// ---------- loading the call card ----------

// What the brief step is doing, cycled under the bar while it works.
const LOAD_STEPS = ["Pulling the Close record", "Checking their website", "Sizing up the fit", "Writing your opener"];
let loadStep = 0;

function leadLoader() {
  return el("div", { class: "leadload", role: "status", "aria-live": "polite" }, [
    el("img", { class: "leadload-mark", src: "brand/world-mark-filled.svg", alt: "" }),
    el("p", { class: "leadload-title", text: "Reading the lead" }),
    el("div", { class: "leadload-bar", "aria-hidden": "true" }, [el("i", { class: "leadload-track" }, [el("span")])]),
    el("p", { id: "leadload-step", class: "leadload-step", text: LOAD_STEPS[loadStep % LOAD_STEPS.length] }),
  ]);
}

// ---------- lead activity: how often we've called, how often they've opened our emails ----------

const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const personOf = (email) => { const n = (email || "").split("@")[0].split(/[._-]/)[0]; return n ? n[0].toUpperCase() + n.slice(1) : "They"; };
const HOT_OPENS = 3;

function callsChip(h, onCall = false) {
  const c = h && h.myCalls;
  if (!c) return null;
  const text = onCall ? `Call #${c.count + 1}` : c.count ? `Called ${c.count}×` : "First call";
  return el("span", { class: "chip3 calls", title: c.last ? `Last call ${shortDate(c.last)}` : "You haven't called this lead before", text });
}

const daysAgo = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
const sentAgo = (iso) => { const n = daysAgo(iso); return n === 0 ? "today" : n === 1 ? "1d ago" : `${n}d ago`; };

// Real opens only: a spam filter "opening" the email on arrival isn't a person (Walt 9/26).
function opensChip(h) {
  const o = h && h.opens;
  if (!o || !o.emails) return null;
  if (!o.total && o.maybe) {
    return el("span", { class: "chip3 opens", title: `${o.maybe} open${o.maybe === 1 ? "" : "s"} we can't place (not a known email app): maybe a person`, text: "Maybe opened" });
  }
  if (!o.total) {
    return el("span", {
      class: "chip3 opens none",
      title: o.scanned ? `Only a spam filter scanned it (${o.scanned}× within minutes of sending). No person has opened it.` : "No opens on the emails you sent.",
      text: `Not opened${o.lastSent ? ` · sent ${sentAgo(o.lastSent)}` : ""}`,
    });
  }
  const who = o.top ? personOf(o.top.who) : "They";
  return el("span", {
    class: `chip3 opens${o.total >= HOT_OPENS ? " hot" : ""}`,
    title: `${o.total} real opens across ${o.emails} sent email${o.emails === 1 ? "" : "s"}${o.last ? `, last ${shortDate(o.last)}` : ""}${o.top ? ` (${o.top.who}: ${o.top.count})` : ""}${o.scanned ? `. ${o.scanned} spam-filter scans not counted.` : ""}`,
    text: `${who} opened ${o.total}×`,
  });
}

// On the call: say where the line card is coming from and ask for a "got it" (Walt 9/26).
// On the call: the line card email is ready; send it while they're still on the phone (Walt 9/26).
async function loadLineCard(st) {
  const b = st.brief || {};
  st.lc = { ...(st.lc || {}), loading: true };
  try {
    const r = await api(`/api/leads/${st.leadId}/linecard/preview`, { to: st.lc.to || null, ask_for: b.ask_for ? b.ask_for.name : null, buys: b.buys || [] });
    st.lc = { ...st.lc, loading: false, preview: r, to: st.lc.to || r.to };
  } catch (e) {
    st.lc = { ...st.lc, loading: false, error: e.message };
  }
  if (st === S) render();
}

async function sendLineCardNow(st) {
  const b = st.brief || {};
  st.lc.sending = true;
  st.lc.error = null;
  render();
  try {
    const r = await api(`/api/leads/${st.leadId}/linecard/send`, { to: st.lc.to, ask_for: b.ask_for ? b.ask_for.name : null, buys: b.buys || [] });
    st.lc.sent = r;
  } catch (e) {
    st.lc.error = e.message;
  }
  st.lc.sending = false;
  render();
}

function lineCardAsk(st) {
  if (!st.lc) setTimeout(() => loadLineCard(st), 0);
  const lc = st.lc || {};
  const pv = lc.preview;
  const from = myEmail || "my email";
  const whenText = (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const items = ["Read their email address back", "Asked for a \"got it\" reply"];
  const checks = el("div", { class: "lcchecks" }, items.map((c) => el("label", {}, [
    el("input", { type: "checkbox", checked: st.captured.has(c), onchange: (e) => { if (e.target.checked) st.captured.add(c); else st.captured.delete(c); } }),
    el("span", { text: c }),
  ])));

  // Sent on this call: a slim confirmation and the line to say.
  if (lc.sent) {
    return el("section", { class: "lcbox" }, [
      el("header", { class: "lchead" }, [el("span", { class: "lct", text: "Line card" }), el("span", { class: "lcpill ok", text: `Sent ${whenText(lc.sent.at)}` })]),
      el("div", { class: "lcbody" }, [
        el("p", { class: "lcmeta", text: `To ${lc.sent.to}${lc.sent.threaded ? " · a reply in your earlier thread" : " · line card attached"}` }),
        el("p", { class: "lcquote", text: `"I just sent it. If it's not in your inbox, check spam and click Not spam."` }),
        checks,
      ]),
    ]);
  }
  const already = pv && pv.alreadySent;
  // They've already opened it: nothing to do but mention it. One line, with "Send again" if they need it.
  if (already && already.opened && !lc.expand) {
    return el("div", { class: "lcslim ok" }, [
      el("div", { class: "lcrow" }, [
        el("i", { class: "dot" }), el("span", { class: "lct", text: "Line card" }), el("span", { class: "lcs", text: `sent ${whenText(already.at)} · opened` }),
        el("button", { class: "lclink", text: "Send again", onclick: () => { st.lc = { ...lc, expand: true }; render(); } }),
      ]),
    ]);
  }
  return el("section", { class: "lcbox" }, [
    el("header", { class: "lchead" }, [
      el("span", { class: "lct", text: "Line card" }),
      el("span", { class: `lcpill ${already ? "warn" : ""}`, text: already ? `Sent ${whenText(already.at)} · not opened` : "Not sent yet" }),
    ]),
    el("div", { class: "lcbody" }, [
      el("p", { class: "lcquote", text: already
        ? `"I sent it over earlier. I'll send it again right now so it's at the top of your inbox. Mind firing back a quick 'got it'?"`
        : `"I'll send it right now from ${from}. Mind firing back a quick 'got it' when you see it? Sometimes it lands in junk."` }),
      el("label", { class: "lcfield" }, [
        el("span", { class: "label", text: "Send to" }),
        el("input", {
          id: "lc-to", type: "email", value: lc.to || "", placeholder: "their email", autocomplete: "off",
          oninput: (e) => { st.lc = { ...(st.lc || {}), to: e.target.value.trim() }; },
        }),
      ]),
      el("button", { class: "send lcsend", disabled: lc.sending || lc.loading || !lc.to, text: lc.sending ? "Sending…" : already ? "Send it again" : "Send line card now", onclick: () => sendLineCardNow(st) }),
      el("div", { class: "lcfoot" }, [
        pv ? el("details", { class: "lcprev" }, [el("summary", { text: pv.reply ? "Preview · reply in the same thread" : "Preview email" }), el("p", { class: "rbody", text: `${pv.subject}\n\n${pv.body}` })]) : el("span"),
      ]),
      lc.error ? el("p", { class: "err", text: lc.error }) : null,
      checks,
    ]),
  ]);
}

// The transcript isn't kept on the server (Close has it): load it when asked.
async function toggleTranscript(it, iv) {
  iv.showTranscript = !iv.showTranscript;
  render();
  if (!iv.showTranscript || iv.transcript) return;
  try {
    const r = await api(`/api/queue/${it.id}/transcript`);
    iv.transcript = r.transcript || "Close has no transcript for this call.";
  } catch (err) {
    iv.transcript = `Couldn't load it from Close (${err.message}).`;
  }
  render();
}

// ---------- rescue: send the line card again while they're on the phone (Walt 9/26) ----------

async function sendRescueNow(st) {
  const r = st.rescue;
  r.sending = true;
  render();
  try {
    await api(`/api/leads/${st.leadId}/rescue/send`, { draft_id: r.draft.id });
    r.sent = true;
  } catch (e) {
    r.error = e.message;
  }
  r.sending = false;
  render();
}

async function markRescueFound(st, found) {
  const r = st.rescue;
  r.marking = true;
  render();
  try {
    await api(`/api/leads/${st.leadId}/rescue/found`, { found, name: r.draft.to ? r.draft.to.replace(/\s*<.*$/, "") : null });
    r.marked = found ? "found" : "not_found";
  } catch (e) {
    r.error = e.message;
  }
  r.marking = false;
  render();
}

/** The three steps, the same on the call card, the call screen, and the web app. */
function rescueSteps(draft) {
  const who = (draft.to || "").replace(/\s*<.*$/, "").split(" ")[0] || "the buyer";
  return el("ol", { class: "rsteps" }, [
    el("li", {}, ["Once you have ", el("strong", { text: who }), " on the phone, hit ", el("strong", { text: "Send now" }), " (it's a reply in the same thread, line card attached)."]),
    el("li", {}, ["Tell them: ", el("em", { text: `"I just sent it. Check your inbox. If it's not there, check spam and click Not spam."` })]),
    el("li", {}, ["Mark whether they found it."]),
  ]);
}

function rescueBlock(st) {
  const r = st.rescue;
  const who = (r.draft.to || "").replace(/\s*<.*$/, "").split(" ")[0] || "them";
  if (r.marked === "found") return el("div", { class: "rescue done" }, [el("p", { class: "label", text: "Rescue" }), el("p", { text: `${who} found it. Saved to Close; RFQ check-ins can start.` })]);
  if (r.marked === "not_found") {
    return el("div", { class: "rescue" }, [
      el("p", { class: "label", text: "Couldn't find it: say" }),
      el("p", { class: "say2", text: `"It's probably being held by your IT filter. Could you send a quick email to ${myEmail || "me"}? I'll reply with the line card, and after that it'll come straight through."` }),
      el("p", { class: "note", text: "Or ask for another address. Saved to Close." }),
    ]);
  }
  if (r.sent) {
    return el("div", { class: "rescue" }, [
      el("p", { class: "label", text: "Sent. Say" }),
      el("p", { class: "say2", text: `"I just sent it. Check your inbox. If it's not there, check spam and click Not spam so my quotes come through."` }),
      el("p", { class: "label", style: "margin-top:8px", text: `Did ${who} find it?` }),
      el("div", { class: "row2" }, [
        el("button", { class: "btn small primary", disabled: r.marking, text: "Found it", onclick: () => markRescueFound(st, true) }),
        el("button", { class: "btn small", disabled: r.marking, text: "Couldn't find it", onclick: () => markRescueFound(st, false) }),
      ]),
      r.error ? el("p", { class: "err", text: r.error }) : null,
    ]);
  }
  return el("div", { class: "rescue" }, [
    el("p", { class: "label", text: "Rescue: they never opened the line card" }),
    rescueSteps(r.draft),
    el("details", { class: "rdraft" }, [
      el("summary", { text: `The email · to ${r.draft.to || ""}` }),
      el("p", { class: "rbody", text: r.draft.body }),
    ]),
    el("button", { class: "send rsend", disabled: r.sending, text: r.sending ? "Sending…" : "Send now", onclick: () => sendRescueNow(st) }),
    r.error ? el("p", { class: "err", text: r.error }) : null,
  ]);
}

// ---------- "Write a follow-up": one tap drafts a short bump in Close ----------

const followUps = {}; // leadId -> { busy } | { warn } | { done } | { error }

async function writeFollowUp(leadId, force = false) {
  followUps[leadId] = { busy: true };
  render();
  try {
    const r = await api(`/api/leads/${leadId}/follow-up`, { force });
    followUps[leadId] = r.status === "warn" ? { warn: r.warning } : { done: r };
  } catch (e) {
    followUps[leadId] = { error: e.message };
  }
  render();
}

/** The button, plus whatever happened last on this lead: writing, a warning to confirm, the saved draft, or an error. */
function followUpBlock(leadId, small = false) {
  const f = followUps[leadId] || {};
  const cls = `btn${small ? " small" : ""}`;
  if (f.warn) {
    return el("div", { class: "followup warn" }, [
      el("p", { text: f.warn }),
      el("div", { class: "row" }, [
        el("button", { class: `${cls} primary`, text: "Draft anyway", onclick: () => writeFollowUp(leadId, true) }),
        el("button", { class: cls, text: "Cancel", onclick: () => { delete followUps[leadId]; render(); } }),
      ]),
    ]);
  }
  return el("div", { class: "followup" }, [
    el("button", { class: cls, text: f.busy ? "Writing…" : "Write a follow-up", disabled: !!f.busy, onclick: () => writeFollowUp(leadId) }),
    f.done ? el("div", { class: "followup-done" }, [
      el("p", { class: "label", text: f.done.threaded ? "Draft saved in Close, in the thread" : "Draft saved in Close, new email" }),
      el("p", { class: "followup-subject", text: f.done.subject }),
      el("p", { class: "followup-body", text: f.done.body }),
      ...(f.done.warnings || []).map((w) => el("p", { class: "bad small", text: w })),
      el("button", { class: "link", text: "Open in Close to send", onclick: () => openLeadTab(leadId) }),
    ]) : null,
    f.error ? el("p", { class: "bad small", text: f.error }) : null,
  ]);
}

/** The lead's plan says wait: the next touch is already set for later. */
function holdBanner(plan) {
  return el("section", { class: "hold" }, [
    el("p", { class: "hold-title", text: "Don't call yet" }),
    el("p", { class: "hold-next" }, [
      el("strong", { text: `Next touch ${new Date(plan.until).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}` }),
      ` · ${plan.next}`,
    ]),
    el("p", { class: "hold-why", text: plan.reason }),
  ]);
}

/** "Today 9:44 AM", "Yesterday 2:10 PM", or "Wed Sep 24, 12:13 PM". */
function callWhen(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 864e5);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

/** The most recent call on this lead: when, how long, what happened, the note saved after it, and the transcript. */
function lastCallBlock(lc) {
  if (!lc) return el("section", { class: "plain lastcall" }, [el("p", { class: "label", text: "Last call" }), el("p", { class: "muted small", text: "No calls on this lead yet." })]);
  const person = lc.contact && !/main office|office|front desk/i.test(lc.contact) ? ` with ${lc.contact}` : "";
  const what = lc.connected ? `talked${person}` : lc.voicemail ? "left a voicemail" : "no answer";
  return el("section", { class: "plain lastcall" }, [
    el("p", { class: "label", text: "Last call" }),
    el("p", { class: "lastcall-line" }, [
      el("strong", { text: callWhen(lc.at) }),
      ` · ${mmss(lc.duration)} · `,
      el("span", { class: lc.connected ? "ok" : "muted", text: what }),
      lc.mine ? null : el("span", { class: "muted", text: " (another rep)" }),
    ]),
    lc.note ? el("p", { class: "lastcall-note", title: "Tap to expand", text: lc.note, onclick: (e) => e.currentTarget.classList.toggle("open") }) : null,
    lc.transcript ? el("details", { class: "lastcall-tx" }, [el("summary", { text: "Transcript" }), el("pre", { class: "transcript", text: lc.transcript })]) : null,
  ]);
}

/** A new call on this lead just ended: count it now instead of waiting for a reload. */
function bumpCallCount(st, callId) {
  const c = st && st.header && st.header.myCalls;
  if (!c || !callId || st.countedCallId === callId) return;
  st.countedCallId = callId;
  c.count += 1;
  c.last = new Date().toISOString();
}

function renderPre() {
  const st = S;
  const h = st.header;
  const b = st.brief;
  const out = [header({ text: "Pre-call" })];
  const page = el("main", { class: "page" });
  out.push(page);
  if (st.error) page.append(el("div", { class: "flag", text: st.error }));
  if (!h || !b) {
    page.append(leadLoader());
    out.push(chatBar(st.chat, true, "Ask or tell me anything about this lead…"));
    return out;
  }
  const clock = theirClock(h);
  const sub = [h.location, b.company_type, h.status].filter(Boolean).join(" · ");
  page.append(el("div", { class: "title" }, [
    el("h1", { text: h.company }),
    el("p", { class: "sub" }, [sub, h.website ? " · " : null, h.website ? el("button", { class: "link", text: "Website", onclick: () => { view = "site"; render(); } }) : null]),
  ]));
  for (const f of st.flags) page.append(el("div", { class: "flag", text: f }));

  // Details as small raised chips (not another box). The opener is the star.
  const plan = h.callPlan || null;
  const when = b.rating === "D" ? "don't call" : plan && plan.action === "hold" ? `hold till ${shortDate(plan.until)}` : clock && !clock.open ? "call later" : "call now";
  if (plan && plan.action === "hold" && b.rating !== "D") page.append(holdBanner(plan));
  if (st.rescue && st.rescue.draft && !st.rescue.sent) {
    page.append(el("div", { class: "rescuebanner" }, [
      el("p", { class: "label", text: "Rescue call: they never opened the line card" }),
      rescueSteps(st.rescue.draft),
    ]));
  }
  page.append(el("section", { class: "chips" }, [
    el("span", { class: `tile grade ${b.rating}`, title: "Lead rating", text: b.rating }),
    el("span", { class: "chip3", text: `${FIT[b.rating] || "Fit"} · ${when}` }),
    clock ? el("span", { id: "their-time", class: `chip3 ${clock.open ? "good" : "bad"}`, text: `${clock.time} there` }) : null,
    plan && plan.action === "call" && plan.due ? el("span", { class: "chip3 good", title: plan.reason, text: "Callback due" }) : null,
    plan && plan.action === "call" && !plan.due && plan.reason ? el("span", { class: "chip3 good", text: "They replied" }) : null,
    callsChip(h),
    opensChip(h),
    el("span", { class: "chip3 who" }, [el("span", { class: "muted", text: "Ask for " }), el("strong", { text: b.ask_for.name })]),
    h.phone ? el("button", { class: "chip3 mono", title: "Copy number", text: h.phone, onclick: (e) => { navigator.clipboard.writeText(h.phone).catch(() => {}); e.currentTarget.textContent = "Copied"; setTimeout(render, 900); } }) : null,
    clock && !clock.open && h.bestWindow ? el("span", { class: "chip3 soft", text: `Best: ${h.bestWindow}` }) : null,
  ]));
  if (b.ask_for.role || b.fit_summary) page.append(el("section", { class: "plain small-notes" }, [
    b.ask_for.role ? el("p", { class: "muted", text: `${b.ask_for.name}: ${b.ask_for.role}` }) : null,
    b.fit_summary ? el("p", { class: "fitsum", title: "Tap to expand", text: b.fit_summary, onclick: (e) => e.currentTarget.classList.toggle("open") }) : null,
  ]));

  page.append(lastCallBlock(h.lastCall));

  page.append(el("section", { class: "hero" }, [
    el("p", { class: "label", text: "Opener" }),
    el("p", { class: "opener" }, highlightSupplies(b.opener, b.buys)),
  ]));

  if (b.ask || b.objection) page.append(el("section", { class: "plain script" }, [
    b.ask ? el("div", { class: "block" }, [el("p", { class: "label", text: "The ask" }), el("p", { class: "say", text: b.ask })]) : null,
    b.objection ? el("div", { class: "block" }, [el("p", { class: "label", text: `If "${b.objection.replace(/[.?!]$/, "")}"` }), el("p", { class: "say", text: b.objection_response })]) : null,
  ]));

  if (b.buys && b.buys.length) page.append(el("section", { class: "plain tagsec" }, [el("p", { class: "label", text: "What they'd buy from us" }), el("ul", { class: "tags" }, b.buys.map((x) => el("li", { text: x })))]));
  if (b.heads_ups && b.heads_ups.length) page.append(el("section", { class: "heads" }, [el("p", { class: "label", text: "Heads-ups" }), el("ul", {}, b.heads_ups.map((x) => el("li", { text: x })))]));
  if (b.what_they_do) page.append(el("section", { class: "plain what" }, [el("p", { class: "label", text: "What they do" }), el("p", { text: b.what_they_do })]));
  page.append(el("div", { class: "linkrow" }, [
    listInfo && listInfo.position ? el("span", { class: "muted", text: `Lead ${listInfo.position} of ${listInfo.size >= 200 ? "200+" : listInfo.size}` }) : el("span"),
    el("button", { class: "link", text: "Rewrite card", onclick: () => loadBrief(st, true) }),
  ]));
  out.push(chatBar(st.chat, st.chatBusy, "Ask or tell me anything about this lead…"));
  return out;
}

// --- on call ---

/**
 * A follow-up call (they already got the line card): the script is about the line card and the RFQ,
 * not the intro. The product pitch stays, lower down, in case they ask what we supply (Walt 9/26).
 */
function followUpScript(st) {
  const pv = st.lc && st.lc.preview;
  const o = st.header && st.header.opens;
  const sent = (pv && pv.alreadySent) || (st.rescue ? { at: o && o.lastSent, opened: false } : null)
    || (o && o.emails ? { at: o.lastSent, opened: o.total > 0 } : null);
  if (!sent) return null;
  const b = st.brief || {};
  const n = b.ask_for && b.ask_for.name && !/purchas|whoever|buyer|main|office/i.test(b.ask_for.name) ? b.ask_for.name.split(" ")[0] : null;
  const me = myName || "Walt";
  const when = sent.at ? (Date.now() - new Date(sent.at).getTime() < 6 * 86400e3 ? new Date(sent.at).toLocaleDateString([], { weekday: "long" }) : `on ${new Date(sent.at).toLocaleDateString([], { month: "short", day: "numeric" })}`) : "earlier";
  const hi = n ? `Hi ${n}, it's ${me} with Westgate Supply` : `Hi, it's ${me} with Westgate Supply`;
  return {
    say: sent.opened
      ? `${hi}, following up on the line card I sent ${when}. Anything coming up I can quote for you?`
      : `${hi}. I sent over our line card ${when}. Did it come through?`,
    ifNot: sent.opened ? null : `"I just sent it again, so it's at the top of your inbox. If it's not there, check spam and click Not spam."`,
    objectives: ["Did they see the line card?", "Will they check their email and reply \"got it\"?", "Will they send an RFQ? When?"],
  };
}

/** Just the "what we supply" part of the opener, for the reference box: no greeting, no "we talked yesterday". */
function pitchOnly(opener) {
  const sentences = opener.split(/(?<=[.!?])\s+/);
  const kept = sentences
    .map((x) => x.replace(/^(hi|hey|hello)\b[^,]*,\s*(this is|it's)\s+\w+\s+(with|from)\s+westgate supply[,.]?\s*/i, ""))
    // "we spoke on the 26th about being your source for beam…" → "We can be your source for beam…"
    .map((x) => x.replace(/^(we|i) (talked|spoke|chatted)\b.*?\babout (being|becoming)\s+/i, "We can be "))
    // Short "We talked yesterday." sentences carry nothing to explain: drop them.
    .filter((x) => x.trim() && !/^(hi|hey|hello)\b/i.test(x) && !(/^(we|i) (talked|spoke|chatted)\b/i.test(x.trim()) && x.length < 50));
  const out = kept.join(" ").trim();
  return out ? out[0].toUpperCase() + out.slice(1) : opener;
}

function renderOnCall() {
  const st = S;
  const b = st.brief || {};
  const ask = b.ask_for || { name: "Purchasing", role: null };
  const elapsed = st.callStartedAt ? (Date.now() - new Date(st.callStartedAt).getTime()) / 1000 : 0;
  const fu = followUpScript(st);
  return el("div", { class: "oncall" }, [
    el("div", { class: "bar" }, [
      el("span", { class: "live" }), el("strong", { text: "On call" }), el("span", { id: "call-timer", class: "timer mono", text: mmss(Math.max(0, elapsed)) }),
      el("span", { class: "co", text: st.header ? st.header.company : "" }),
      st.header && st.header.website ? el("button", { class: "sitebtn", text: "Website", onclick: () => { view = "site"; render(); } }) : null,
      el("div", { class: "linerow" }, [myLineButton("callbar"), callsChip(st.header, true), opensChip(st.header)]),
    ]),
    el("div", { class: "body" }, [
      st.rescue ? rescueBlock(st) : lineCardAsk(st),
      el("div", {}, [el("p", { class: "label", text: "Ask for" }), el("p", { class: "askname", text: ask.name }), ask.role ? el("p", { class: "askrole", text: ask.role }) : null]),
      fu ? el("div", {}, [
        el("p", { class: "label", text: "Say" }), el("p", { class: "say" }, fu.say),
        fu.ifNot ? el("p", { class: "ifnot" }, [el("span", { class: "label", text: "If it didn't come through " }), fu.ifNot]) : null,
      ]) : null,
      fu ? el("div", { class: "checks" }, [
        el("p", { class: "label", text: "This call" }),
        ...fu.objectives.map((c) => el("label", {}, [
          el("input", { type: "checkbox", checked: st.captured.has(c), onchange: (e) => { if (e.target.checked) st.captured.add(c); else st.captured.delete(c); } }),
          el("span", { text: c }),
        ])),
      ]) : null,
      b.opener ? el("div", { class: fu ? "ifask" : "" }, [el("p", { class: "label", text: fu ? "If they ask what we supply" : "Say" }), el("p", { class: fu ? "say2x" : "say" }, highlightSupplies(fu ? pitchOnly(b.opener) : b.opener, b.buys))]) : null,
      b.buys && b.buys.length ? el("div", { class: "namethese" }, [el("p", { class: "label", text: "Name these" }), el("ul", { class: "tags" }, b.buys.map((x) => el("li", { text: x })))]) : null,
      b.ask ? el("div", {}, [el("p", { class: "label", text: "Ask" }), el("p", { class: "ask", text: b.ask })]) : null,
      b.objection ? el("div", { class: "box" }, [el("p", { class: "label", text: `If "${b.objection.replace(/[.?!]$/, "")}"` }), el("p", { text: b.objection_response })]) : null,
      b.capture && b.capture.length ? el("div", { class: "checks" }, [
        el("p", { class: "label", text: "Before you hang up" }),
        ...b.capture.map((c) => el("label", {}, [
          el("input", { type: "checkbox", checked: st.captured.has(c), onchange: (e) => { if (e.target.checked) st.captured.add(c); else st.captured.delete(c); } }),
          el("span", { text: c }),
        ])),
      ]) : null,
    ]),
    el("div", { class: "foot" }, [
      el("button", { class: "btn block", text: "I just hung up", onclick: hungUp }),
      el("p", { class: "note", text: "Switches automatically when Close ends the call" }),
    ]),
  ]);
}

// --- call ended: one tap ---

const OUTCOMES = [
  ["reached_buyer", "Reached buyer", "callback set from the call"],
  ["got_name", "Got a name", "callback set from the call"],
  ["voicemail", "Voicemail", "callback in 2 days, AM"],
  ["no_answer", "No answer", "callback · other half of day"],
];

function renderEnded() {
  const st = S;
  const o = st.outcome;
  const dur = st.ended && st.ended.duration ? ` · ${mmss(st.ended.duration)}` : "";
  const out = [header({ text: `Call ended${dur}`, cls: "neutral" })];
  const page = el("main", { class: "page" }, [
    el("div", { class: "title" }, [el("h1", { text: st.header ? st.header.company : "" }), el("p", { class: "sub", text: "One tap and move on. Follow-ups build in the background." })]),
    el("div", { class: "outcomes" }, OUTCOMES.map(([k, label, sub]) => el("button", {
      class: `outcome${o && o.picked === k ? " picked" : !o && st.ended && st.ended.suggested === k ? " suggested" : ""}`,
      disabled: !!o,
      onclick: () => pickOutcome(k),
    }, [el("strong", { text: label }), el("span", { text: sub })]))),
    el("div", {}, [el("p", { class: "label", text: "Anything to add? Optional", style: "margin: 4px 8px 6px" }),
      noteInput(st)]),
    st.header && st.header.opens && st.header.opens.emails > 0 ? el("div", { class: "afterfollow" }, [
      el("p", { class: "label", text: "You've emailed them before" }),
      followUpBlock(st.leadId, true),
    ]) : null,
  ]);
  if (o && o.busy) page.append(el("div", { class: "card loading" }, [el("span", { class: "spinner" }), "Saving to Close…"]));
  if (o && o.error) page.append(el("div", { class: "card savedbox err" }, [el("span", { class: "dot" }), el("p", { text: o.error })]));
  if (o && o.result) {
    const r = o.result;
    const failed = r.results.filter((x) => !x.ok);
    page.append(el("div", { class: "card savedbox" }, [el("span", { class: "dot" }), el("p", {}, [
      r.saved.length ? el("strong", { text: "Saved to Close now: " }) : null,
      r.saved.length ? `${r.saved.join(", ")}. ` : "Nothing needed saving right now. ",
      r.queued ? (o.picked === "voicemail" ? "If the voicemail transcript has anything useful, it lands in your queue."
        : "When the transcript arrives (1–2 min), the callback is updated to who and when they said, and new contacts, a note and the email draft are saved to Close automatically. The email stays a draft until you send it.") : "",
      failed.length ? el("span", { class: "bad", text: ` Couldn't save: ${failed.map((f) => f.label).join(", ")}.` }) : null,
    ])]));
    if (r.task) page.append(renderReschedule(st, r));
  }
  out.push(page);
  const next = listInfo && listInfo.next;
  out.push(el("footer", { class: "footer" }, [
    next ? el("button", { class: "btn primary block", text: `Next lead: ${next.name}  →`, disabled: o && o.busy, onclick: () => leaveEnded(next) })
      : el("button", { class: "btn primary block", text: "Back to the call card", disabled: o && o.busy, onclick: () => leaveEnded(null) }),
    el("button", { class: "link", text: "See recent calls", onclick: () => { leaveEnded(null); view = "queue"; refreshQueue(); render(); } }),
  ]));
  return out;
}

// Change the one-tap callback's time: quick picks in their hours, or any date.
function renderReschedule(st, r) {
  const o = st.outcome;
  const t = r.task;
  const pick = async (dueAt) => {
    o.moving = true; o.moveError = null; render();
    try {
      const res = await api(`/api/leads/${st.leadId}/tasks/${t.id}/reschedule`, { due_at: dueAt });
      r.saved = r.saved.map((x) => x.replace(t.when, res.when));
      Object.assign(t, res);
      o.picking = false;
    } catch (e) { o.moveError = e.message; }
    o.moving = false; render();
  };
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date(t.due_at);
  const custom = el("input", { type: "datetime-local", value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` });
  const smart = o.built && o.built.smartTask;
  const savedLabels = o.built && (o.built.applied || []).filter((x) => x.ok).map((x) => x.label);
  return el("section", { class: `card${smart && smart.changed ? " smart" : ""}` }, [
    o.watching ? el("p", { class: "loading", style: "margin-bottom:8px;font-size:13px" }, [el("span", { class: "spinner" }), "Reading the call… the callback updates to what they said."]) : null,
    smart && smart.changed ? el("p", { style: "margin-bottom:6px;font-size:13px", class: "ok" }, [el("strong", { text: "Updated from the call: " }), smart.title]) : null,
    smart && smart.why ? el("p", { class: "muted", style: "margin-bottom:8px;font-size:13px", text: `“${smart.why.replace(/^Main Office said:\s*/i, "").replace(/^"|"$/g, "")}”` }) : null,
    o.built && o.built.noTranscript && !(smart && smart.changed) ? el("p", { class: "attach", style: "margin-bottom:8px;font-size:13px", text: "Close didn't make a transcript for this call. Type what they said above (e.g. \"call back in an hour\") and press Enter, or use Change." }) : null,
    el("div", { class: "linkrow", style: "align-items:center" }, [
      el("p", {}, [el("span", { class: "label", text: "Callback  " }), el("strong", { text: t.when }), el("span", { class: "muted", text: " their time" })]),
      o.picking ? null : el("button", { class: "btn small", text: "Change", onclick: () => { o.picking = true; render(); } }),
    ]),
    o.picking ? el("div", { class: "chips-row" }, [
      ...t.options.map((opt) => el("button", { class: `chip${opt.due_at === t.due_at ? " good" : ""}`, text: opt.label, disabled: o.moving, onclick: () => pick(opt.due_at) })),
    ]) : null,
    o.picking ? el("div", { class: "row", style: "margin-top:10px;align-items:center" }, [
      el("label", { class: "grow", style: "font-size:12.5px;color:var(--muted);display:flex;flex-direction:column;gap:3px" }, ["Or pick a time (your time)", custom]),
      el("button", { class: "btn small", style: "align-self:flex-end", text: o.moving ? "Saving…" : "Set", disabled: o.moving, onclick: () => { const x = new Date(custom.value); if (!isNaN(x)) pick(x.toISOString()); } }),
    ]) : null,
    o.moveError ? el("p", { class: "bad", style: "margin-top:8px", text: o.moveError }) : null,
    savedLabels && savedLabels.length ? el("p", { class: "muted", style: "margin-top:10px;font-size:13px" }, [el("strong", { text: "Saved to Close: " }), savedLabels.join(" · ")]) : null,
  ]);
}

// --- queue ---

function alertsBlock(alerts) {
  return el("ul", { class: "alerts" }, alerts.map((a) => el("li", { class: a.level, text: a.text })));
}

function renderQueue() {
  const items = queue.items;
  const readyItems = items.filter((i) => i.state === "ready");
  const total = readyItems.reduce((n, i) => n + (i.count || 0), 0);
  const out = [header({ text: "Recent", cls: "phase" })];
  const page = el("main", { class: "page" }, [
    el("div", { class: "qhead" }, [
      el("h1", { text: "Recent calls" }),
      el("span", { class: "muted", text: [queue.building ? `${queue.building} saving` : null, queue.ready ? `${queue.ready} to check` : null, queue.saved ? `${queue.saved} saved` : null].filter(Boolean).join(" · ") }),
    ]),
    S ? el("button", { class: "link", style: "align-self:flex-start", text: `← Back to ${S.header ? S.header.company : "the lead"}`, onclick: () => { view = "lead"; render(); } }) : null,
  ]);
  if (!items.length) page.append(el("p", { class: "empty", text: "No calls yet today. After a call, tap an outcome; the contacts, note and email draft save to Close on their own and show up here." }));
  for (const it of items) {
    if (it.state === "building") {
      page.append(el("div", { class: "card qitem building" }, [
        el("div", { class: "top" }, [el("span", { class: "co", text: it.company }), el("span", { class: "ago", text: agoText(it.createdAt) })]),
        el("p", { class: "what", text: `${it.outcomeLabel || "Call"}. ${it.saved.length ? `${cap(it.saved.join(" and "))} already saved. ` : ""}Reading the transcript; contacts and the email draft save to Close in a minute or two.` }),
      ]));
    } else if (it.state === "saved") {
      const ok = (it.applied || []).filter((x) => x.ok).map((x) => x.label);
      page.append(el("div", { class: "card qitem saved" }, [
        el("div", { class: "top" }, [el("span", { class: "co", text: it.company }), el("span", { class: "ago", text: agoText(it.createdAt) })]),
        it.smartTask ? el("p", { class: "smart" }, [el("strong", { text: "Callback: " }), `${it.smartTask.title}, ${it.smartTask.when}`]) : null,
        el("p", { class: "what" }, [el("strong", { text: "Saved to Close: " }), ok.join(" · ") || "nothing new"]),
        el("div", { class: "actions" }, [
          el("button", { class: "btn small", text: "Open in Close", onclick: () => openLead(it.leadId) }),
          el("button", { class: "btn small", text: "Details", onclick: () => openItem(it.id) }),
        ]),
        followUpBlock(it.leadId, true),
      ]));
    } else if (it.state === "failed") {
      page.append(el("div", { class: "card qitem failed" }, [
        el("div", { class: "top" }, [el("span", { class: "co", text: it.company }), el("span", { class: "ago", text: agoText(it.createdAt) })]),
        el("p", { class: "what", text: it.error || "Something went wrong." }),
        el("div", { class: "actions" }, [
          el("button", { class: "btn small", text: "Rebuild", onclick: async () => { await api(`/api/queue/${it.id}/rebuild`, {}).catch(() => {}); refreshQueue(); } }),
          el("button", { class: "btn small", text: "Dismiss", onclick: async () => { await api(`/api/queue/${it.id}/discard`, {}).catch(() => {}); refreshQueue(); } }),
        ]),
      ]));
    } else {
      page.append(el("div", { class: "card qitem" }, [
        el("div", { class: "top" }, [el("span", { class: "co", text: it.company }), el("span", { class: "ago", text: agoText(it.createdAt) })]),
        it.smartTask && it.smartTask.changed ? el("p", { class: "smart" }, [el("strong", { text: "Callback set from the call: " }), `${it.smartTask.title}, ${it.smartTask.when}`, it.smartTask.why ? el("span", { class: "muted", text: ` — “${it.smartTask.why}”` }) : null]) : null,
        el("p", { class: "what", text: it.count ? `Couldn't save automatically: ${itemSummary(it)}` : (it.summary || "") }),
        el("div", { class: "actions" }, [
          it.count ? el("button", { class: "btn primary small", text: `Save ${it.count} to Close`, onclick: () => approveItem(it) }) : null,
          el("button", { class: "btn small", text: "Review", onclick: () => openItem(it.id) }),
          it.count ? null : el("button", { class: "btn small", text: "Got it", onclick: async () => { await api(`/api/queue/${it.id}/discard`, {}).catch(() => {}); refreshQueue(); } }),
        ]),
        followUpBlock(it.leadId, true),
      ]));
    }
  }
  // Every card shows what was skipped (amber) or failed in Close (red). Nothing silent (Walt 9/26).
  [...page.querySelectorAll(".qitem")].forEach((card, i) => {
    const it = items[i];
    if (it && it.alerts && it.alerts.length) card.append(alertsBlock(it.alerts));
  });
  out.push(page);
  if (readyItems.length) {
    out.push(el("footer", { class: "footer" }, [
      el("button", {
        class: "btn primary block", text: `Save all ${total} to Close`,
        onclick: async (e) => { e.currentTarget.disabled = true; await api("/api/queue/approve-all", {}).catch((err) => alert(err.message)); refreshQueue(); },
      }),
      el("p", { class: "note", text: "Emails stay as drafts until you send them from Close" }),
    ]));
  }
  return out;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// --- review (one queue item, or a chat-built draft) ---

function reviewList(p, off, open, fromStatus) {
  const rows = [];
  const row = (key, kids, fields) => {
    const isOpen = open.has(key);
    const box = el("input", { type: "checkbox", checked: !off.has(key), onchange: (e) => { if (e.target.checked) off.delete(key); else off.add(key); render(); } });
    const body = el("div", { class: "body" }, [
      ...kids,
      fields && fields.length ? el("div", { class: "links" }, [el("button", { class: "link", text: isOpen ? "Done" : "Edit", onclick: () => { if (isOpen) open.delete(key); else open.add(key); render(); } })]) : null,
      isOpen ? el("div", { class: "edit" }, fields) : null,
    ]);
    rows.push(el("div", { class: `prop${off.has(key) ? " off" : ""}` }, [box, body]));
  };
  const field = (label, obj, prop, opts = {}) => {
    const n = el(opts.multiline ? "textarea" : "input", { value: obj[prop] ?? "", rows: opts.rows });
    n.addEventListener("input", () => { obj[prop] = n.value || (opts.nullable ? null : ""); });
    return el("label", {}, [label, n]);
  };
  p.contacts.forEach((c, i) => row(`contact:${i}`, [
    el("p", { class: "kind", text: "Contact" }),
    el("p", { class: "main", text: [c.name, c.title].filter(Boolean).join(" · ") }),
    c.email || c.phone ? el("p", { class: "sub" }, [
      c.email ? el("span", { class: "mono", text: c.email }) : null, c.email && c.verify_email ? " " : null,
      c.email && c.verify_email ? el("span", { class: "verify", text: "Verify spelling" }) : null,
      c.phone ? ` ${c.email ? "· " : ""}${prettyPhone(c.phone)}` : null,
    ]) : null,
  ], [field("Name", c, "name"), field("Title", c, "title", { nullable: true }), field("Email", c, "email", { nullable: true }), field("Phone / ext", c, "phone", { nullable: true })]));
  (p.contact_updates || []).forEach((u, i) => row(`update:${i}`, [
    el("p", { class: "kind", text: "Update contact" }),
    el("p", { class: "main", text: u.name ? `${u.contact} → ${u.name}` : u.contact }),
    u.title || u.email || u.phone ? el("p", { class: "sub" }, [
      [u.title, u.phone ? prettyPhone(u.phone) : null].filter(Boolean).join(" · "),
      u.email ? el("span", { class: "mono", text: ` ${u.email}` }) : null,
      u.email && u.verify_email ? el("span", { class: "verify", style: "margin-left:6px", text: "Verify spelling" }) : null,
    ]) : null,
  ], [field("New name", u, "name", { nullable: true }), field("Title", u, "title", { nullable: true }), field("Add email", u, "email", { nullable: true }), field("Add phone / ext", u, "phone", { nullable: true })]));
  p.tasks.forEach((t, i) => row(`task:${i}`, [
    el("p", { class: "kind", text: `Task · ${taskWhen(t.due_at)}` }),
    el("p", { class: "main", text: t.title || `Call ${t.ask_for}` }),
    el("p", { class: "sub", text: [t.ask_for, t.phone ? prettyPhone(t.phone) || t.phone : null].filter(Boolean).join(" · ") + (t.pitch ? ` — ${t.pitch}` : "") }),
    t.why ? el("p", { class: "sub", text: `Why this date: “${t.why}”` }) : null,
  ], [field("Title", t, "title"), field("Ask for", t, "ask_for"), field("Direct line / ext", t, "phone", { nullable: true }), field("What to ask", t, "pitch"), dueField(t)]));
  if (p.email) {
    const e = p.email;
    row("email", [
      el("p", { class: "kind", text: `Email draft · to ${e.to.map((r) => r.email).join(", ")}` }),
      el("p", { class: "main", text: e.subject }),
      el("p", { class: "preview", text: e.body }),
      el("p", { class: "links" }, [
        e.attach_line_card ? el("span", { class: "ok", text: "📎 Line card PDF will be attached" }) : el("span", { class: "muted", text: "No attachment" }),
        e.address_as_heard ? el("span", { class: "verify", text: `Verify address: ${e.address_as_heard}` }) : null,
      ]),
    ], [
      field("Subject", e, "subject"), field("Body", e, "body", { multiline: true, rows: 12 }),
      el("label", { class: "check", style: "flex-direction:row;align-items:center;gap:8px" }, [
        el("input", { type: "checkbox", checked: !!e.attach_line_card, onchange: (ev) => { e.attach_line_card = ev.target.checked; } }),
        "Attach the line card PDF",
      ]),
    ]);
  }
  if (p.note) row("note", [el("p", { class: "kind", text: p.note.pinned ? "Note · pinned" : "Note" }), el("p", { class: "preview", text: p.note.text })], [field("Note", p.note, "text", { multiline: true, rows: 5 })]);
  if (p.status) row("status", [el("p", { class: "kind", text: "Status" }), el("p", { class: "main", text: `${fromStatus ? `${fromStatus} → ` : "→ "}${p.status.label}` })]);
  return el("div", { class: "proposals" }, rows);
}

function dueField(t) {
  const d = new Date(t.due_at);
  const pad = (n) => String(n).padStart(2, "0");
  const n = el("input", { type: "datetime-local", value: isNaN(d) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` });
  n.addEventListener("input", () => { const x = new Date(n.value); if (!isNaN(x)) t.due_at = x.toISOString(); });
  return el("label", {}, ["Due (your time)", n]);
}

function renderItem() {
  const it = queue.items.find((x) => x.id === itemView.id);
  if (!it) { view = "queue"; return renderQueue(); }
  const iv = itemView;
  const p = it.proposals || EMPTY();
  const n = countProps(approved(p, iv.off));
  const out = [header({ text: it.state === "saved" ? "Saved" : "Post-call" })];
  const sub = [it.callWith ? `Call with ${it.callWith}` : "Call", it.duration ? mmss(it.duration) : null, it.outcomeLabel].filter(Boolean).join(" · ");
  const fromStatus = S && S.leadId === it.leadId && S.header ? S.header.status : null;
  const page = el("main", { class: "page" }, [
    el("button", { class: "link", style: "align-self:flex-start", text: "← Recent calls", onclick: () => { view = "queue"; render(); } }),
    el("div", { class: "title" }, [el("h1", { text: it.company }), el("p", { class: "sub", text: sub })]),
    it.summary ? el("section", { class: "card" }, [
      el("p", { class: "label", text: "What happened" }),
      el("p", { style: "margin-top:6px", text: it.summary }),
      el("p", { class: "muted", style: "margin-top:8px;font-size:12.5px" }, [
        !it.noTranscript ? "From Close's call transcript. " : "No transcript from Close, built from your notes. ",
        !it.noTranscript ? el("button", { class: "link", text: iv.showTranscript ? "Hide transcript" : "Show transcript", onclick: () => toggleTranscript(it, iv) }) : null,
      ]),
      !it.noTranscript && iv.showTranscript ? el("pre", { class: "transcript", text: iv.transcript || "Loading the transcript from Close…" }) : null,
    ]) : null,
    it.smartTask ? el("section", { class: "card smart" }, [
      el("p", { class: "label", text: "Callback saved in Close" }),
      el("p", { style: "margin-top:6px" }, [el("strong", { text: it.smartTask.title }), ` · ${it.smartTask.when}`]),
      it.smartTask.why ? el("p", { class: "muted", style: "margin-top:2px", text: `From the call: “${it.smartTask.why}”` }) : null,
    ]) : null,
    it.warnings && it.warnings.length ? el("ul", { class: "warnings" }, it.warnings.map((w) => el("li", { text: w }))) : null,
    it.state === "saved" ? el("section", { class: "card" }, [
      el("p", { class: "label", text: "Saved to Close" }),
      el("ul", { class: "results", style: "margin-top:6px" }, (it.applied || []).map((r) => el("li", { class: r.ok ? "ok" : "bad", text: `${r.ok ? "✓" : "✗"} ${r.label}${r.ok ? "" : `: ${r.error}`}` }))),
      el("button", { class: "btn small", style: "margin-top:10px", text: "Open in Close", onclick: () => openLead(it.leadId) }),
    ]) : null,
    it.state === "saved" ? null : el("div", { class: "qhead" }, [el("p", { class: "label", text: "Proposed for Close" }), el("span", { class: "muted", text: `${countProps(p)} items` })]),
    it.state === "saved" ? null : reviewList(p, iv.off, iv.open, fromStatus),
    it.coaching && (it.coaching.nice || it.coaching.next) ? el("section", { class: "coach" }, [
      el("p", { class: "label", text: "Coaching" }),
      el("p", {}, [it.coaching.nice ? el("strong", { text: "Nice: " }) : null, it.coaching.nice || "", it.coaching.next ? el("strong", { text: " Next time: " }) : null, it.coaching.next || ""]),
    ]) : null,
    iv.error ? el("div", { class: "flag", text: iv.error }) : null,
    iv.results ? el("ul", { class: "results" }, iv.results.map((r) => el("li", { class: r.ok ? "ok" : "bad", text: `${r.ok ? "✓" : "✗"} ${r.label}${r.ok ? "" : `: ${r.error}`}` }))) : null,
    it.state === "saved" ? null : el("div", { class: "row" }, [
      el("button", { class: "btn primary grow", text: iv.busy ? "Saving…" : `Save ${n} to Close`, disabled: iv.busy || n === 0, onclick: () => approveItem(it, approved(p, iv.off)) }),
      el("button", { class: "btn", text: "Discard", onclick: async () => { await api(`/api/queue/${it.id}/discard`, {}).catch(() => {}); view = "queue"; refreshQueue(); } }),
    ]),
  ]);
  out.push(page);
  if (it.state !== "saved") out.push(chatBar(iv.chat, iv.chatBusy, 'Change anything: "make the follow-up Thursday at 9"'));
  return out;
}

function renderDraft() {
  const st = S;
  const d = st.draft;
  const n = countProps(approved(d.proposals, d.off));
  const out = [header({ text: "Pre-call" })];
  const page = el("main", { class: "page" }, [
    el("button", { class: "link", style: "align-self:flex-start", text: "← Call card", onclick: () => { view = "lead"; render(); } }),
    el("div", { class: "title" }, [el("h1", { text: st.header ? st.header.company : "" }), el("p", { class: "sub", text: "From your chat. Nothing is saved until you approve." })]),
    d.warnings.length ? el("ul", { class: "warnings" }, d.warnings.map((w) => el("li", { text: w }))) : null,
    reviewList(d.proposals, d.off, d.open, st.header && st.header.status),
    d.results ? el("ul", { class: "results" }, d.results.map((r) => el("li", { class: r.ok ? "ok" : "bad", text: `${r.ok ? "✓" : "✗"} ${r.label}${r.ok ? "" : `: ${r.error}`}` }))) : null,
    el("div", { class: "row" }, [
      el("button", {
        class: "btn primary grow", text: d.busy ? "Saving…" : `Approve ${n} change${n === 1 ? "" : "s"}`, disabled: d.busy || n === 0,
        onclick: async () => {
          d.busy = true; render();
          try {
            const r = await api(`/api/leads/${st.leadId}/apply`, { proposals: approved(d.proposals, d.off), rating: st.brief ? st.brief.rating : null });
            d.results = r.results;
            if (r.results.every((x) => x.ok)) setTimeout(() => { st.draft = null; if (view === "draft") { view = "lead"; render(); } }, 1200);
          } catch (e) { d.results = [{ ok: false, label: "Save", error: e.message }]; }
          d.busy = false; render();
        },
      }),
      el("button", { class: "btn", text: "Discard", onclick: () => { st.draft = null; view = "lead"; render(); } }),
    ]),
  ]);
  out.push(page, chatBar(st.chat, st.chatBusy, "Change anything…"));
  return out;
}

// --- website ---

let siteSrc = null;
let siteLoaded = false;
let siteTimer = null;

function renderSite() {
  const h = S.header || {};
  let url = null;
  try { url = h.website ? new URL(/^https?:\/\//i.test(h.website) ? h.website : `https://${h.website}`).href : null; } catch {}
  const onCall = S.phase === "on";
  const elapsed = S.callStartedAt ? (Date.now() - new Date(S.callStartedAt).getTime()) / 1000 : 0;
  const out = [onCall
    ? el("div", { class: "oncall-strip" }, [
      el("span", { class: "live" }), el("strong", { text: "On call" }),
      el("span", { id: "call-timer", class: "timer mono", text: mmss(Math.max(0, elapsed)) }),
      el("span", { class: "co", text: h.company || "" }),
      myLine ? el("div", { class: "linerow" }, [myLineButton("callbar")]) : null,
    ])
    : header({ text: "Website" })];
  const bar = el("div", { class: "sitebar" }, [
    el("button", { class: "link", text: onCall ? "← Back to call" : "← Call card", onclick: () => { view = "lead"; render(); } }),
    el("span", { class: "host", text: url ? new URL(url).host.replace(/^www\./, "") : "" }),
    url ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: "Open in new tab ↗" }) : null,
  ]);
  const wrap = el("div", { class: "site" }, [bar]);
  out.push(wrap);
  if (!url) { wrap.append(el("p", { class: "sitemsg", text: "No website on this lead in Close." })); return out; }
  if (!siteAccess) {
    wrap.append(el("div", { class: "page" }, [
      el("p", { text: "Show company websites right here in the panel? Chrome will ask once." }),
      el("button", { class: "btn primary", text: "Enable website view", onclick: async () => { siteAccess = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] }); render(); } }),
    ]));
    return out;
  }
  const frame = el("iframe", { title: "Company website", referrerpolicy: "no-referrer", sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" });
  const msg = el("p", { class: "sitemsg", text: `Loading ${new URL(url).host}…`, hidden: siteLoaded && siteSrc === url });
  frame.addEventListener("load", () => { if (frame.src === url) { siteLoaded = true; msg.hidden = true; } });
  if (siteSrc !== url) { siteSrc = url; siteLoaded = false; clearTimeout(siteTimer); siteTimer = setTimeout(() => { if (!siteLoaded) msg.textContent = "This website isn't responding. Try “Open in new tab.”"; }, 10_000); }
  frame.src = url;
  wrap.append(msg, frame);
  return out;
}

// ---------- ticking clocks without full re-renders ----------

setInterval(() => {
  const step = document.getElementById("leadload-step");
  if (!step) return;
  loadStep += 1;
  step.textContent = LOAD_STEPS[loadStep % LOAD_STEPS.length];
}, 1400);
setInterval(() => {
  if (!S) return;
  const t = document.getElementById("call-timer");
  if (t && S.callStartedAt) t.textContent = mmss(Math.max(0, (Date.now() - new Date(S.callStartedAt).getTime()) / 1000));
}, 1000);
setInterval(() => {
  const c = document.getElementById("their-time");
  const clock = S && theirClock(S.header);
  if (c && clock) { c.textContent = `${clock.time} there`; c.className = `chip ${clock.open ? "good" : "bad"}`; }
}, 30_000);

// ---------- start ----------

function applyTheme() {
  document.documentElement.dataset.theme = ["light", "dark", "system"].includes(settings.theme) ? settings.theme : "light";
}

async function init() {
  if (PREVIEW) {
    const q = new URLSearchParams(location.search);
    settings = { server: location.origin, token: q.get("token") || "", theme: q.get("theme") || "light" };
  } else {
    settings = { theme: "light", ...(await chrome.storage.local.get(["server", "token", "theme"])) };
    // The local server moved from 8787 to 3001 (Walt 9/26).
    if (/^http:\/\/localhost:8787\/?$/.test(settings.server || "")) { settings.server = "http://localhost:3001"; chrome.storage.local.set({ server: settings.server }); }
    listView = (await chrome.storage.local.get("listView")).listView || null;
    myLine = (await chrome.storage.local.get("myLine")).myLine || null; // shown at once; /api/me refreshes it
    siteAccess = await chrome.permissions.contains({ origins: ["https://*/*", "http://*/*"] });
    chrome.permissions.onAdded.addListener(async () => { siteAccess = await chrome.permissions.contains({ origins: ["https://*/*", "http://*/*"] }); render(); });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.theme) { settings.theme = changes.theme.newValue; applyTheme(); }
      if (!changes.server && !changes.token) return;
      if (changes.server) settings.server = changes.server.newValue;
      if (changes.token) settings.token = changes.token.newValue;
      leads.clear(); S = null; stats = null; chrome.storage.local.remove("stats"); syncLead(); refreshQueue(); syncStats(true); loadMe();
    });
    chrome.tabs.onActivated.addListener(syncLead);
    chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (info.url && tab.active) syncLead(); });
    chrome.windows.onFocusChanged.addListener(syncLead);
  }
  applyTheme();
  await loadStats();
  await syncLead();
  render();
  refreshQueue();
  syncStats(true);
  loadMe();
  setInterval(poll, POLL_MS);
  setInterval(refreshQueue, 15_000);
}

init();
