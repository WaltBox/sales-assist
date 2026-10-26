// West Game (Walt 10/25): the team's calling competition, on the side panel and on a guest's page. Every rep, and every
// guest whose link is on, gets a lane; the dot moves with each call, points decide who's winning (call 1, conversation
// 5, line card 10, RFQ 50, first RFQ from an account +25). It sits on the bottom of the screen: drag it up (or tap)
// for the lanes. When anyone lands an RFQ, a bowling ball rolls across every screen.
//
// One copy for both places: this file lives in extension/, and `npm run pack-extension` copies it to server/web/ for
// the guest page. Edit it here.
(function () {
  const h = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k === "checked") n.checked = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(kids)) if (c != null && c !== false) n.append(c);
    return n;
  };
  const GOAL = 100; // the finish line, until someone passes it
  const MIN = 62; // the closed bar's height
  const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
  const firstName = (l) => l.first || (l.name || l.email).split(/[\s@]/)[0];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

  const STRIKE_LINES = [
    (n, co) => `${n} just bowled a strike at ${co}. The rest of you are in the gutter.`,
    (n, co) => `STRIKE. ${n} got an RFQ out of ${co}. Somebody get this person a shoe rental.`,
    (n, co) => `${co} just went down like ten pins. ${n} with the RFQ.`,
    (n, co) => `${n} rolled one straight down the middle. ${co} sent an RFQ.`,
    (n, co) => `Pins everywhere. ${n} just pulled an RFQ from ${co}.`,
    (n, co) => `${n} landed an RFQ from ${co}. Bumpers are off, people.`,
    (n, co) => `${n} picked up the spare nobody wanted: an RFQ from ${co}.`,
    (n, co) => `${co} RFQ for ${n}. Everybody else, back to your lanes.`,
  ];
  const MY_STRIKE_LINES = [
    (co) => `Strike. ${co} sent the RFQ. Everyone else just watched you bowl.`,
    (co) => `You knocked ${co} flat. RFQ in the bag.`,
    (co) => `That's a strike from ${co}. Go ahead, do the little dance.`,
    (co) => `RFQ from ${co}. The whole alley heard that one.`,
  ];
  const PIN = '<svg viewBox="0 0 12 30" aria-hidden="true"><path d="M6 1c2 0 3 2 3 4.5S7.6 9 7.6 11s3.4 4.5 3.4 9.5S9 29 6 29s-5-3.5-5-8.5S4.4 13 4.4 11 3 8 3 5.5 4 1 6 1z" fill="#fff" stroke="#111114" stroke-width="1.2"/><path d="M3.6 8.4h4.8M3.9 10h4.2" stroke="#dc0025" stroke-width="1.3"/></svg>';

  /**
   * opts: load() → the race; liveDials() → your calls today as this screen counts them (it knows before Close does);
   * store { get(key), set(key, value) }; pollMs; webApp (a link for the owner to pick who plays); onChange().
   */
  function create(opts) {
    const g = { race: null, seen: null, open: false, week: false, lane: null, drag: null };

    async function load(fresh) {
      let r;
      try { r = await opts.load(fresh); } catch { return; }
      g.race = r;
      if (!g.seen) {
        const saved = await opts.store.get("westGameSeen");
        // First look today: what already happened isn't news.
        g.seen = saved && saved.day === r.day ? saved : { day: r.day, ids: r.events.map((e) => e.id) };
        opts.store.set("westGameSeen", g.seen);
      }
      if (g.seen.day !== r.day) g.seen = { day: r.day, ids: [] };
      const fresh2 = r.events.filter((e) => !g.seen.ids.includes(e.id));
      if (fresh2.length) {
        g.seen.ids.push(...fresh2.map((e) => e.id));
        opts.store.set("westGameSeen", g.seen);
        celebrate(fresh2[fresh2.length - 1], fresh2.length);
      }
      render();
      if (opts.onChange) opts.onChange();
    }

    /** The lanes, with your own calls counted live. */
    function lanes() {
      const r = g.race;
      if (!r) return [];
      const live = opts.liveDials ? opts.liveDials() : null;
      let out = r.lanes.map((l) => {
        if (l.email !== r.you || live == null || live <= l.dials) return l;
        return { ...l, dials: live, points: l.points + (live - l.dials) * r.points.dial };
      });
      if (g.week) out = out.filter((l) => l.week).map((l) => ({ ...l, ...l.week, firstRfqs: 0 }));
      return out.sort((a, b) => b.points - a.points || b.dials - a.dials);
    }

    function summary(ls) {
      const r = g.race;
      const at = ls.findIndex((l) => l.email === r.you);
      if (at < 0) return [`${firstName(ls[0])} leads with `, h("b", { text: String(ls[0].points) })];
      return [h("b", { text: ordinal(at + 1) }), ` of ${ls.length}`,
        at > 0 ? ` · ${plural(ls[at - 1].points - ls[at].points + 1, "pt", "pts")} to pass ${firstName(ls[at - 1])}` : ls.length > 1 ? ` · up ${ls[0].points - ls[1].points}` : ""];
    }

    const pctOf = (l, max) => (l.error ? 0 : Math.min(1, l.dials / max) * 100);
    const dot = (l, i, max, big) => h("span", {
      class: `wg-dot${l.email === g.race.you ? " me" : ""}${i === 0 && l.points > 0 ? " lead" : ""}${l.error ? " broken" : ""}${l.guest ? " guest" : ""}`,
      style: `left: calc(${pctOf(l, max)}% - ${pctOf(l, max) / 100} * var(--wg-dot))`,
      title: `${l.name}: ${plural(l.dials, "call", "calls")}, ${l.points} points`,
      text: big ? firstName(l).slice(0, 1).toUpperCase() : null,
    });

    // One lane: place, name and points on top; the track with a trail behind the dot; what they did underneath.
    function lane(l, i, max) {
      const me = l.email === g.race.you;
      const pct = pctOf(l, max);
      const bits = l.error ? [l.error] : [plural(l.dials, "call", "calls"), plural(l.reached, "talk", "talks"), plural(l.lineCards, "line card", "line cards"), plural(l.rfqs, "RFQ", "RFQs")];
      const row = h("button", { class: `wg-lane${me ? " me" : ""}${g.lane === l.email ? " on" : ""}${l.error ? " broken" : ""}`, onclick: () => { g.lane = g.lane === l.email ? null : l.email; render(); } }, [
        h("span", { class: "wg-ltop" }, [
          h("span", { class: "wg-place", text: String(i + 1) }),
          h("span", { class: "wg-name", text: me ? `${firstName(l)} (you)` : l.name }),
          l.guest ? h("span", { class: "wg-tag", text: "Guest" }) : null,
          i === 0 && l.points > 0 ? h("span", { class: "wg-tag gold", text: "Lead" }) : null,
          h("span", { class: "wg-pts" }, [l.error ? "–" : String(l.points), h("small", { text: "pts" })]),
        ]),
        h("span", { class: "wg-track" }, [
          h("i", { class: "wg-trail", style: `width: calc(${pct}% - ${pct / 100} * var(--wg-dot) + var(--wg-dot) / 2)` }),
          h("span", { class: "wg-tick", style: "left:25%" }), h("span", { class: "wg-tick", style: "left:50%" }), h("span", { class: "wg-tick", style: "left:75%" }),
          h("span", { class: "wg-flag", "aria-hidden": "true" }),
          dot(l, i, max, true),
        ]),
        h("span", { class: "wg-sub", text: bits.join(" · ") }),
      ]);
      return g.lane === l.email && !l.error ? [row, stats(l, i)] : [row];
    }

    function stats(l, i) {
      const r = g.race;
      const full = r.lanes.find((x) => x.email === l.email) || l;
      const w = full.week;
      const tr = (label, today, week, each) => h("tr", {}, [h("td", { text: label }), h("td", { text: String(today) }), h("td", { text: week == null ? "–" : String(week) }), h("td", { class: "wg-each", text: each })]);
      return h("div", { class: "wg-stats" }, [
        h("table", {}, [
          h("tr", {}, [h("th", {}), h("th", { text: "Today" }), h("th", { text: "Week" }), h("th", { text: "Pts" })]),
          tr("Calls", full.dials, w && w.dials, `×${r.points.dial}`),
          tr("Conversations", full.reached, w && w.reached, `×${r.points.reached}`),
          tr("Line cards", full.lineCards, w && w.lineCards, `×${r.points.lineCard}`),
          tr("RFQs", full.rfqs, w && w.rfqs, `×${r.points.rfq}`),
          full.firstRfqs ? tr("First RFQs", full.firstRfqs, null, `+${r.points.firstRfq}`) : null,
          h("tr", { class: "wg-total" }, [h("td", { text: "Points" }), h("td", { text: String(full.points) }), h("td", { text: w ? String(w.points) : "–" }), h("td")]),
        ]),
      ]);
    }

    function content() {
      const r = g.race;
      const ls = lanes();
      const max = Math.max(g.week ? GOAL * 5 : GOAL, ...ls.map((l) => l.dials));
      const tab = (on, text, week) => h("button", { class: `wg-tab${on ? " on" : ""}`, text, onclick: () => { g.week = week; render(); } });
      const today = r.events.filter((e) => e.day === r.day);
      return [
        h("div", { class: "wg-head" }, [
          h("h2", { class: "wg-title", text: g.week ? "This week's competition" : "Today's competition" }),
          h("div", { class: "wg-tabs" }, [tab(!g.week, "Today", false), tab(g.week, "Week", true)]),
        ]),
        h("div", { class: "wg-field" }, ls.flatMap((l, i) => lane(l, i, max))),
        h("section", { class: "wg-feed" }, [
          h("p", { class: "wg-label", text: today.length ? `RFQs today · ${today.length}` : "RFQs today" }),
          today.length ? h("ul", {}, today.slice().reverse().map((e) => h("li", {}, [h("b", { text: (e.name || "").split(/\s+/)[0] }), ` · ${e.company || "an account"}`, e.first ? h("span", { class: "wg-tag good", text: "First RFQ" }) : null])))
            : h("p", { class: "wg-muted", text: "None yet. The first one rolls a bowling ball across every screen." }),
        ]),
        h("p", { class: "wg-muted", text: `Points: call ${r.points.dial} · conversation ${r.points.reached} · line card ${r.points.lineCard} · RFQ ${r.points.rfq} · first RFQ from an account +${r.points.firstRfq}. Starts over every morning.` }),
        r.owner ? h("div", { class: "wg-links" }, [
          opts.webApp ? h("a", { href: opts.webApp, target: "_blank", rel: "noopener", text: "Pick who plays (web app)" }) : null,
          // See what an RFQ looks like without waiting for one. Only on this screen, nothing is saved.
          h("button", { text: "Test the strike", onclick: () => {
            const other = r.lanes.find((l) => l.email !== r.you) || r.lanes[0];
            celebrate({ id: "test", email: other.email, name: other.name, company: "Test Lead Fabrication", first: Math.random() < 0.5, day: r.day }, 1);
          } }),
        ]) : null,
      ];
    }

    const maxH = () => Math.round(window.innerHeight * 0.82);
    function render() {
      let sheet = document.getElementById("westgame");
      const ls = lanes();
      if (!ls.length) { if (sheet) sheet.remove(); document.body.classList.remove("has-race"); return; }
      document.body.classList.add("has-race");
      if (!sheet) { sheet = h("section", { id: "westgame", class: "wg-sheet", "aria-label": "West Game" }); document.body.append(sheet); }
      if (g.drag) return;
      sheet.classList.toggle("open", g.open);
      sheet.style.height = g.open ? `${maxH()}px` : `${MIN}px`;
      const max = Math.max(GOAL, ...ls.map((l) => l.dials));
      const grab = h("div", { class: "wg-grab", title: g.open ? "Drag down to close" : "Drag up for West Game" }, [
        h("span", { class: "wg-handle", "aria-hidden": "true" }),
        h("span", { class: "wg-bar" }, [
          h("span", { class: "wg-brand", text: "West Game" }),
          h("span", { class: "wg-sum" }, summary(ls)),
          h("span", { class: "wg-chev", text: g.open ? "▾" : "▴" }),
        ]),
        h("span", { class: "wg-mini" }, [h("span", { class: "wg-flag", "aria-hidden": "true" }), ...ls.map((l, i) => dot(l, i, max, false))]),
      ]);
      grab.addEventListener("pointerdown", down);
      const old = sheet.querySelector(".wg-body");
      const scroll = old ? old.scrollTop : 0;
      const body = h("div", { class: "wg-body" }, g.open || sheet.classList.contains("peek") ? content() : []);
      sheet.replaceChildren(grab, body);
      body.scrollTop = scroll;
    }

    function down(e) {
      const sheet = document.getElementById("westgame");
      g.drag = { y: e.clientY, h: sheet.getBoundingClientRect().height, moved: 0, lastY: e.clientY, lastT: performance.now(), v: 0 };
      sheet.classList.add("dragging");
      // Show what's inside as soon as it starts coming up.
      if (!g.open && !sheet.classList.contains("peek")) { sheet.classList.add("peek"); sheet.querySelector(".wg-body").replaceChildren(...content()); }
      const t = e.currentTarget;
      t.setPointerCapture(e.pointerId);
      t.addEventListener("pointermove", move);
      t.addEventListener("pointerup", up, { once: true });
      t.addEventListener("pointercancel", up, { once: true });
    }
    function move(e) {
      if (!g.drag) return;
      const sheet = document.getElementById("westgame");
      const now = performance.now();
      g.drag.v = (g.drag.lastY - e.clientY) / Math.max(1, now - g.drag.lastT); // px/ms, up is positive
      g.drag.lastY = e.clientY; g.drag.lastT = now;
      g.drag.moved = Math.max(g.drag.moved, Math.abs(e.clientY - g.drag.y));
      sheet.style.height = `${Math.min(maxH(), Math.max(MIN, g.drag.h + (g.drag.y - e.clientY)))}px`;
    }
    function up(e) {
      const sheet = document.getElementById("westgame");
      e.currentTarget.removeEventListener("pointermove", move);
      const d = g.drag;
      g.drag = null;
      sheet.classList.remove("dragging", "peek");
      if (!d) return;
      const ht = sheet.getBoundingClientRect().height;
      if (d.moved < 6) g.open = !g.open; // a tap
      else if (Math.abs(d.v) > 0.5) g.open = d.v > 0; // a flick
      else g.open = ht > (MIN + maxH()) / 2;
      if (g.open && !g.lane) g.lane = g.race.you;
      render();
      if (g.open) load(true);
    }

    // An RFQ anywhere on the team: a ball rolls down a lane above the bar and takes out the pins.
    function celebrate(e, n) {
      const r = g.race;
      document.getElementById("wg-bowl")?.remove();
      const you = e.email === r.you;
      const name = (e.name || "").split(/\s+/)[0] || "Someone";
      const co = e.company || "a new account";
      const pts = r.points.rfq + (e.first ? r.points.firstRfq : 0);
      let line = n > 1 ? `${n} RFQs just landed. That's a lot of pins on the floor.` : you ? pick(MY_STRIKE_LINES)(co) : pick(STRIKE_LINES)(name, co);
      if (e.first && n === 1) line += " First one ever from them.";
      const pins = h("span", { class: "wg-pins" });
      for (let i = 0; i < 6; i++) {
        const p = h("span", { class: "wg-pin", style: `--i:${i}; --t:${(i % 2) * 4}px; --dx:${(Math.random() * 90 - 20).toFixed(0)}px; --dy:${(-30 - Math.random() * 50).toFixed(0)}px; --r:${(Math.random() * 540 - 270).toFixed(0)}deg` });
        p.innerHTML = PIN;
        pins.append(p);
      }
      const banner = h("div", { id: "wg-bowl", class: "wg-bowl", role: "status", onclick: () => banner.remove() }, [
        h("div", { class: "wg-alley" }, [h("span", { class: "wg-ball", "aria-hidden": "true" }), pins]),
        h("div", { class: "wg-btext" }, [
          h("p", { class: "wg-strike" }, [h("b", { text: "STRIKE!" }), h("span", { text: ` +${pts}` })]),
          h("p", { class: "wg-bline", text: line }),
        ]),
      ]);
      document.body.append(banner);
      setTimeout(() => banner.remove(), 9000);
    }

    load(false);
    setInterval(() => load(false), opts.pollMs || 45_000);
    return { render, load, celebrate, get race() { return g.race; } };
  }

  window.WestGame = { create };
})();
