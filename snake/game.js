/* Echo Snake UI: rendering, effects, input, screens. Rules live in core.js. */
(() => {
  "use strict";
  const { createGame, dailySeed } = EchoCore;
  const audio = EchoAudio();
  const $ = id => document.getElementById(id);
  const N = 20;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  // ------------------------------------------------------------------ storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem("echo." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("echo." + k, JSON.stringify(v)); } catch (e) {} },
  };
  const reduceDefault = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } })();
  const settings = { sfx: store.get("sfx", true), music: store.get("music", true), reduce: store.get("reduce", reduceDefault), cb: store.get("cb", false) };

  const PALETTES = {
    normal: { snake: "#4ade80", head: "#d1fae5", echo: "#22d3ee", food: "#fb7185", gold: "#fbbf24", danger: "251,113,133", grid: "rgba(120,160,210,.055)" },
    cb:     { snake: "#ffb000", head: "#fff1cc", echo: "#4da3ff", food: "#ffffff", gold: "#e879f9", danger: "255,255,255", grid: "rgba(160,160,200,.07)" },
  };
  const pal = () => (settings.cb ? PALETTES.cb : PALETTES.normal);
  function applyPalette() {
    document.documentElement.style.setProperty("--accent", pal().echo);
    document.documentElement.style.setProperty("--gold", pal().gold);
  }

  // ------------------------------------------------------------------ canvas
  const cv = $("cv"), ctx = cv.getContext("2d");
  let cell = 24, dpr = 1;
  function resize() {
    const r = $("stage").getBoundingClientRect();
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const px = Math.max(200, Math.round(r.width * dpr));
    if (cv.width !== px) { cv.width = px; cv.height = px; }
    cell = cv.width / N;
  }
  new ResizeObserver(resize).observe($("stage"));
  addEventListener("resize", resize);

  // ------------------------------------------------------------------ app state
  const app = { screen: "title", mode: "endless", back: "title", paused: false, run: null, demo: null, hints: store.get("hints", {}), overTimer: 0, time: 0, hitStop: 0 };

  function makeRun(game, bot) {
    return { g: game, bot: bot || null, acc: 0, alpha: 1, prev: game.snake.map(p => ({ x: p.x, y: p.y })), danger: 0, dangerTarget: 0,
             goldLife: 1, foodBorn: 0, displayScore: 0, lastMult: 1, over: false, nextRestart: 0 };
  }
  function newDemo() {
    const g = createGame({});
    app.demo = makeRun(g, EchoBots.makeBot({ depth: 22, noise: 0.04 }));
  }
  const view = () => (app.screen === "title" || (app.back === "title" && (app.screen === "how" || app.screen === "settings"))) ? app.demo : app.run || app.demo;

  // ------------------------------------------------------------------ effects
  const fx = { parts: [], texts: [], rings: [], shake: 0, flash: 0, flashColor: "255,255,255", punch: 0 };
  const ec = (x, y) => ({ x: (x + 0.5) * cell, y: (y + 0.5) * cell });

  function burst(x, y, color, n, speed, life) {
    if (settings.reduce) n = Math.ceil(n / 3);
    const c = ec(x, y);
    for (let i = 0; i < n && fx.parts.length < 700; i++) {
      const a = Math.random() * 6.283, s = rand(0.3, 1) * speed * cell;
      fx.parts.push({ x: c.x, y: c.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.5, 1) * life, max: life, color, size: rand(0.06, 0.16) * cell });
    }
  }
  function ring(x, y, color, max = 3, life = 0.6) { const c = ec(x, y); fx.rings.push({ x: c.x, y: c.y, t: 0, life, max: max * cell, color }); }
  function floatText(x, y, text, color, size = 0.62) {
    const c = ec(x, y);
    fx.texts.push({ x: c.x, y: c.y - cell * 0.6, text, color, t: 0, life: 0.9, size: size * cell });
  }
  function shake(a) { if (!settings.reduce) fx.shake = Math.max(fx.shake, a); }
  function punch(a) { if (!settings.reduce) fx.punch = Math.max(fx.punch, a); }
  function flash(color, a) { if (!settings.reduce) { fx.flash = Math.max(fx.flash, a); fx.flashColor = color; } }

  function updateFX(dt) {
    const s = dt / 1000;
    fx.parts = fx.parts.filter(p => (p.life -= s) > 0);
    fx.parts.forEach(p => { p.x += p.vx * s; p.y += p.vy * s; p.vx *= 0.94; p.vy *= 0.94; });
    fx.texts = fx.texts.filter(t => (t.t += s) < t.life);
    fx.rings = fx.rings.filter(r => (r.t += s) < r.life);
    fx.shake = Math.max(0, fx.shake - s * 3);
    fx.flash = Math.max(0, fx.flash - s * 2.2);
    fx.punch = Math.max(0, fx.punch - s * 5);
  }

  // ------------------------------------------------------------------ hints and toasts
  let toastT = 0;
  function toast(html, ms = 3200) {
    const el = $("toast"); el.innerHTML = html; el.classList.add("show"); toastT = ms;
  }
  function hint(key, html, ms) {
    if (app.hints[key]) return;
    app.hints[key] = 1; store.set("hints", app.hints); toast(html, ms);
  }
  function banner(text) {
    const b = $("banner"); b.textContent = text; b.classList.remove("go"); void b.offsetWidth; b.classList.add("go");
  }

  // ------------------------------------------------------------------ game flow
  const RANKS = [[0, "Static"], [150, "Whisper"], [450, "Ripple"], [1000, "Reverb"], [2000, "Resonance"], [4000, "Harmonic"], [8000, "Echo Master"]];
  const rankFor = s => RANKS.filter(r => s >= r[0]).pop()[1];
  const bestKey = () => (app.mode === "daily" ? "best.daily." + dailySeed() : "best.endless");
  const bestScore = () => store.get(bestKey(), 0);

  function startGame(mode) {
    audio.unlock(); applyAudio();
    app.mode = mode || app.mode;
    const g = createGame(app.mode === "daily" ? { seed: dailySeed() } : {});
    app.run = makeRun(g);
    fx.parts.length = 0; fx.texts.length = 0; fx.rings.length = 0; fx.shake = 0; fx.flash = 0;
    app.paused = false; app.overTimer = 0;
    setScreen("playing");
    audio.sfx.start(); banner("GO");
    hint("steer", "Steer with <b>arrows / WASD</b> or swipe. The board wraps around.", 3800);
    updateMusic(); updateHud(true);
  }

  function setScreen(s) {
    app.screen = s;
    for (const id of ["title", "how", "settings", "pause", "over"]) $("ov-" + id).classList.toggle("show", id === s);
    const first = { title: "b-play", how: null, settings: null, pause: "b-resume", over: "b-again" }[s];
    const focus = first ? $(first) : document.querySelector("#ov-" + s + " [data-close]");
    if (focus && s !== "playing") setTimeout(() => focus.focus({ preventScroll: true }), 30);
    if (s === "title") { refreshTitle(); if (!app.demo || !app.demo.g.alive) newDemo(); audio.setIntensity(1, 110); }
    document.body.classList.toggle("on-title", s === "title" || (app.back === "title" && (s === "how" || s === "settings")));
  }

  function refreshTitle() {
    $("t-best").textContent = store.get("best.endless", 0);
    $("t-daily").textContent = store.get("best.daily." + dailySeed(), 0);
    const d = new Date(); $("daily-sub").textContent = "Seed " + dailySeed() + " · same for everyone today (" + d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ")";
  }

  function pause(on) {
    if (app.screen !== "playing" && app.screen !== "pause") return;
    if (on) { setScreen("pause"); app.paused = true; audio.setIntensity(0); } else { setScreen("playing"); app.paused = false; app.run.acc = 0; updateMusic(); }
  }

  function updateMusic() {
    const r = app.run; if (!r) return;
    audio.setIntensity(r.g.alive ? 1 + (r.g.echoCount() >= 2) + (r.g.echoCount() >= 3) : 0, r.g.tickMs());
  }

  function doTick(run, player) {
    const g = run.g;
    if (run.bot) {
      const d = run.bot(g);
      if (d.phase) g.phaseShift(); else if (d.dir) g.turn(d.dir[0], d.dir[1]);
    }
    run.prev = g.snake.map(p => ({ x: p.x, y: p.y }));
    g.step();
    run.dangerTarget = g.alive && g.safeMoves().length <= 1 ? 1 : 0;
    handleEvents(run, player);
    if (player) {
      if (g.ghostCells().length) {
        if (g.echoArmed()) hint("echo", "That's <b>your past</b> replaying. Don't touch it.", 4200);
        else hint("echo0", "Your past replays as an <b>echo</b>. Harmless for now: it arms after food #" + g.P.graceFoods + ".", 5200);
      }
      if (g.ticks === 11 && g.alive && g.echoArmed()) hint("wrap", "Going straight? The board wraps into your own echo.", 3600);
      if (g.charges > 0 && run.dangerTarget) hint("phase", "Trapped? Press <b>Space</b> to <b>Phase</b> through echoes.", 4200);
    }
  }

  function handleEvents(run, player) {
    const g = run.g;
    for (const e of g.drainEvents()) {
      const c = pal();
      switch (e.type) {
        case "eat":
          burst(e.at.x, e.at.y, c.food, 16, 4.5, 0.6); ring(e.at.x, e.at.y, c.food, 2.4, 0.5);
          floatText(e.at.x, e.at.y, "+" + e.pts, e.mult > 1 ? c.gold : "#fff");
          run.foodBorn = app.time; punch(0.5);
          if (player) { audio.sfx.eat(e.combo); updateMusic(); }
          break;
        case "graze":
          burst(e.at.x, e.at.y, c.echo, 3, 2.5, 0.35);
          if (player) audio.sfx.graze(g.multiplier());
          break;
        case "phase":
          ring(g.snake[0].x, g.snake[0].y, c.echo, 5, 0.7); flash("34,211,238", 0.25);
          if (player) { audio.sfx.phase(); navigator.vibrate?.(18); }
          break;
        case "phaseThrough":
          burst(e.at.x, e.at.y, c.echo, 20, 5, 0.6); floatText(e.at.x, e.at.y, "PHASE +" + e.pts, c.echo, 0.55); punch(0.8); if (player && !settings.reduce) app.hitStop = 55;
          if (player) audio.sfx.phaseThrough();
          break;
        case "phaseEnd": if (player) audio.sfx.phaseEnd(); break;
        case "charge":
          floatText(g.snake[0].x, g.snake[0].y, "+CHARGE", c.echo, 0.5);
          if (player) audio.sfx.charge();
          break;
        case "goldenSpawn":
          run.goldLife = Math.max(1, e.at.expires - g.ticks);
          ring(e.at.x, e.at.y, c.gold, 3.5, 0.9);
          if (player) { audio.sfx.goldenSpawn(); hint("gold", "<b>Golden food</b>: big points, but it vanishes fast.", 3600); }
          break;
        case "golden":
          burst(e.at.x, e.at.y, c.gold, 34, 6, 0.8); ring(e.at.x, e.at.y, c.gold, 6, 0.8);
          floatText(e.at.x, e.at.y, "GOLD +" + e.pts, c.gold, 0.6); flash("251,191,36", 0.2); shake(0.15); punch(1); if (player && !settings.reduce) app.hitStop = 70;
          if (player) audio.sfx.golden();
          break;
        case "goldenGone": if (player) audio.sfx.goldenGone(); break;
        case "armed":
          banner("ECHO ARMED"); shake(0.4); flash(c.danger, 0.2);
          if (player) { audio.sfx.newEcho(); $("live").textContent = "Echo armed"; }
          break;
        case "newEcho":
          banner("ECHO ×" + g.echoCount()); shake(0.35); flash(c.danger, 0.15);
          if (player) { audio.sfx.newEcho(); $("live").textContent = "Echo " + g.echoCount(); }
          break;
        case "comboLost": if (player) audio.sfx.comboLost(); break;
        case "die": onDie(run, e, player); break;
      }
    }
  }

  function onDie(run, e, player) {
    const g = run.g, c = pal();
    run.over = true;
    g.snake.forEach((p, i) => burst(p.x, p.y, i === 0 ? "#fff" : c.snake, i === 0 ? 30 : 7, 5, 1.0));
    ring(g.snake[0].x, g.snake[0].y, c.food, 7, 0.9);
    if (!player) { run.nextRestart = app.time + 1400; return; }
    shake(1); flash(c.danger, 0.5);
    audio.sfx.die(); audio.setIntensity(0); navigator.vibrate?.([70, 40, 90]);
    app.overTimer = 900;
  }

  function showOver() {
    const g = app.run.g, prevBest = bestScore(), isBest = g.score > prevBest;
    if (isBest) store.set(bestKey(), g.score);
    store.set("games", store.get("games", 0) + 1);
    $("o-rank").textContent = rankFor(g.score);
    $("o-score").textContent = g.score;
    $("o-new").textContent = isBest && g.score > 0 ? "NEW BEST" : (app.mode === "daily" ? "DAILY " + dailySeed() : "");
    $("o-foods").textContent = g.foods; $("o-combo").textContent = "x" + Math.min(g.P.maxMult, 1 + Math.floor(g.stats.maxCombo / 2));
    $("o-grazes").textContent = g.stats.grazes; $("o-phases").textContent = g.stats.phases; $("o-golds").textContent = g.stats.goldens;
    $("o-cause").textContent = g.cause === "echo" ? "Echo" : g.cause === "self" ? "Self" : "Clear";
    $("live").textContent = "Game over. Score " + g.score + ". " + rankFor(g.score) + ".";
    setScreen("over");
  }

  // ------------------------------------------------------------------ time stepping
  function advance(run, dt, player) {
    const g = run.g;
    if (!g.alive) { run.alpha = 1; return; }
    run.acc += dt;
    const ms = run.bot ? Math.max(70, g.tickMs() - 15) : g.tickMs();
    let guard = 0;
    while (run.acc >= ms && g.alive && guard++ < 4) { run.acc -= ms; doTick(run, player); }
    if (guard >= 4) run.acc = 0;
    run.alpha = g.alive ? clamp(run.acc / ms, 0, 1) : 1;
  }

  let last = 0;
  function frame(ts) {
    const dt = Math.min(64, ts - last || 16); last = ts; app.time = ts;
    pollGamepad();
    if (app.hitStop > 0) app.hitStop -= dt;
    else if (app.screen === "playing" && !app.paused) advance(app.run, dt, true);
    else if (app.screen === "over") { /* frozen on the final state; fx keep animating */ }
    else if (app.demo && (app.screen === "title" || app.back === "title")) {
      if (app.demo.over && ts > app.demo.nextRestart) newDemo(); else advance(app.demo, dt, false);
    }
    if (app.overTimer > 0 && (app.overTimer -= dt) <= 0) showOver();
    if (toastT > 0 && (toastT -= dt) <= 0) $("toast").classList.remove("show");
    updateFX(dt);
    const r = view();
    const ttl = app.screen === "playing" && app.run ? "Echo Snake \u00b7 " + app.run.g.score : "Echo Snake";
    if (document.title !== ttl) document.title = ttl;
    if (r) { r.danger += (r.dangerTarget - r.danger) * Math.min(1, dt / 120); updateHud(false); render(r, ts); }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ HUD
  function updateHud(force) {
    const r = app.run; if (!r) return;
    const g = r.g;
    r.displayScore += (g.score - r.displayScore) * 0.25;
    if (Math.abs(g.score - r.displayScore) < 1) r.displayScore = g.score;
    const s = Math.round(r.displayScore);
    if (force || $("score").textContent !== String(s)) $("score").textContent = s;
    const m = g.multiplier(), mel = $("mult");
    if (m !== r.lastMult) { mel.classList.add("pop"); setTimeout(() => mel.classList.remove("pop"), 130); r.lastMult = m; }
    mel.textContent = "x" + m; mel.classList.toggle("hot", m > 1);
    const left = clamp((g.foodDeadline - g.ticks) / Math.max(1, g.foodWindow), 0, 1);
    $("combobar").firstElementChild.style.width = (g.combo > 0 || m > 1 ? left * 100 : 0) + "%";
    const pips = $("pips");
    if (pips.children.length !== g.P.maxCharges) pips.innerHTML = "<i></i>".repeat(g.P.maxCharges);
    [...pips.children].forEach((el, i) => el.classList.toggle("on", i < g.charges));
    pips.classList.toggle("active", g.phase > 0);
    $("echoes").textContent = g.echoCount();
    $("best").textContent = Math.max(bestScore(), g.score);
    const pb = $("phaseBtn"); pb.disabled = !g.canPhase();
    pb.textContent = g.phase > 0 ? "Phasing…" : "Phase" + (g.charges ? " ×" + g.charges : "");
  }

  // ------------------------------------------------------------------ rendering
  const wrapD = (a, b) => { let d = b - a; if (d > N / 2) d -= N; else if (d < -N / 2) d += N; return d; };
  const lerpWrap = (p, c, a) => ({ x: p.x + wrapD(p.x, c.x) * a, y: p.y + wrapD(p.y, c.y) * a });

  // Turn a list of (possibly wrapped) points into one continuous polyline.
  function unwrapChain(pts) {
    for (let i = 1; i < pts.length; i++) {
      pts[i] = { x: pts[i - 1].x + wrapD(pts[i - 1].x, pts[i].x), y: pts[i - 1].y + wrapD(pts[i - 1].y, pts[i].y) };
    }
    return pts;
  }
  // Draw fn(offsetX, offsetY) once per wrap copy that can touch the board.
  function wrapCopies(pts, draw) {
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const p of pts) { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); }
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const sx = ox * N, sy = oy * N;
      if (maxx + sx < -1 || minx + sx > N + 1 || maxy + sy < -1 || miny + sy > N + 1) continue;
      draw(sx, sy);
    }
  }
  const px = (p, sx) => (p.x + sx + 0.5) * cell;
  const py = (p, sy) => (p.y + sy + 0.5) * cell;

  function snakePoints(run) {
    const g = run.g, a = run.alpha, out = [];
    for (let i = 0; i < g.snake.length; i++) {
      const c = g.snake[i], p = run.prev[i] || c;
      out.push(lerpWrap(p, c, a));
    }
    return unwrapChain(out);
  }

  function echoPolylines(run) {
    const g = run.g, a = run.alpha, end = g.hist.length - 1, out = [];
    g.echoRanges(g.snake.length).forEach(([lo, hi], idx) => {
      const pts = [];
      for (let o = lo; o <= hi; o++) {
        const p0 = g.hist[end - o], p1 = g.hist[end - o + 1];
        if (!p0 || !p1) continue;
        pts.push(lerpWrap(p0, p1, a));
      }
      if (pts.length) out.push({ pts: unwrapChain(pts), idx, dir: g.hist[end - lo] && g.hist[end - lo + 1] ? { x: wrapD(g.hist[end - lo].x, g.hist[end - lo + 1].x), y: wrapD(g.hist[end - lo].y, g.hist[end - lo + 1].y) } : { x: 1, y: 0 }, nextCell: g.hist[end - lo + 1] });
    });
    return out;
  }

  function render(run, ts) {
    const g = run.g, c = pal(), W = cv.width, t = ts / 1000;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.shadowBlur = 0;
    ctx.fillStyle = "#050810"; ctx.fillRect(0, 0, W, W);
    if (fx.shake > 0) ctx.setTransform(1, 0, 0, 1, rand(-1, 1) * fx.shake * cell * 0.5, rand(-1, 1) * fx.shake * cell * 0.5);
    if (fx.punch > 0) { const k = 1 + fx.punch * 0.014; ctx.translate(W / 2, W / 2); ctx.scale(k, k); ctx.translate(-W / 2, -W / 2); }

    // grid
    ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < N; i++) { ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, W); ctx.moveTo(0, i * cell); ctx.lineTo(W, i * cell); }
    ctx.stroke();

    // rings (ripples)
    for (const r of fx.rings) {
      const k = r.t / r.life;
      ctx.strokeStyle = r.color; ctx.globalAlpha = (1 - k) * 0.6; ctx.lineWidth = cell * 0.12 * (1 - k) + 1;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.max * (1 - Math.pow(1 - k, 3)), 0, 6.283); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    drawEchoes(run, t);
    drawFood(run, t);
    if (g.snake.length) drawSnake(run, t);

    if (!g.alive && g.deathAt) drawDeathMark(g.deathAt, t);

    // particles (additive)
    ctx.globalCompositeOperation = "lighter";
    for (const p of fx.parts) { ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.283); ctx.fill(); }
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;

    // floating text
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const f of fx.texts) {
      const k = f.t / f.life;
      ctx.globalAlpha = 1 - k * k; ctx.fillStyle = f.color; ctx.font = "800 " + f.size + "px system-ui, sans-serif";
      ctx.shadowColor = "rgba(0,0,0,.7)"; ctx.shadowBlur = 6;
      ctx.fillText(f.text, f.x, f.y - k * cell * 1.6);
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;

    // danger vignette, phase tint, flash
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (run.danger > 0.02 && g.alive) {
      const pulse = 0.75 + 0.25 * Math.sin(t * 9);
      const gr = ctx.createRadialGradient(W / 2, W / 2, W * 0.35, W / 2, W / 2, W * 0.75);
      gr.addColorStop(0, "rgba(" + c.danger + ",0)"); gr.addColorStop(1, "rgba(" + c.danger + "," + (0.32 * run.danger * pulse) + ")");
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, W);
    }
    if (g.phase > 0 && g.alive) { ctx.fillStyle = "rgba(34,211,238," + (0.06 + 0.04 * Math.sin(t * 20)) + ")"; ctx.fillRect(0, 0, W, W); }
    if (fx.flash > 0) { ctx.fillStyle = "rgba(" + fx.flashColor + "," + fx.flash * 0.5 + ")"; ctx.fillRect(0, 0, W, W); }
  }

  // Marks the cell you crashed into so the loss is legible (what killed me, and where).
  function drawDeathMark(at, t) {
    const c = pal(), p = ec(at.x, at.y), pulse = 0.6 + 0.4 * Math.sin(t * 8), r = cell * 0.55;
    ctx.save(); ctx.translate(p.x, p.y);
    ctx.strokeStyle = "rgb(" + c.danger + ")"; ctx.lineWidth = cell * 0.13; ctx.lineCap = "round"; ctx.globalAlpha = 0.5 + 0.5 * pulse;
    ctx.shadowColor = "rgb(" + c.danger + ")"; ctx.shadowBlur = cell * 0.8;
    ctx.beginPath(); ctx.arc(0, 0, r * (1.1 + 0.15 * pulse), 0, 6.283); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.5); ctx.lineTo(r * 0.5, r * 0.5); ctx.moveTo(r * 0.5, -r * 0.5); ctx.lineTo(-r * 0.5, r * 0.5); ctx.stroke();
    ctx.restore();
  }

  function drawEchoes(run, t) {
    const g = run.g, c = pal(), lines = echoPolylines(run);
    if (!lines.length) return;
    const armed = g.echoArmed(), k = armed ? 1 : 0.38;      // dormant echoes are dim and dotted
    // faint memory of the whole path, so the gaps read as "the same trail, currently harmless"
    const end = g.hist.length - 1, L = g.snake.length, ranges = g.echoRanges(L);
    const lastHi = ranges[ranges.length - 1][1];
    const mem = [];
    for (let o = L; o <= lastHi; o++) { const p = g.hist[end - o]; if (p) mem.push({ x: p.x, y: p.y }); }
    if (mem.length > 1) {
      unwrapChain(mem);
      ctx.strokeStyle = c.echo; ctx.globalAlpha = 0.09; ctx.lineWidth = cell * 0.14; ctx.lineCap = "round"; ctx.lineJoin = "round";
      wrapCopies(mem, (sx, sy) => { ctx.beginPath(); mem.forEach((p, i) => (i ? ctx.lineTo(px(p, sx), py(p, sy)) : ctx.moveTo(px(p, sx), py(p, sy)))); ctx.stroke(); });
    }
    for (const L2 of lines) {
      const pts = L2.pts;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      // body of the echo: glowing dashed ribbon
      ctx.shadowColor = c.echo; ctx.shadowBlur = cell * 0.7;
      ctx.strokeStyle = c.echo; ctx.globalAlpha = 0.5 * k; ctx.lineWidth = cell * (armed ? 0.5 : 0.3);
      ctx.setLineDash(armed ? [cell * 0.55, cell * 0.3] : [cell * 0.12, cell * 0.4]); ctx.lineDashOffset = -t * cell * 1.5;
      wrapCopies(pts, (sx, sy) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(px(p, sx), py(p, sy)) : ctx.moveTo(px(p, sx), py(p, sy)))); ctx.stroke(); });
      ctx.setLineDash([]); ctx.shadowBlur = 0;
      // leading edge (the deadly end): bright chevron pointing along its motion
      const h = pts[0], d = L2.dir, ang = Math.atan2(d.y, d.x);
      wrapCopies(pts, (sx, sy) => {
        ctx.save(); ctx.translate(px(h, sx), py(h, sy)); ctx.rotate(ang);
        ctx.globalAlpha = 0.95 * k; ctx.fillStyle = "#fff"; ctx.shadowColor = c.echo; ctx.shadowBlur = cell * 0.9;
        ctx.beginPath(); ctx.moveTo(cell * 0.38, 0); ctx.lineTo(-cell * 0.2, cell * 0.3); ctx.lineTo(-cell * 0.05, 0); ctx.lineTo(-cell * 0.2, -cell * 0.3); ctx.closePath(); ctx.fill();
        ctx.restore();
      });
      ctx.shadowBlur = 0;
      // the cell it enters next: pulsing warning square
      if (L2.nextCell && g.alive && armed) {
        const nx = L2.nextCell, pulse = 0.35 + 0.25 * Math.sin(t * 10);
        ctx.strokeStyle = c.echo; ctx.globalAlpha = pulse; ctx.lineWidth = 2;
        const s2 = cell * 0.86;
        ctx.strokeRect((nx.x + 0.5) * cell - s2 / 2, (nx.y + 0.5) * cell - s2 / 2, s2, s2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawFood(run, t) {
    const g = run.g, c = pal();
    if (g.food) {
      const born = clamp((app.time - run.foodBorn) / 220, 0, 1), sc = born < 1 ? 0.3 + 0.7 * (1 - Math.pow(1 - born, 3)) : 1;
      const f = ec(g.food.x, g.food.y), r = cell * (0.27 + 0.035 * Math.sin(t * 6)) * sc;
      ctx.shadowColor = c.food; ctx.shadowBlur = cell * 0.9; ctx.fillStyle = c.food;
      ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.beginPath(); ctx.arc(f.x - r * 0.3, f.y - r * 0.3, r * 0.28, 0, 6.283); ctx.fill();
    }
    if (g.golden) {
      const q = ec(g.golden.x, g.golden.y), life = clamp((g.golden.expires - g.ticks) / run.goldLife, 0, 1);
      const spin = t * 2.2, r = cell * 0.36, blink = life < 0.3 ? (Math.sin(t * 22) > 0 ? 1 : 0.35) : 1;
      ctx.save(); ctx.translate(q.x, q.y); ctx.globalAlpha = blink;
      ctx.shadowColor = c.gold; ctx.shadowBlur = cell * 1.2; ctx.fillStyle = c.gold;
      ctx.rotate(spin);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4, rr = i % 2 ? r * 0.45 : r * 1.15; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill(); ctx.restore();
      ctx.shadowBlur = 0; ctx.strokeStyle = c.gold; ctx.globalAlpha = 0.7 * blink; ctx.lineWidth = cell * 0.1; ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(q.x, q.y, cell * 0.62, -Math.PI / 2, -Math.PI / 2 + life * 6.283); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawSnake(run, t) {
    const g = run.g, c = pal(), pts = snakePoints(run), n = pts.length, phasing = g.phase > 0;
    const dead = !g.alive;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha = dead ? 0.35 : phasing ? 0.55 : 1;
    // glow pass
    ctx.shadowColor = c.snake; ctx.shadowBlur = dead ? 0 : cell * 0.55;
    wrapCopies(pts, (sx, sy) => {
      for (let i = n - 1; i > 0; i--) {
        const k = i / n;
        ctx.strokeStyle = mix(c.snake, "#0b3d2a", k * 0.55);
        ctx.lineWidth = cell * (0.78 - 0.24 * k);
        ctx.beginPath(); ctx.moveTo(px(pts[i], sx), py(pts[i], sy)); ctx.lineTo(px(pts[i - 1], sx), py(pts[i - 1], sy)); ctx.stroke();
      }
    });
    ctx.shadowBlur = 0;
    // highlight stripe
    ctx.globalAlpha *= 0.5; ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = cell * 0.16;
    wrapCopies(pts, (sx, sy) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(px(p, sx) - cell * 0.08, py(p, sy) - cell * 0.1) : ctx.moveTo(px(p, sx) - cell * 0.08, py(p, sy) - cell * 0.1))); ctx.stroke(); });
    ctx.globalAlpha = dead ? 0.35 : phasing ? 0.7 : 1;
    // head + eyes
    const h = pts[0], d = g.dir, ang = Math.atan2(d.y, d.x);
    wrapCopies(pts, (sx, sy) => {
      ctx.save(); ctx.translate(px(h, sx), py(h, sy)); ctx.rotate(ang);
      ctx.fillStyle = c.head; ctx.shadowColor = c.snake; ctx.shadowBlur = dead ? 0 : cell * 0.5;
      ctx.beginPath(); ctx.arc(0, 0, cell * 0.44, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = "#06121a";
      let lookX = 0, lookY = 0;
      if (g.food) { const dx = wrapD(h.x, g.food.x), dy = wrapD(h.y, g.food.y), m = Math.hypot(dx, dy) || 1; const ca = Math.cos(-ang), sa = Math.sin(-ang); lookX = (dx / m * ca - dy / m * sa) * cell * 0.05; lookY = (dx / m * sa + dy / m * ca) * cell * 0.05; }
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.arc(cell * 0.14, s * cell * 0.2, cell * 0.11, 0, 6.283); ctx.fillStyle = "#fff"; ctx.fill();
        ctx.beginPath(); ctx.arc(cell * 0.14 + lookX, s * cell * 0.2 + lookY, cell * 0.06, 0, 6.283); ctx.fillStyle = dead ? "#ef4444" : "#06121a"; ctx.fill();
      }
      ctx.restore();
    });
    if (phasing) {                                         // shimmering outline while phasing
      ctx.globalAlpha = 0.8; ctx.strokeStyle = c.echo; ctx.lineWidth = 2; ctx.setLineDash([cell * 0.3, cell * 0.2]); ctx.lineDashOffset = -t * cell * 3;
      wrapCopies(pts, (sx, sy) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(px(p, sx), py(p, sy)) : ctx.moveTo(px(p, sx), py(p, sy)))); ctx.stroke(); });
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  function mix(a, b, k) {
    const pa = parse(a), pb = parse(b);
    return "rgb(" + [0, 1, 2].map(i => Math.round(pa[i] + (pb[i] - pa[i]) * k)).join(",") + ")";
  }
  function parse(hex) { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }

  // ------------------------------------------------------------------ input
  const KEYS = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
  const playing = () => app.screen === "playing" && !app.paused && app.run && app.run.g.alive;

  addEventListener("keydown", e => {
    audio.unlock();
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (app.screen === "playing") {
      if (KEYS[k]) { if (playing()) app.run.g.turn(...KEYS[k]); e.preventDefault(); return; }
      if (k === " ") { if (playing()) app.run.g.phaseShift() && handleEvents(app.run, true); e.preventDefault(); return; }
      if (k === "p" || k === "Escape") { pause(true); return; }
      if (k === "r") { startGame(); return; }
    } else if (app.screen === "pause") {
      if (k === "p" || k === "Escape") { pause(false); return; }
      if (k === "r") { startGame(); return; }
    } else if ((app.screen === "how" || app.screen === "settings") && k === "Escape") { setScreen(app.back === "pause" ? "pause" : "title"); return; }
    else if (app.screen === "over" && k === "r") { startGame(); return; }
    if (k === "m") { const on = !(settings.sfx || settings.music); setSetting("sfx", on); setSetting("music", on); toast(on ? "Sound on" : "Muted", 1200); }
  });

  // swipe steering
  let t0 = null;
  const stage = cv;
  stage.addEventListener("touchstart", e => { audio.unlock(); t0 = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY }; }, { passive: true });
  stage.addEventListener("touchmove", e => {
    if (!t0 || !playing()) return;
    const t = e.changedTouches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
    if (Math.abs(dx) > Math.abs(dy)) app.run.g.turn(dx > 0 ? 1 : -1, 0); else app.run.g.turn(0, dy > 0 ? 1 : -1);
    t0 = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  stage.addEventListener("touchend", () => { t0 = null; }, { passive: true });

  $("phaseBtn").addEventListener("click", () => { audio.unlock(); if (playing() && app.run.g.phaseShift()) handleEvents(app.run, true); });

  // buttons
  const click = (id, fn) => $(id).addEventListener("click", () => { audio.unlock(); audio.sfx.click(); fn(); });
  click("b-play", () => startGame("endless"));
  click("b-daily", () => startGame("daily"));
  click("b-how", () => { app.back = "title"; setScreen("how"); });
  click("b-settings", () => { app.back = "title"; setScreen("settings"); });
  click("b-resume", () => pause(false));
  click("b-restart", () => startGame());
  click("b-psettings", () => { app.back = "pause"; setScreen("settings"); });
  click("b-quit", () => { app.paused = false; app.run = null; app.back = "title"; setScreen("title"); });
  click("b-again", () => startGame());
  click("b-menu", () => { app.back = "title"; setScreen("title"); });
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => { audio.sfx.click(); setScreen(app.back === "pause" ? "pause" : "title"); }));
  click("b-share", () => {
    const g = app.run.g;
    const text = "Echo Snake" + (app.mode === "daily" ? " Daily " + dailySeed() : "") + "\n" + g.score + " pts · " + rankFor(g.score) + "\n" + g.foods + " foods · " + g.stats.grazes + " grazes · " + g.stats.goldens + " gold";
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("Result copied"), () => toast(text.replace(/\n/g, "<br>"), 6000));
  });

  function setSetting(k, v) {
    settings[k] = v; store.set(k, v);
    document.querySelectorAll('[data-setting="' + k + '"]').forEach(el => el.setAttribute("aria-checked", String(!!v)));
    if (k === "cb") applyPalette();
    applyAudio();
  }
  function applyAudio() { audio.setSfx(settings.sfx); audio.setMusic(settings.music); }
  document.querySelectorAll("[data-setting]").forEach(el => el.addEventListener("click", () => setSetting(el.dataset.setting, !settings[el.dataset.setting])));

  // gamepad: d-pad or left stick steers, A phases (or confirms on menus), Start pauses
  const pad = { held: {} };
  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find(p => p && p.connected);
    if (!gp) return;
    const b = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    const now = { up: b(12) || ay < -0.6, down: b(13) || ay > 0.6, left: b(14) || ax < -0.6, right: b(15) || ax > 0.6, a: b(0), start: b(9) };
    const edge = k => now[k] && !pad.held[k];
    if (Object.values(now).some(Boolean)) audio.unlock();
    if (playing()) {
      if (edge("up")) app.run.g.turn(0, -1); if (edge("down")) app.run.g.turn(0, 1);
      if (edge("left")) app.run.g.turn(-1, 0); if (edge("right")) app.run.g.turn(1, 0);
      if (edge("a") && app.run.g.phaseShift()) handleEvents(app.run, true);
    } else if (edge("a") && (app.screen === "title" || app.screen === "over")) startGame(app.screen === "over" ? undefined : "endless");
    if (edge("start")) { if (app.screen === "playing") pause(true); else if (app.screen === "pause") pause(false); }
    pad.held = now;
  }

  // pause when the tab is hidden
  document.addEventListener("visibilitychange", () => { if (document.hidden && app.screen === "playing") pause(true); });
  addEventListener("blur", () => { if (app.screen === "playing") pause(true); });

  // ------------------------------------------------------------------ boot
  for (const k of Object.keys(settings)) document.querySelectorAll('[data-setting="' + k + '"]').forEach(el => el.setAttribute("aria-checked", String(!!settings[k])));
  applyPalette(); applyAudio(); resize(); newDemo(); setScreen("title");
  requestAnimationFrame(frame);

  // test/debug hooks
  window.__echo = { audio, app, settings, store, fx, startGame, pause, run: () => app.run, view, render, doTick, advance, handleEvents, showOver, setScreen, rankFor, pal };
})();
