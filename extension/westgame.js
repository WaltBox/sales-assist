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
  // The finish line (Walt 10/27: 370). The server says where it is; this is for an older server.
  const GOAL = 370;
  const MIN = 78; // the closed bar's height
  const PARTY = 180; // the bar while an RFQ is being celebrated
  const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
  const firstName = (l) => l.first || (l.name || l.email).split(/[\s@]/)[0];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

  // What plays when someone lands an RFQ (Walt 10/25: "fun and funny... creative, witty"). One of these at random, like
  // the screen at an alley going nuts on a strike. Each has a little scene and its own lines.
  // Every line says it plainly first ("Chase got an RFQ from Rodda Electric."), then the joke (Walt 10/25: "it should
  // say they got an RFQ, not RFQ incoming").
  const SCENES = [
    { key: "news", title: "BREAKING NEWS",
      them: [(n) => `The rest of the team could not be reached for comment.`, (n) => `Experts are calling it "kind of a big deal."`, (n) => `Everyone else is reportedly "still dialing."`],
      you: [() => `More at 11.`, () => `Your mom has been notified.`] },
    { key: "jackpot", title: "JACKPOT",
      them: [(n) => `Pulled the lever and it paid out.`, (n) => `Somebody check if ${n} is counting cards.`],
      you: [() => `Don't spend it all in one place.`, () => `Ding ding ding.`] },
    { key: "fire", title: "ON FIRE",
      them: [(n) => `${n} is on fire. Somebody get a bucket.`, (n) => `The phone is still smoking.`],
      you: [() => `Stop, drop and keep dialing.`, () => `Careful, the headset's melting.`] },
    { key: "rocket", title: "LIFTOFF",
      them: [(n) => `Houston, we have a quote to write.`, (n) => `${n} is going to the moon. Everyone else is still on the launch pad.`],
      you: [() => `Next stop, the moon.`, () => `Houston, you have a quote to write.`] },
    { key: "money", title: "CHA-CHING",
      them: [(n) => `You can hear the cash register from here.`, (n) => `${n} is officially making it rain.`],
      you: [() => `Go ahead, act like you've been here before.`, () => `Make it rain.`] },
    { key: "mic", title: "MIC DROP",
      them: [(n) => `${n} has left the stage.`, (n) => `${n} would like to thank the Academy.`],
      you: [() => `Mic drop. (Pick it back up, there are more calls.)`, () => `Take a bow. A short one.`] },
    { key: "siren", title: "CODE RED",
      them: [(n) => `This is not a drill. Repeat, this is not a drill.`, (n) => `All units, back to your phones.`],
      you: [() => `This is not a drill.`, () => `You have been caught in possession of an RFQ.`] },
    { key: "disco", title: "DANCE BREAK",
      them: [(n) => `Everybody on the floor. You get 10 seconds.`, (n) => `Somebody cue the music for ${n}.`],
      you: [() => `You've earned exactly one dance move.`, () => `Dance like nobody's on a call.`] },
    { key: "paparazzi", title: "PAPARAZZI",
      them: [(n) => `${n} can't even walk to the fridge now.`, (n) => `No autographs, please. ${n} has calls to make.`],
      you: [() => `No photos please. Okay, one.`, () => `You're famous now.`] },
    { key: "forecast", title: "FORECAST",
      them: [(n) => `Today: 100% chance of more, mostly around ${n}.`, (n) => `Weather alert: heavy RFQ activity near ${n}.`],
      you: [() => `Scattered RFQs all day. Bring an umbrella.`, () => `100% chance of more.`] },
  ];
  /** "Rodda Electric, Inc." → "Rodda Electric", for shouting. */
  const shortCo = (co) => co.replace(/,?\s+(inc|llc|l\.l\.c|co|corp|corporation|company|ltd|incorporated)\.?$/i, "").trim();
  /**
   * The particles: a small physics loop on a canvas (gravity, drag, spin), so a burst looks like a burst and not a row
   * of emoji. Each scene asks for its own kind, where it comes from, how big the burst is, and how much keeps coming.
   * opts: { kind, colors, burst, ox, oy (0..1 of the stage), rate (per frame), spread (0..1 of the width, for trickles) }
   */
  function particles(canvas, opts) {
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0;
    const size = () => { const r = canvas.getBoundingClientRect(); W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();
    const rnd = (a, b) => a + Math.random() * (b - a);
    const colors = opts.colors || ["#ffffff"];
    const col = () => colors[Math.floor(Math.random() * colors.length)];
    const kind = opts.kind;
    const ps = [];
    function spawn(burst) {
      const ox = (opts.ox ?? 0.5) * W, oy = (opts.oy ?? 0.5) * H;
      const spread = (opts.spread ?? 0.7) * W;
      if (kind === "flame") return { x: ox + rnd(-spread / 2, spread / 2), y: oy + rnd(-2, 4), vx: rnd(-0.3, 0.3), vy: rnd(-2.6, -1.2), g: -0.02, life: rnd(22, 42), max: 42, r: rnd(3, 7), flame: true };
      if (kind === "embers") return { x: ox + rnd(-spread / 2, spread / 2), y: oy, vx: rnd(-0.5, 0.5), vy: rnd(-3, -1.2), g: -0.01, life: rnd(40, 80), r: rnd(1, 2.4), c: col(), add: true };
      if (kind === "smoke") return { x: ox + rnd(-10, 10), y: oy, vx: rnd(-1.6, 1.6), vy: rnd(-0.6, 0.8), g: -0.005, life: rnd(50, 90), max: 90, r: rnd(6, 12), grow: rnd(0.25, 0.5), smoke: true };
      if (kind === "paper") return { x: rnd(0, W), y: -12, vx: rnd(-0.6, 0.6), vy: rnd(1, 2.2), g: 0.01, life: 220, w: rnd(7, 10), hgt: rnd(9, 12), rot: rnd(0, 6), vr: rnd(-0.08, 0.08), c: col(), sway: rnd(0, 6), paper: true };
      if (kind === "flashes") return { x: rnd(0, W), y: rnd(0, H * 0.8), vx: 0, vy: 0, g: 0, life: 12, max: 12, flash: rnd(26, 54) };
      if (kind === "stars") return { x: rnd(0, W), y: rnd(0, H), vx: 0, vy: rnd(0.6, 2.2), g: 0, life: 120, len: rnd(2, 8), c: col(), streakDown: true };
      const a = burst ? rnd(Math.PI * 1.05, Math.PI * 1.95) : rnd(Math.PI * 1.2, Math.PI * 1.8), sp = burst ? rnd(3, 9) : rnd(2, 5);
      const base = { x: ox + rnd(-12, 12), y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.18, life: rnd(70, 130), c: col(), rot: rnd(0, 6), vr: rnd(-0.3, 0.3) };
      if (kind === "coins") return { ...base, r: rnd(5, 8), coin: true, flip: rnd(0, 6), vf: rnd(0.15, 0.35) };
      if (kind === "bills") return { ...base, w: rnd(15, 19), hgt: rnd(7, 9), bill: true, vr: rnd(-0.15, 0.15), g: 0.09 };
      if (kind === "sparks") return { ...base, g: 0.12, life: rnd(20, 40), len: rnd(5, 12), spark: true, add: true, vx: Math.cos(a) * sp * 1.3 };
      return { ...base, w: rnd(5, 8), hgt: rnd(8, 12), flip: rnd(0, 6), vf: rnd(0.1, 0.3) }; // confetti
    }
    for (let i = 0; i < (opts.burst ?? 0); i++) ps.push(spawn(true));
    const t0 = performance.now();
    let last = t0, carry = 0;
    function frame(t) {
      if (!canvas.isConnected) return;
      const dt = Math.min(2.5, (t - last) / 16.7); last = t;
      if (canvas.width !== Math.round(canvas.getBoundingClientRect().width * dpr)) size();
      ctx.clearRect(0, 0, W, H);
      carry += (opts.rate || 0) * dt;
      while (carry >= 1) { ps.push(spawn(false)); carry -= 1; }
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.vy += p.g * dt; p.vx *= Math.pow(0.985, dt); p.vy *= Math.pow(0.985, dt);
        p.x += p.vx * dt + (p.sway ? Math.sin((t - t0) / 300 + p.sway) * 0.6 : 0); p.y += p.vy * dt;
        if (p.rot != null) p.rot += p.vr * dt;
        if (p.flip != null) p.flip += (p.vf || 0) * dt;
        if (p.grow) p.r += p.grow * dt;
        p.life -= dt;
        if (p.life <= 0 || p.y > H + 30 || p.y < -60 || p.x < -60 || p.x > W + 60) { ps.splice(i, 1); continue; }
        const k = p.max ? p.life / p.max : Math.min(1, p.life / 20);
        ctx.save();
        ctx.globalAlpha = p.smoke ? k * 0.55 : Math.min(1, k * (p.max ? 1.4 : 1));
        ctx.globalCompositeOperation = p.add || p.flash || p.flame ? "lighter" : "source-over";
        ctx.translate(p.x, p.y);
        if (p.flame) {
          // hot and yellow when it's born, red as it dies
          const c = k > 0.66 ? "255,214,90" : k > 0.33 ? "255,120,20" : "200,30,10";
          const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, p.r * (0.6 + k));
          g2.addColorStop(0, `rgba(${c},.9)`); g2.addColorStop(1, `rgba(${c},0)`);
          ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(0, 0, p.r * (0.6 + k), 0, Math.PI * 2); ctx.fill();
        } else if (p.smoke) {
          ctx.fillStyle = "rgb(210,210,220)"; ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
        } else if (p.flash) {
          const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, p.flash);
          g2.addColorStop(0, "rgba(255,255,255,.95)"); g2.addColorStop(0.2, "rgba(255,245,215,.55)"); g2.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(0, 0, p.flash, 0, Math.PI * 2); ctx.fill();
        } else if (p.streakDown) {
          ctx.strokeStyle = p.c; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, p.len * (1 + p.vy)); ctx.stroke();
        } else if (p.spark) {
          ctx.rotate(Math.atan2(p.vy, p.vx)); ctx.strokeStyle = p.c; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(-p.len, 0); ctx.lineTo(0, 0); ctx.stroke();
        } else if (p.coin) {
          ctx.scale(Math.max(0.12, Math.abs(Math.cos(p.flip))), 1);
          ctx.fillStyle = "#a86f00"; ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(0, 0, p.r * 0.78, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillRect(-p.r * 0.2, -p.r * 0.55, p.r * 0.25, p.r * 0.5);
        } else if (p.bill) {
          ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.rot * 1.7));
          ctx.fillStyle = "#2f9a52"; ctx.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt);
          ctx.fillStyle = "#c8f2d4"; ctx.fillRect(-p.w / 2 + 2, -p.hgt / 2 + 1.5, p.w - 4, p.hgt - 3);
          ctx.fillStyle = "#2f9a52"; ctx.beginPath(); ctx.arc(0, 0, p.hgt * 0.26, 0, Math.PI * 2); ctx.fill();
        } else if (p.r) {
          ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.flip || 0));
          ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt);
          if (p.paper) { ctx.fillStyle = "rgba(0,0,0,.25)"; for (let y = -p.hgt / 2 + 3; y < p.hgt / 2 - 1; y += 2.5) ctx.fillRect(-p.w / 2 + 1.5, y, p.w - 3, 0.7); }
        }
        ctx.restore();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---------- the scenes: each one its own little set piece (Walt 10/25: "each one should be completely different") ----------
  // A scene gets { shout (the name, in caps), co, you, pts } and returns its pieces, when the big moment lands (the
  // points count up then), and what particles to run. Everything is CSS under .wg-x-<key>, drawn, no emoji.
  const L = (cls, props = {}, kids = []) => h("span", { ...props, class: cls }, kids);
  const letters = (text, cls = "wg-let", step = 0.045, start = 0) =>
    [...text].map((c, i) => L(`${cls}${c === " " ? " sp" : ""}`, { style: `--i:${i}; --d:${(start + i * step).toFixed(3)}s` }, [c === " " ? " " : c]));
  const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

  const BUILD = {
    news: ({ shout, co, you }) => ({
      at: 1.15,
      kids: [
        L("wg-studio"), L("wg-globe"),
        L("wg-live", {}, [L("wg-livedot"), "LIVE"]),
        L("wg-l3", {}, [
          L("wg-l3tag", {}, ["BREAKING NEWS"]),
          L("wg-l3name", {}, [L("wg-l3text", {}, [shout])]),
          L("wg-l3sub", {}, [`${you ? "YOU" : "LOCAL BDR"} GETS RFQ FROM ${co.toUpperCase()} · LFGGG!!!`]),
        ]),
        L("wg-ticker", {}, [L("wg-tickin", {}, [`★ ${shout} GOT AN RFQ FROM ${co.toUpperCase()} ★ PHONES REPORTEDLY STILL HOT ★ REST OF TEAM "STILL DIALING" ★ MORE AT 11 ★ ${shout} GOT AN RFQ FROM ${co.toUpperCase()} `])]),
        L("wg-crt"),
      ],
    }),
    jackpot: ({ shout, co }) => ({
      at: 2.05,
      fx: { kind: "coins", colors: ["#ffcc00", "#ffe680", "#f0b400"], burst: 90, ox: 0.5, oy: 0.95, rate: 0.6 },
      kids: [
        L("wg-casino"),
        L("wg-marquee", {}, [L("wg-bulbs"), L("wg-mqname", {}, [shout])]),
        L("wg-machine", {}, repeat(3, (i) => L("wg-reel", { style: `--i:${i}` }, [L("wg-strip", {}, ["🍒", "BAR", "♦", "★", "🍒", "BAR", "♦", "7"].map((x) => L(x === "7" ? "seven" : x === "BAR" ? "bar" : "sym", {}, [x])))]))),
        L("wg-payout", {}, [`RFQ FROM ${co.toUpperCase()} · PAID OUT`]),
      ],
    }),
    fire: ({ shout, co }) => ({
      at: 0.75,
      fx: { kind: "flame", ox: 0.5, oy: 0.5, spread: 0.78, rate: 9 },
      kids: [
        L("wg-heat"),
        L("wg-firename", {}, letters(shout, "wg-flet", 0.03, 0.75)),
        L("wg-onfire", {}, ["IS ON FIRE"]),
        L("wg-fireco", {}, [`RFQ FROM ${co.toUpperCase()} · SOMEBODY GET A BUCKET`]),
      ],
    }),
    rocket: ({ shout, co }) => ({
      at: 2.25,
      fx: { kind: "smoke", ox: 0.5, oy: 1.02, rate: 2.2, delay: 1.55, stopAfter: 1.6 },
      fx2: { kind: "stars", colors: ["#ffffff", "#bcd2ff"], rate: 0.5, delay: 1.9 },
      kids: [
        L("wg-sky"),
        ...["3", "2", "1"].map((n, i) => L("wg-cd", { style: `--i:${i}` }, [n])),
        L("wg-rkt", {}, [L("wg-rkfin l"), L("wg-rkfin r"), L("wg-rkbody", {}, [L("wg-rkwin")]), L("wg-rkflame")]),
        L("wg-moonname", {}, [L("wg-tothe", {}, ["NEXT STOP, THE MOON"]), L("wg-mname", {}, [shout]), L("wg-msub", {}, [`GOT AN RFQ FROM ${co.toUpperCase()} · LFGGG!!!`])]),
      ],
    }),
    money: ({ shout, co, pts }) => ({
      at: 1.85,
      fx: { kind: "bills", burst: 40, ox: 0.5, oy: 0.9, rate: 0.35 },
      kids: [
        L("wg-counter"),
        L("wg-receipt", {}, [
          L("wg-rline head", { style: "--d:.25s" }, ["WESTGATE SUPPLY"]),
          L("wg-rline", { style: "--d:.55s" }, [L("k", {}, ["RFQ"]), L("dots"), L("v", {}, [co.toUpperCase()])]),
          L("wg-rline", { style: "--d:.85s" }, [L("k", {}, ["CLOSED BY"]), L("dots"), L("v", {}, [shout])]),
          L("wg-rline", { style: "--d:1.15s" }, [L("k", {}, ["TOTAL"]), L("dots"), L("v", {}, [`+${pts} PTS`])]),
          L("wg-rline foot", { style: "--d:1.45s" }, ["*** THANK YOU, COME AGAIN ***"]),
          L("wg-zig"),
        ]),
        L("wg-stamp", {}, [L("wg-stampname", {}, [shout]), L("wg-stampsub", {}, ["CHA-CHING!"])]),
      ],
    }),
    mic: ({ shout, co }) => ({
      at: 1.6,
      fx: { kind: "sparks", colors: ["#ffffff", "#ffcc00", "#ff8a00"], burst: 70, ox: 0.78, oy: 0.83 },
      kids: [
        L("wg-stagebg"), L("wg-spot"),
        L("wg-stagename", {}, [L("wg-presenting", {}, ["PLEASE WELCOME"]), L("wg-sname", {}, [shout]), L("wg-ssub", {}, [`WITH AN RFQ FROM ${co.toUpperCase()}`])]),
        L("wg-crowd", {}, repeat(14, (i) => L("wg-head", { style: `--i:${i}` }))),
        L("wg-mike", {}, [L("wg-mgrille"), L("wg-mhandle")]),
        L("wg-boom", {}, ["BOOM"]),
      ],
    }),
    siren: ({ shout, co }) => ({
      at: 0.6,
      kids: [
        L("wg-redroom"), L("wg-beacon"), L("wg-hazard top"), L("wg-hazard bot"),
        L("wg-drill", {}, ["⚠ THIS IS NOT A DRILL ⚠"]),
        L("wg-warn", {}, [L("wg-warnname", {}, [shout]), L("wg-warnsub", {}, [`HAS AN RFQ FROM ${co.toUpperCase()}`])]),
      ],
    }),
    disco: ({ shout, co }) => ({
      at: 0.9,
      fx: { kind: "confetti", colors: ["#ff3cac", "#2bd2ff", "#ffcc00", "#7cff6b", "#ffffff"], burst: 80, ox: 0.5, oy: 0.25, rate: 0.6 },
      kids: [
        L("wg-club"), L("wg-floor", {}, repeat(24, (i) => L("wg-tile", { style: `--i:${i}; --d:${((i * 7) % 5) * 0.18}s` }))),
        L("wg-dball"), L("wg-dlights"),
        L("wg-eq l", {}, repeat(5, (i) => L("wg-bar", { style: `--i:${i}` }))), L("wg-eq r", {}, repeat(5, (i) => L("wg-bar", { style: `--i:${i}` }))),
        L("wg-dname", {}, letters(shout, "wg-dlet", 0.07, 0.2)),
        L("wg-dsub", {}, [`GOT AN RFQ FROM ${co.toUpperCase()} · EVERYBODY DANCE`]),
      ],
    }),
    paparazzi: ({ shout, co }) => ({
      at: 0.95,
      fx: { kind: "flashes", rate: 0.22, delay: 0.3 },
      kids: [
        L("wg-carpet"), L("wg-rope l"), L("wg-rope r"),
        L("wg-wofstar", {}, [L("wg-wofname", {}, [shout]), L("wg-wofsub", {}, ["RFQ HALL OF FAME"])]),
        L("wg-papsub", {}, [`SPOTTED LEAVING ${co.toUpperCase()} WITH AN RFQ`]),
        L("wg-freeze"),
      ],
    }),
    forecast: ({ shout, co }) => ({
      at: 1.1,
      fx: { kind: "paper", colors: ["#ffffff", "#eef3ff", "#fff6cc"], rate: 0.5, delay: 0.6 },
      kids: [
        L("wg-map"), L("wg-radar"), L("wg-blip"),
        L("wg-storm", {}, [L("wg-hurr", {}, ["HURRICANE"]), L("wg-hname", {}, [shout]), L("wg-hsub", {}, [`MAKING LANDFALL AT ${co.toUpperCase()}`])]),
        L("wg-wcard", {}, [L("wg-cloud", {}, [L("wg-bolt")]), L("wg-pct", {}, ["100%"]), L("wg-pctsub", {}, ["CHANCE OF RFQs"])]),
      ],
    }),
  };


  /**
   * opts: load() → the race; liveDials() → your calls today as this screen counts them (it knows before Close does);
   * store { get(key), set(key, value) }; pollMs; webApp (a link for the owner to pick who plays); onChange();
   * live() → { now, day, events with showAt }: the quick check that plays RFQs on every screen at once.
   */
  function create(opts) {
    const g = { race: null, seen: null, open: false, week: false, lane: null, drag: null, party: null, back: false };

    // What's been celebrated already today. (A new key 10/26: RFQs are now one id per company per day.)
    const SEEN = "westGameSeen2";
    async function seenFor(day, events) {
      if (!g.seen) {
        const saved = await opts.store.get(SEEN);
        // First look today: what already happened isn't news.
        g.seen = saved && saved.day === day ? saved : { day, ids: events.map((e) => e.id) };
        opts.store.set(SEEN, g.seen);
      }
      if (g.seen.day !== day) g.seen = { day, ids: [] };
      return g.seen;
    }
    const goal = () => (g.race && g.race.goal) || GOAL;
    const markSeen = (id) => { if (!g.seen.ids.includes(id)) { g.seen.ids.push(id); opts.store.set(SEEN, g.seen); } };

    async function load(fresh) {
      let r;
      try { r = await opts.load(fresh); } catch { return; }
      g.race = r;
      await seenFor(r.day, r.events);
      // Without the live check (an older server), celebrate from here.
      if (!opts.live) {
        const fresh2 = r.events.filter((e) => !g.seen.ids.includes(e.id));
        fresh2.forEach((e) => markSeen(e.id));
        if (fresh2.length) celebrate(fresh2[fresh2.length - 1], fresh2.length);
      }
      render();
      if (opts.onChange) opts.onChange();
    }

    // Every screen at the same moment (Walt 10/26): each RFQ comes with the time it plays, set once by the server, and
    // this screen waits for that moment on the server's clock. Checked every few seconds, so a tap shows within seconds.
    let clock = 0; // the server's time minus this computer's
    const waiting = new Set();
    const queue = [];
    async function live() {
      if (!g.race) return;
      const t0 = Date.now();
      let r;
      try { r = await opts.live(); } catch { return; }
      const t1 = Date.now();
      clock = Date.parse(r.now) - (t0 + t1) / 2;
      // Everyone's calls as they're made (Walt 10/27): the dots move on this check, not the next full load.
      if (r.lanes && JSON.stringify(r.lanes) !== JSON.stringify(g.race.lanes)) {
        g.race = { ...g.race, lanes: r.lanes, goal: r.goal || g.race.goal, points: r.points || g.race.points };
        if (!g.drag && !g.party) render();
      }
      if (r.chat) gotChat(r.chat);
      await seenFor(r.day, r.events);
      const serverNow = Date.now() + clock;
      for (const e of r.events) {
        if (g.seen.ids.includes(e.id) || waiting.has(e.id)) continue;
        const at = Date.parse(e.showAt || r.now);
        if (serverNow - at > 60_000) { markSeen(e.id); continue; } // opened the panel late: it's old news
        waiting.add(e.id);
        setTimeout(() => { waiting.delete(e.id); if (g.seen.ids.includes(e.id)) return; markSeen(e.id); play(e); load(true); }, Math.max(0, at - serverNow));
      }
    }
    // Two at once take turns.
    function play(e) { if (g.party) queue.push(e); else celebrate(e, 1); }
    // The person who tapped "RFQ came in" sees it the moment the save comes back (10/27), not on the next check.
    function playNow(e) {
      if (g.seen && g.seen.ids.includes(e.id)) return;
      if (g.seen) markSeen(e.id);
      play(e);
      load(true);
    }

    // ---------- the chat (Walt 10/27): one box that survives redraws, so typing isn't wiped every few seconds ----------
    g.chat = [];
    g.chatSeen = null; // the last message this screen has shown
    function gotChat(msgs) {
      const last = msgs[msgs.length - 1];
      const before = g.chatSeen;
      const changed = msgs.length !== g.chat.length || (last && last.id) !== (g.chat[g.chat.length - 1] || {}).id;
      g.chat = msgs;
      if (!changed) return;
      if (before === null) { g.chatSeen = last ? last.id : ""; fillChat(); return; }
      const fresh = msgs.slice(msgs.findIndex((m) => m.id === before) + 1).filter((m) => m.email !== g.race.you);
      g.chatSeen = last ? last.id : "";
      fillChat();
      // Closed: the newest line takes over the bar's words for a few seconds.
      if (fresh.length && !g.open) {
        const m = fresh[fresh.length - 1];
        clearTimeout(g.toastTimer);
        g.toast = m;
        g.toastTimer = setTimeout(() => { g.toast = null; if (!g.drag && !g.party) render(); }, 7000);
        if (!g.drag && !g.party) render();
      }
    }
    function chatBox() {
      if (g.chatEl) return g.chatEl;
      const msgs = h("div", { class: "wg-msgs", role: "log", "aria-live": "polite" });
      const input = h("input", { class: "wg-input", type: "text", maxlength: "280", placeholder: "Talk some trash…", "aria-label": "Message the team" });
      const send = h("button", { class: "wg-send", type: "submit", text: "Send" });
      const form = h("form", { class: "wg-say", onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || !opts.chat) return;
        input.value = "";
        send.disabled = true;
        try { const r = await opts.chat(text); if (r && r.chat) { g.chatSeen = (r.chat[r.chat.length - 1] || {}).id || ""; g.chat = r.chat; fillChat(true); } }
        catch { input.value = text; }
        finally { send.disabled = false; input.focus(); }
      } }, [input, send]);
      g.chatEl = h("section", { class: "wg-chat" }, [h("p", { class: "wg-label", text: "Chat" }), msgs, form]);
      fillChat();
      return g.chatEl;
    }
    function fillChat(toBottom) {
      if (!g.chatEl) return;
      const box = g.chatEl.querySelector(".wg-msgs");
      const atBottom = toBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      const time = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      box.replaceChildren(...(g.chat.length ? g.chat.map((m) => h("div", { class: `wg-msg${g.race && m.email === g.race.you ? " me" : ""}` }, [
        h("b", { text: (m.name || "").split(/\s+/)[0] }), h("span", { text: m.text }), h("small", { text: time(m.at) }),
      ])) : [h("p", { class: "wg-muted", text: "Quiet in here. Say something." })]));
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
    const typing = () => !!(g.chatEl && g.chatEl.contains(document.activeElement));

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

    // The dot moves with points, so anything that scores moves you, not just calls (Walt 10/26).
    const pctOf = (l, max) => (l.error ? 0 : Math.min(1, l.points / max) * 100);
    // shift: how many dots over to nudge this one, so people sitting on the same spot fan out instead of hiding.
    const dot = (l, i, max, big, shift = 0) => h("span", {
      class: `wg-dot${l.email === g.race.you ? " me" : ""}${i === 0 && l.points > 0 ? " lead" : ""}${l.error ? " broken" : ""}${l.guest ? " guest" : ""}`,
      style: `left: calc(${pctOf(l, max)}% - ${pctOf(l, max) / 100} * var(--wg-dot) + ${shift} * var(--wg-dot) * .72)`,
      title: `${l.name}: ${plural(l.dials, "call", "calls")}, ${l.points} points`,
      text: big ? firstName(l).slice(0, 1).toUpperCase() : null,
    });

    /** The dots on the one-track bar. People on the same spot stack, with you drawn last, on top (Walt 10/26). */
    function fanned(ls) {
      return ls.map((l, i) => ({ l, i, shift: 0 })).sort((a, b) => (a.l.email === g.race.you) - (b.l.email === g.race.you));
    }

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
          i === 0 && l.points > 0 ? h("span", { class: "wg-tag gold", text: "👑 Lead" }) : null,
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
          tr("Conversations", full.reached, w && w.reached, r.points.reached ? `×${r.points.reached}` : ""),
          tr("Line cards", full.lineCards, w && w.lineCards, r.points.lineCard ? `×${r.points.lineCard}` : ""),
          tr("RFQs", full.rfqs, w && w.rfqs, `×${r.points.rfq}`),
          full.firstRfqs && r.points.firstRfq ? tr("First RFQs", full.firstRfqs, null, `+${r.points.firstRfq}`) : null,
          h("tr", { class: "wg-total" }, [h("td", { text: "Points" }), h("td", { text: String(full.points) }), h("td", { text: w ? String(w.points) : "–" }), h("td")]),
        ]),
        rfqList(full),
      ]);
    }

    /** Who each RFQ came from (Walt 10/27): today's first, then the rest of the week. */
    function rfqList(l) {
      const r = g.race;
      const seen = new Set();
      const rows = [
        ...r.events.filter((e) => e.email === l.email && e.day === r.day).map((e) => ({ company: e.company, day: e.day })),
        ...(l.rfqFrom || []),
      ].filter((x) => { const k = `${x.company}|${x.day}`; if (seen.has(k)) return false; seen.add(k); return true; });
      if (!rows.length && !l.rfqs) return null;
      const when = (day) => day === r.day ? "Today" : new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short" });
      return h("div", { class: "wg-from" }, [
        h("p", { class: "wg-label", text: "RFQs from" }),
        rows.length ? h("ul", {}, rows.map((x) => h("li", {}, [h("span", { text: x.company || "An account" }), h("small", { text: when(x.day) })])))
          : h("p", { class: "wg-muted", text: "Counted, the names show up in a minute." }),
      ]);
    }

    /** The week at a glance (Walt 10/27): ranked by the week's points, with the days each person won. */
    function leaderboard(ls) {
      const r = g.race;
      const days = r.weekDays || [];
      const wins = (email) => days.filter((d) => d.winner && d.winner.email === email).length;
      const dayName = (day) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short" });
      const cell = (text, cls) => h("td", { class: cls || "", text: String(text) });
      return h("section", { class: "wg-board-week" }, [
        h("table", {}, [
          h("tr", {}, ["", "", "Pts", "Calls", "Cards", "RFQs", "Days"].map((t) => h("th", { text: t }))),
          ...ls.map((l, i) => h("tr", { class: `${l.email === r.you ? "me" : ""}${i === 0 && l.points > 0 ? " top" : ""}` }, [
            cell(i + 1, "wg-rank"),
            h("td", { class: "wg-who" }, [l.email === r.you ? `${firstName(l)} (you)` : l.name, l.guest ? h("span", { class: "wg-tag", text: "Guest" }) : null]),
            cell(l.points, "wg-num strong"), cell(l.dials, "wg-num"), cell(l.lineCards, "wg-num"), cell(l.rfqs, "wg-num"),
            cell(wins(l.email) || "–", "wg-num"),
          ])),
        ]),
        days.length ? h("p", { class: "wg-days" }, days.map((d) => h("span", {}, [h("b", { text: dayName(d.day) }), d.winner ? ` ${(d.winner.name || "").split(/\s+/)[0]} ${d.winner.points}` : " –"]))) : null,
      ]);
    }

    function content() {
      const r = g.race;
      const ls = lanes();
      const max = g.week ? goal() * 5 : goal();
      const tab = (on, text, week) => h("button", { class: `wg-tab${on ? " on" : ""}`, text, onclick: () => { g.week = week; render(); } });
      const today = r.events.filter((e) => e.day === r.day);
      return [
        h("div", { class: "wg-head" }, [
          h("h2", { class: "wg-title", text: g.week ? "This week's competition" : "Today's competition" }),
          h("div", { class: "wg-tabs" }, [tab(!g.week, "Today", false), tab(g.week, "Week", true)]),
        ]),
        g.week ? leaderboard(ls) : null,
        h("div", { class: "wg-field" }, ls.flatMap((l, i) => lane(l, i, max))),
        opts.chat ? chatBox() : null,
        h("section", { class: "wg-feed" }, [
          h("p", { class: "wg-label", text: today.length ? `RFQs today · ${today.length}` : "RFQs today" }),
          today.length ? h("ul", {}, today.slice().reverse().map((e) => h("li", {}, [h("b", { text: (e.name || "").split(/\s+/)[0] }), ` · ${e.company || "an account"}`, e.first ? h("span", { class: "wg-tag good", text: "First RFQ" }) : null])))
            : h("p", { class: "wg-muted", text: "None yet. The first one sets off something stupid on every screen." }),
        ]),
        h("p", { class: "wg-muted", text: `Points: ${[["call", r.points.dial], ["conversation", r.points.reached], ["line card", r.points.lineCard], ["new company's RFQ", r.points.rfq]].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ")}. ${goal()} points finishes the day. Starts over every morning.` }),
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
      const max = goal();
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
              g.toast ? h("span", { class: "wg-sum wg-said" }, [h("b", { text: `${(g.toast.name || "").split(/\s+/)[0]}: ` }), g.toast.text]) : h("span", { class: "wg-sum", text: blurb(ls) }),
            ]),
            h("span", { class: "wg-mini" }, [
              h("i", { class: "wg-trail", style: `width: calc(${pctOf(mine, max)}% - ${pctOf(mine, max) / 100} * var(--wg-dot) + var(--wg-dot) / 2)` }),
              h("span", { class: "wg-flag", "aria-hidden": "true" }),
              ...fanned(ls).map(({ l, i, shift }) => dot(l, i, max, true, shift)),
            ]),
          ]),
          h("span", { class: "wg-score" }, [h("b", { text: String(mine.points) }), h("small", { text: g.open ? "▾ pts" : "▴ pts" })]),
        ]),
      ]);
      grab.addEventListener("pointerdown", down);
      const old = sheet.querySelector(".wg-body");
      // Typing in the chat: leave the body alone (moving the box would drop the cursor); just swap the bar.
      if (typing() && old && !g.party) { if (sheet.firstChild !== grab) sheet.replaceChild(grab, sheet.firstChild); g.back = false; return; }
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

    // An RFQ anywhere on the team: the bar turns into one of the scenes for a few seconds, then slides back.
    function celebrate(e, n, key) {
      const r = g.race;
      if (!r) return;
      const you = e.email === r.you;
      const name = (e.name || "").split(/\s+/)[0] || "Someone";
      const co = shortCo(e.company || "a new account");
      const pts = r.points.rfq + (e.first ? r.points.firstRfq : 0);
      const sc = SCENES.find((x) => x.key === key) || pick(SCENES);
      let line = n > 1 ? `${n} RFQs just landed at once. Somebody check the phones, they're melting.`
        : you ? `You got an RFQ from ${co}. ${pick(sc.you)()}` : `${name} got an RFQ from ${co}. ${pick(sc.them)(name)}`;
      if (e.first && n === 1) line += " First one ever from them.";
      const full = (e.name || "Someone").trim();
      const shout = (you ? "YOU!!" : full.length <= 14 ? full : name).toUpperCase();
      const scene = BUILD[sc.key]({ shout, co, you, pts });
      const count = h("b", { class: "wg-count", text: "+0" });
      const canvases = [scene.fx, scene.fx2].filter(Boolean).map(() => h("canvas", { class: "wg-fx" }));
      const done = () => {
        if (g.party !== party) return;
        clearTimeout(party.timer); g.party = null; g.back = true; render();
        if (queue.length) setTimeout(() => celebrate(queue.shift(), 1), 600);
      };
      const el = h("div", { class: `wg-party wg-x-${sc.key}`, role: "status", onclick: done, style: `--at:${scene.at}s` }, [
        h("div", { class: "wg-stage", "aria-hidden": "true" }, [...scene.kids.slice(0, 1), ...canvases, ...scene.kids.slice(1)]),
        h("div", { class: "wg-btext" }, [h("p", { class: "wg-bline", text: line }), count]),
      ]);
      if (g.party) clearTimeout(g.party.timer);
      const party = { el, timer: setTimeout(() => done(), 9500) };
      g.party = party;
      render();
      const calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (calm) { count.textContent = `+${pts}`; return; }
      [scene.fx, scene.fx2].filter(Boolean).forEach((fx, i) => {
        setTimeout(() => {
          if (!canvases[i].isConnected) return;
          particles(canvases[i], fx);
          if (fx.stopAfter) setTimeout(() => { fx.rate = 0; }, fx.stopAfter * 1000);
        }, (fx.delay ?? scene.at) * 1000);
      });
      // the points tick up when the big moment lands, then pop
      setTimeout(() => {
        const t0 = performance.now();
        const tick = (t) => {
          const k = Math.min(1, (t - t0) / 650), v = Math.round(pts * (1 - Math.pow(1 - k, 3)));
          count.textContent = `+${v}`;
          if (k < 1) requestAnimationFrame(tick); else count.classList.add("pop");
        };
        requestAnimationFrame(tick);
      }, (scene.at + 0.2) * 1000);
    }

    load(false);
    setInterval(() => load(false), opts.pollMs || 20_000);
    if (opts.live) setInterval(live, 3000);
    return { render, load, celebrate, playNow, get race() { return g.race; } };
  }

  window.WestGame = { create };
})();
