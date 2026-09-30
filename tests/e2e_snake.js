// Headless-browser playtest of the real page (snake/index.html).
// Run: NODE_PATH=$(npm root -g) node tests/e2e_snake.js
const { chromium } = require("playwright");
const path = require("path");
const assert = require("assert");

const URL = "file://" + path.resolve(__dirname, "..", "snake", "index.html");
const results = [];
async function t(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(["ok", name]); console.log("  ok  ", name, `(${Date.now() - t0}ms)`); }
  catch (e) { results.push(["FAIL", name + ": " + e.message.split("\n")[0]]); console.log(" FAIL ", name, "::", e.message.split("\n")[0]); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"],
  });
  const errors = [];
  async function open(opts = {}) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 760, height: 900 } }, opts));
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => m.type() === "error" && errors.push(m.text()));
    await page.goto(URL);
    await page.waitForFunction(() => window.__echo);
    return { ctx, page };
  }
  const E = (page, fn, arg) => page.evaluate(fn, arg);
  // Stop real-time ticking so tests advance the game deterministically.
  const freeze = page => E(page, () => { const g = window.__echo.run().g; g.P.baseMs = g.P.minMs = 1e9; });
  const tick = (page, n = 1) => E(page, n => { const e = window.__echo; for (let i = 0; i < n; i++) e.doTick(e.run(), true); }, n);
  const screen = page => E(page, () => window.__echo.app.screen);

  let { ctx, page } = await open();

  await t("title screen shows and the attract-mode demo plays by itself", async () => {
    assert.strictEqual(await screen(page), "title");
    assert.ok(await page.isVisible("#ov-title"));
    const a = await E(page, () => window.__echo.app.demo.g.ticks);
    await page.waitForTimeout(900);
    const b = await E(page, () => window.__echo.app.demo.g.ticks);
    assert.ok(b > a, `demo ticks ${a} -> ${b}`);
  });

  await t("canvas actually draws (not blank) and HUD is present", async () => {
    const lit = await E(page, () => {
      const c = document.getElementById("cv"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4 * 37) if (d[i] + d[i + 1] + d[i + 2] > 120) n++;
      return n;
    });
    assert.ok(lit > 20, "bright pixels: " + lit);
  });

  await t("Play starts a game; arrow keys steer; reverse is ignored", async () => {
    await page.click("#b-play");
    assert.strictEqual(await screen(page), "playing");
    await freeze(page);
    await page.keyboard.press("ArrowUp");
    await tick(page);
    assert.deepStrictEqual(await E(page, () => window.__echo.run().g.dir), { x: 0, y: -1 });
    await page.keyboard.press("ArrowDown");             // reverse of up: must be ignored
    await tick(page);
    assert.deepStrictEqual(await E(page, () => window.__echo.run().g.dir), { x: 0, y: -1 });
    await page.keyboard.press("a");                     // WASD works
    await tick(page);
    assert.deepStrictEqual(await E(page, () => window.__echo.run().g.dir), { x: -1, y: 0 });
  });

  await t("Space spends a phase charge and the HUD reflects it", async () => {
    await freeze(page);
    const before = await E(page, () => window.__echo.run().g.charges);
    await page.keyboard.press(" ");
    const after = await E(page, () => ({ c: window.__echo.run().g.charges, ph: window.__echo.run().g.phase }));
    assert.strictEqual(after.c, before - 1);
    assert.ok(after.ph > 0);
    await page.waitForTimeout(80);
    assert.strictEqual(await page.locator("#pips.active").count(), 1);
  });

  await t("eating updates score, combo multiplier and HUD text", async () => {
    await E(page, () => { window.__echo.startGame("endless"); });
    await freeze(page);
    await E(page, () => { const g = window.__echo.run().g; g.food = { x: g.snake[0].x + 1, y: g.snake[0].y }; });
    await tick(page);
    await page.waitForTimeout(400);
    assert.ok(+(await page.textContent("#score")) >= 10);
    assert.match(await page.textContent("#mult"), /^x\d$/);
  });

  await t("dying draws a marker on the fatal cell, and the tab title tracks the score", async () => {
    await E(page, () => window.__echo.startGame("endless"));
    await freeze(page);
    await E(page, () => { const e = window.__echo, r = e.run(), g = r.g;
      g.snake = [{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5},{x:6,y:4},{x:5,y:4},{x:4,y:4}]; g.dir = {x:0,y:-1}; g.queue = []; g.food = {x:0,y:0};
      g.score = 120; g.P.baseMs = 1e9; e.doTick(r, true); });
    assert.deepStrictEqual(await E(page, () => window.__echo.run().g.deathAt), { x: 5, y: 4 });
    await page.waitForTimeout(120);
    const red = await E(page, () => {      // reddish pixels near the fatal cell (5,4)
      const c = document.getElementById("cv"), n = c.width / 20, ctx = c.getContext("2d");
      const d = ctx.getImageData(Math.round(5 * n), Math.round(4 * n), Math.round(n), Math.round(n)).data;
      let r = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i] > d[i + 1] * 1.6 && d[i] > d[i + 2] * 1.1) r++;
      return r;
    });
    assert.ok(red > 15, "red marker pixels: " + red);
    assert.match(await page.title(), /^Echo Snake/);
  });

  await t("the echo arms on the grace-th food with an ECHO ARMED banner", async () => {
    await E(page, () => window.__echo.startGame("endless"));
    await freeze(page);
    await E(page, () => { const e = window.__echo, r = e.run(), g = r.g; g.foods = g.P.graceFoods - 1;
      g.food = { x: g.snake[0].x + 1, y: g.snake[0].y }; e.doTick(r, true); });
    await page.waitForTimeout(100);
    assert.match(await page.textContent("#banner"), /ECHO ARMED/);
    assert.strictEqual(await E(page, () => window.__echo.run().g.echoArmed()), true);
  });

  await t("audio: SFX really produce sound (measured on the master bus)", async () => {
    await E(page, () => window.__echo.startGame("endless"));       // click-free start still needs a gesture
    await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Shift");                            // user gesture unlocks WebAudio
    const r = await E(page, async () => {
      const a = window.__echo.audio;
      if (!a.ready) return { skipped: true };
      const an = a.tap(); const buf = new Float32Array(an.fftSize);
      window.__echo.settings.sfx = true; a.setSfx(true);
      let peak = 0;
      a.sfx.eat(0); a.sfx.golden(); a.sfx.phase();
      for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 25)); an.getFloatTimeDomainData(buf); peak = Math.max(peak, ...buf.map(Math.abs)); }
      for (const k of Object.keys(a.sfx)) a.sfx[k](1);              // every effect runs without throwing
      return { peak };
    });
    if (!r.skipped) assert.ok(r.peak > 0.005, "peak amplitude " + r.peak);
  });

  await t("gamepad: d-pad steers, A phases, Start pauses", async () => {
    await E(page, () => window.__echo.startGame("endless"));
    await freeze(page);
    await E(page, () => {
      window.__pad = { connected: true, axes: [0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
      navigator.getGamepads = () => [window.__pad];
      window.__echo.run().g.dir = { x: 1, y: 0 };
    });
    await E(page, () => { window.__pad.buttons[12].pressed = true; });     // d-pad up
    await page.waitForTimeout(80);
    await tick(page);
    assert.deepStrictEqual(await E(page, () => window.__echo.run().g.dir), { x: 0, y: -1 });
    await E(page, () => { window.__pad.buttons[12].pressed = false; window.__pad.buttons[0].pressed = true; });  // A
    await page.waitForTimeout(80);
    assert.ok(await E(page, () => window.__echo.run().g.phase) > 0);
    await E(page, () => { window.__pad.buttons[0].pressed = false; window.__pad.buttons[9].pressed = true; });   // Start
    await page.waitForTimeout(80);
    assert.strictEqual(await screen(page), "pause");
    await E(page, () => { window.__pad.buttons[9].pressed = false; });
    await page.waitForTimeout(60);
    await E(page, () => { window.__pad.buttons[9].pressed = true; });
    await page.waitForTimeout(80);
    assert.strictEqual(await screen(page), "playing");
    await E(page, () => { delete navigator.getGamepads; });
  });

  await t("pause with P freezes the game, Resume continues, Settings reachable from pause", async () => {
    await page.keyboard.press("p");
    assert.strictEqual(await screen(page), "pause");
    const t1 = await E(page, () => window.__echo.run().g.ticks);
    await page.waitForTimeout(300);
    assert.strictEqual(await E(page, () => window.__echo.run().g.ticks), t1);
    await page.click("#b-psettings");
    assert.strictEqual(await screen(page), "settings");
    await page.click("#ov-settings [data-close]");
    assert.strictEqual(await screen(page), "pause");
    await page.click("#b-resume");
    assert.strictEqual(await screen(page), "playing");
  });

  await t("R restarts with a fresh game", async () => {
    await freeze(page);
    await tick(page, 3);
    await page.keyboard.press("r");
    await freeze(page);
    assert.strictEqual(await E(page, () => window.__echo.run().g.ticks), 0);
    assert.strictEqual(await E(page, () => window.__echo.run().g.score), 0);
  });

  await t("dying shows the game-over screen with rank, stats and NEW BEST; best persists", async () => {
    await E(page, () => { window.__echo.store.set("best.endless", 0); window.__echo.startGame("endless"); });
    await freeze(page);
    await E(page, () => { const g = window.__echo.run().g; g.food = { x: g.snake[0].x + 1, y: g.snake[0].y }; });
    await tick(page);                                   // score some points
    // curl the snake into itself: 7 cells in a hook shape, head steps into a non-tail body cell
    await E(page, () => { const e = window.__echo, r = e.run(), g = r.g;
      g.snake = [{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5},{x:6,y:4},{x:5,y:4},{x:4,y:4}]; g.dir = {x:0,y:-1}; g.queue = []; g.food = {x:0,y:0};
      e.doTick(r, true); });
    await page.waitForSelector("#ov-over.show", { timeout: 4000 });
    assert.ok(+(await page.textContent("#o-score")) >= 10);
    assert.ok((await page.textContent("#o-rank")).length > 2);
    assert.strictEqual(await page.textContent("#o-cause"), "Self");
    assert.strictEqual(await page.textContent("#o-new"), "NEW BEST");
    assert.ok(await E(page, () => window.__echo.store.get("best.endless", 0)) >= 10);
  });

  await t("Play again works with Enter (button is focused)", async () => {
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__echo.app.screen === "playing");
    assert.strictEqual(await E(page, () => window.__echo.run().g.alive), true);
  });

  await t("settings toggle, persist across reload, and colorblind palette recolors the UI", async () => {
    await page.reload(); await page.waitForFunction(() => window.__echo);
    await page.click("#b-settings");
    await page.click('[data-setting="cb"]');
    await page.click('[data-setting="music"]');
    assert.strictEqual(await page.getAttribute('[data-setting="cb"]', "aria-checked"), "true");
    assert.strictEqual((await E(page, () => getComputedStyle(document.documentElement).getPropertyValue("--accent"))).trim(), "#4da3ff");
    await page.reload(); await page.waitForFunction(() => window.__echo);
    assert.strictEqual(await E(page, () => window.__echo.settings.cb), true);
    assert.strictEqual(await E(page, () => window.__echo.settings.music), false);
    await E(page, () => { window.__echo.store.set("cb", false); window.__echo.store.set("music", true); });
  });

  await t("daily challenge is seeded: two starts spawn the same first food", async () => {
    await page.reload(); await page.waitForFunction(() => window.__echo);
    const a = await E(page, () => { window.__echo.startGame("daily"); const g = window.__echo.run().g; return [g.food, g.P.N]; });
    const b = await E(page, () => { window.__echo.startGame("daily"); const g = window.__echo.run().g; return [g.food, g.P.N]; });
    assert.deepStrictEqual(a, b);
    assert.strictEqual(await E(page, () => window.__echo.app.mode), "daily");
  });

  await t("rendering a late-game board (80 long, 3 echoes) stays fast", async () => {
    await E(page, () => window.__echo.startGame("endless"));
    await freeze(page);
    const ms = await E(page, () => {
      const e = window.__echo, bot = EchoBots.makeBot({ depth: 25 });
      let r, g;
      for (let attempt = 0; attempt < 12; attempt++) {           // a bot can die early by bad luck: retry
        e.startGame("endless"); r = e.run(); g = r.g;
        let n = 0; while (g.alive && g.foods < 30 && n++ < 3000) { const d = bot(g); if (d.phase) g.phaseShift(); else if (d.dir) g.turn(...d.dir); r.prev = g.snake.map(p => ({ ...p })); g.step(); }
        if (g.foods >= 20) break;
      }
      const T = performance.now(); for (let i = 0; i < 60; i++) { r.alpha = i / 60; e.render(r, i * 16); }
      return { per: (performance.now() - T) / 60, foods: g.foods, echoes: g.echoCount(), len: g.snake.length };
    });
    assert.ok(ms.foods >= 20, "bot reached " + ms.foods);
    assert.ok(ms.per < 10, `render ${ms.per.toFixed(2)}ms/frame`);
  });

  await ctx.close();

  // ---- phone: touch, layout, swipe -------------------------------------------------
  ({ ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }));

  await t("phone layout: no horizontal scroll, board fits, phase button shown", async () => {
    await page.tap("#b-play");
    await page.waitForFunction(() => window.__echo.app.screen === "playing");
    const m = await E(page, () => {
      const r = document.getElementById("stage").getBoundingClientRect(), b = document.getElementById("phaseBtn").getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, right: r.right, left: r.left, bottom: b.bottom, ih: innerHeight, btn: getComputedStyle(document.getElementById("phaseBtn")).display };
    });
    assert.ok(m.sw <= m.cw + 1, `scrollWidth ${m.sw} > ${m.cw}`);
    assert.ok(m.left >= 0 && m.right <= m.cw, "stage within viewport");
    assert.strictEqual(m.btn, "block");
    assert.ok(m.bottom <= m.ih + 1, "phase button on screen");
  });

  await t("swipe steers the snake and the on-screen button phases", async () => {
    await freeze(page);
    await E(page, () => { window.__echo.run().g.dir = { x: 1, y: 0 }; });
    const box = await page.locator("#stage").boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const swipe = (dx, dy) => page.evaluate(([x, y, dx, dy]) => {
      const st = document.getElementById("cv");
      const mk = (type, X, Y) => st.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, changedTouches: [new Touch({ identifier: 1, target: st, clientX: X, clientY: Y })] }));
      mk("touchstart", x, y); mk("touchmove", x + dx, y + dy); mk("touchend", x + dx, y + dy);
    }, [cx, cy, dx, dy]);
    await swipe(0, -60);
    await tick(page);
    assert.deepStrictEqual(await E(page, () => window.__echo.run().g.dir), { x: 0, y: -1 });
    const c0 = await E(page, () => window.__echo.run().g.charges);
    await page.tap("#phaseBtn");
    assert.strictEqual(await E(page, () => window.__echo.run().g.charges), c0 - 1);
  });

  await ctx.close();

  // ---- landscape phone -------------------------------------------------------------
  ({ ctx, page } = await open({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }));
  await t("landscape phone: board fits the height and does not overlap the Phase button", async () => {
    await page.tap("#b-play");
    await page.waitForFunction(() => window.__echo.app.screen === "playing");
    const m = await E(page, () => {
      const r = document.getElementById("stage").getBoundingClientRect(), b = document.getElementById("phaseBtn").getBoundingClientRect();
      return { r: { l: r.left, t: r.top, r: r.right, b: r.bottom }, b: { l: b.left, t: b.top, r: b.right, b: b.bottom }, ih: innerHeight, iw: innerWidth, side: r.width };
    });
    assert.ok(m.r.t >= 0 && m.r.b <= m.ih, `board vertical fit ${m.r.t}..${m.r.b} of ${m.ih}`);
    assert.ok(m.side >= 250, "board side " + m.side);
    assert.ok(m.b.r <= m.iw && m.b.b <= m.ih, "button on screen");
    const overlap = !(m.b.r <= m.r.l || m.b.l >= m.r.r || m.b.b <= m.r.t || m.b.t >= m.r.b);
    assert.ok(!overlap, "phase button overlaps the board");
  });
  await ctx.close();

  await t("no JS errors or console errors during any of the above", async () => {
    assert.deepStrictEqual(errors, []);
  });

  // screenshot for the record
  ({ ctx, page } = await open());
  await page.waitForTimeout(600);
  await page.screenshot({ path: process.env.SHOT || "/tmp/snake.png" });
  await ctx.close();
  await browser.close();

  let failed = 0;
  for (const [s, m] of results) { console.log(s === "ok" ? "  ok  " : " FAIL ", m); failed += s !== "ok"; }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
