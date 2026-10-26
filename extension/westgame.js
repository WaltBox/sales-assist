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
  const MIN = 78; // the closed bar's height
  const PARTY = 150; // the bar while an RFQ is being celebrated
  const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
  const firstName = (l) => l.first || (l.name || l.email).split(/[\s@]/)[0];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

  // What plays when someone lands an RFQ (Walt 10/25: "fun and funny... creative, witty"). One of these at random, like
  // the screen at an alley going nuts on a strike. Each has a little scene and its own lines.
  const SCENES = [
    { key: "news", title: "BREAKING NEWS",
      them: [(n, co) => `${n} just pulled an RFQ out of ${co}. The rest of the team could not be reached for comment.`,
        (n, co) => `${co} sends RFQ to ${n}. Experts are calling it "kind of a big deal."`,
        (n, co) => `Reports confirm ${n} got an RFQ from ${co}. Everyone else is "still dialing."`],
      you: [(co) => `Local legend lands RFQ from ${co}. More at 11.`, (co) => `${co} just sent you an RFQ. Your mom has been notified.`] },
    { key: "jackpot", title: "JACKPOT",
      them: [(n, co) => `${n} pulled the lever on ${co} and it paid out.`, (n, co) => `Three in a row. ${n} hit the RFQ machine at ${co}.`],
      you: [(co) => `${co} paid out. Don't spend it all in one place.`, (co) => `Ding ding ding. ${co} wants a quote.`] },
    { key: "fire", title: "ON FIRE",
      them: [(n, co) => `${n} is on fire. ${co} just sent an RFQ. Somebody get a bucket.`, (n, co) => `${n} is heating up. RFQ from ${co}, and the phone's still warm.`],
      you: [(co) => `You're on fire. ${co} sent the RFQ. Stop, drop and keep dialing.`, (co) => `${co} RFQ. Careful, the headset's melting.`] },
    { key: "rocket", title: "LIFTOFF",
      them: [(n, co) => `Houston, we have an RFQ. ${n} just launched ${co}.`, (n, co) => `${n} sent ${co} straight into orbit. RFQ incoming.`],
      you: [(co) => `${co} RFQ. Next stop, the moon.`, (co) => `3, 2, 1... ${co} sent the RFQ.`] },
    { key: "money", title: "CHA-CHING",
      them: [(n, co) => `RFQ from ${co} for ${n}. You can hear the cash register from here.`, (n, co) => `${n} just made it rain. ${co} wants a quote.`],
      you: [(co) => `Cha-ching. ${co} wants a quote.`, (co) => `${co} RFQ. Go ahead, act like you've been here before.`] },
    { key: "mic", title: "MIC DROP",
      them: [(n, co) => `${n} got the RFQ from ${co} and walked off the stage.`, (n, co) => `${co} RFQ. ${n} would like to thank the Academy.`],
      you: [(co) => `${co} RFQ. Mic drop. (Pick it back up, there are more calls.)`, (co) => `You got ${co}. Take a bow. A short one.`] },
  ];
  const BURST = { money: ["💸", "💵", "💰", "💵", "💸", "🤑"], fire: ["🔥", "🔥", "🔥", "🔥", "🔥", "🔥"] };

  /**
   * opts: load() → the race; liveDials() → your calls today as this screen counts them (it knows before Close does);
   * store { get(key), set(key, value) }; pollMs; webApp (a link for the owner to pick who plays); onChange().
   */
  function create(opts) {
    const g = { race: null, seen: null, open: false, week: false, lane: null, drag: null, party: null, back: false };

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

    /** Where you stand, in a few words: "12 pts to pass Chase", "Up 8 on Berni", "Tied with Chase". */
    function blurb(ls) {
      const r = g.race;
      const at = ls.findIndex((l) => l.email === r.you);
      if (ls.every((l) => l.points === 0)) return "Nobody's on the board yet. First call takes the lead.";
      if (at < 0) return `${firstName(ls[0])} leads with ${ls[0].points}`;
      if (at > 0) {
        const gap = ls[at - 1].points - ls[at].points;
        return gap === 0 ? `Tied with ${firstName(ls[at - 1])}` : `${plural(gap + 1, "pt", "pts")} to pass ${firstName(ls[at - 1])}`;
      }
      if (ls.length < 2) return "You're the only one playing";
      const lead = ls[0].points - ls[1].points;
      return lead === 0 ? `Tied with ${firstName(ls[1])}` : `Up ${lead} on ${firstName(ls[1])}`;
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
            : h("p", { class: "wg-muted", text: "None yet. The first one sets off something stupid on every screen." }),
        ]),
        h("p", { class: "wg-muted", text: `Points: call ${r.points.dial} · conversation ${r.points.reached} · line card ${r.points.lineCard} · RFQ ${r.points.rfq} · first RFQ from an account +${r.points.firstRfq}. Starts over every morning.` }),
        r.owner && opts.webApp ? h("div", { class: "wg-links" }, [h("a", { href: opts.webApp, target: "_blank", rel: "noopener", text: "Pick who plays (web app)" })]) : null,
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
      sheet.classList.toggle("partying", !!g.party);
      const closed = g.party ? PARTY : MIN;
      sheet.style.height = g.open ? `${maxH()}px` : `${closed}px`;
      document.body.style.setProperty("--rb", `${closed}px`);
      const max = Math.max(GOAL, ...ls.map((l) => l.dials));
      // The closed bar is a little scoreboard: your place, the whole team on one track, your points.
      const at = ls.findIndex((l) => l.email === g.race.you);
      const mine = at >= 0 ? ls[at] : ls[0];
      const grab = h("div", { class: `wg-grab${g.back ? " back" : ""}`, "aria-label": g.open ? "Drag down to close West Game" : "Drag up for West Game" }, [
        h("span", { class: "wg-handle", "aria-hidden": "true" }),
        h("span", { class: "wg-board" }, [
          h("span", { class: `wg-placebox${at === 0 && mine.points > 0 ? " first" : ""}` }, [
            h("b", { text: at >= 0 ? ordinal(at + 1) : "–" }),
            h("small", { text: `of ${ls.length}` }),
          ]),
          h("span", { class: "wg-mid" }, [
            h("span", { class: "wg-bar" }, [
              h("span", { class: "wg-brand", text: "West Game" }),
              h("span", { class: "wg-sum", text: blurb(ls) }),
            ]),
            h("span", { class: "wg-mini" }, [
              h("i", { class: "wg-trail", style: `width: calc(${pctOf(mine, max)}% - ${pctOf(mine, max) / 100} * var(--wg-dot) + var(--wg-dot) / 2)` }),
              h("span", { class: "wg-flag", "aria-hidden": "true" }),
              ...ls.map((l, i) => dot(l, i, max, true)),
            ]),
          ]),
          h("span", { class: "wg-score" }, [h("b", { text: String(mine.points) }), h("small", { text: g.open ? "▾ pts" : "▴ pts" })]),
        ]),
      ]);
      grab.addEventListener("pointerdown", down);
      const old = sheet.querySelector(".wg-body");
      const scroll = old ? old.scrollTop : 0;
      const body = h("div", { class: "wg-body" }, g.open || sheet.classList.contains("peek") ? content() : []);
      // While an RFQ is being celebrated, the party takes the bar's place. The same element stays put across redraws,
      // so its animation doesn't start over every few seconds.
      const top = g.party ? g.party.el : grab;
      if (sheet.firstChild === top && sheet.children[1]) sheet.replaceChild(body, sheet.children[1]);
      else sheet.replaceChildren(top, body);
      body.scrollTop = scroll;
      g.back = false;
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

    // An RFQ anywhere on the team: the bar slides over to a random scene and a line for a few seconds, then slides back.
    function celebrate(e, n, key) {
      const r = g.race;
      if (!r) return;
      const you = e.email === r.you;
      const name = (e.name || "").split(/\s+/)[0] || "Someone";
      const co = e.company || "a new account";
      const pts = r.points.rfq + (e.first ? r.points.firstRfq : 0);
      const sc = SCENES.find((x) => x.key === key) || pick(SCENES);
      let line = n > 1 ? `${n} RFQs just landed at once. Somebody check the phones, they're melting.` : you ? pick(sc.you)(co) : pick(sc.them)(name, co);
      if (e.first && n === 1) line += " First one ever from them.";
      const done = () => { if (g.party !== party) return; clearTimeout(party.timer); g.party = null; g.back = true; render(); };
      const el = h("div", { class: `wg-party wg-s-${sc.key}`, role: "status", onclick: done }, [
        h("div", { class: "wg-stage", "aria-hidden": "true" }, stage(sc.key, you ? "YOU" : name.toUpperCase(), co)),
        h("div", { class: "wg-btext" }, [
          h("p", { class: "wg-strike" }, [h("b", { text: sc.title }), h("span", { text: ` +${pts}` })]),
          h("p", { class: "wg-bline", text: line }),
        ]),
      ]);
      if (g.party) clearTimeout(g.party.timer);
      const party = { el, timer: setTimeout(() => done(), 9000) };
      g.party = party;
      render();
    }

    // The little scene on top of the banner.
    function stage(key, who, co) {
      if (key === "news") return [
        h("span", { class: "wg-live", text: "LIVE" }),
        h("span", { class: "wg-ticker" }, [h("span", { text: `${who} LANDS RFQ FROM ${co.toUpperCase()} ★ PHONES REPORTEDLY "STILL HOT" ★ MORE AT 11 ★ ${who} LANDS RFQ FROM ${co.toUpperCase()} ★` })]),
      ];
      if (key === "jackpot") return [h("span", { class: "wg-reels" }, [0, 1, 2].map((i) => h("span", { class: "wg-reel", style: `--i:${i}` }, [
        h("span", { class: "wg-strip" }, ["🍒", "🍋", "🔔", "⭐", "🍒", "🍋", "🔔", "💰"].map((x) => h("span", { text: x }))),
      ])))];
      if (key === "rocket") return [h("span", { class: "wg-rocket", text: "🚀" }), ...[0, 1, 2, 3, 4].map((i) => h("span", { class: "wg-puff", style: `--i:${i}` }))];
      if (key === "mic") return [h("span", { class: "wg-mic", text: "🎤" }), h("span", { class: "wg-boom", text: "BOOM" })];
      return BURST[key].concat(BURST[key]).map((x, i) => h("span", { class: "wg-bit", style: `--x:${(i * 8.3 + Math.random() * 5).toFixed(1)}%; --d:${(Math.random() * 0.9).toFixed(2)}s; --s:${(0.8 + Math.random() * 0.7).toFixed(2)}`, text: x }));
    }

    load(false);
    setInterval(() => load(false), opts.pollMs || 45_000);
    return { render, load, celebrate, get race() { return g.race; } };
  }

  window.WestGame = { create };
})();
