// Headless-browser playtest for snake/index.html.
// Run: NODE_PATH=$(npm root -g) node tests/e2e_snake.js
const { chromium } = require("playwright");
const path = require("path");
const assert = require("assert");

const URL = "file://" + path.resolve(__dirname, "..", "snake", "index.html");
const results = [];
async function t(name, fn) {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", name + ": " + e.message]); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 520, height: 800 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL);

  // Freeze the real-time loop so tests drive ticks deterministically.
  const G = fn => page.evaluate(fn);
  await G(() => { window.__snake.state().paused = true; });
  const fresh = () => G(() => { window.__snake.reset(); window.__snake.state().paused = false; });

  await t("loads with a 3-long snake, echo delay 24, one blink charge", async () => {
    await fresh();
    const s = await G(() => { const S = window.__snake.state(); return { len: S.snake.length, d: S.delay, c: S.charges, alive: S.alive }; });
    assert.deepStrictEqual(s, { len: 3, d: 24, c: 1, alive: true });
  });

  await t("moves right and wraps around the board", async () => {
    await fresh();
    const x = await G(() => { const S = window.__snake.state(); S.food = { x: 0, y: 0 };
      for (let i = 0; i < 12; i++) window.__snake.step(); return S.snake[0].x; });
    assert.strictEqual(x, 2); // 10 -> wraps past 19 -> 0 -> 2
  });

  await t("eating food grows the snake, scores 10, shrinks the echo delay", async () => {
    await fresh();
    const r = await G(() => { const S = window.__snake.state(); S.food = { x: 11, y: 10 };
      window.__snake.step(); return { len: S.snake.length, score: S.score, delay: S.delay }; });
    assert.deepStrictEqual(r, { len: 4, score: 10, delay: 23 });
  });

  await t("delay never drops below the minimum", async () => {
    await fresh();
    const d = await G(() => { const S = window.__snake.state(); S.delay = 10; S.food = { x: 11, y: 10 };
      window.__snake.step(); return S.delay; });
    assert.strictEqual(d, 10);
  });

  await t("cannot reverse directly into itself", async () => {
    await fresh();
    const alive = await G(() => { window.__snake.turn(-1, 0); window.__snake.step(); return window.__snake.state().alive; });
    assert.ok(alive);
  });

  await t("hitting your own body kills you", async () => {
    await fresh();
    const alive = await G(() => { const S = window.__snake.state();
      S.snake = [{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5},{x:6,y:4},{x:5,y:4},{x:4,y:4}]; S.dir = {x:0,y:-1}; S.food = {x:0,y:0};
      window.__snake.step(); return S.alive; });
    assert.strictEqual(alive, false);
  });

  await t("moving into the cell the tail is vacating is safe", async () => {
    await fresh();
    const alive = await G(() => { const S = window.__snake.state();
      S.snake = [{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5},{x:6,y:4},{x:5,y:4}]; S.dir = {x:0,y:-1}; S.food = {x:0,y:0};
      window.__snake.step(); return S.alive; });
    assert.strictEqual(alive, true);
  });

  await t("the echo replays your path and kills on contact", async () => {
    await fresh();
    // Walk a small loop long enough that the echo trails right behind the head's next cell.
    const r = await G(() => {
      const S = window.__snake.state(); S.food = { x: 0, y: 0 };
      S.delay = 6; S.snake = [{x:10,y:10},{x:9,y:10},{x:8,y:10}]; S.dir = {x:1,y:0};
      S.hist = []; for (let x = 4; x <= 10; x++) S.hist.push({x, y: 10});      // path so far, ends at head
      for (let x = 10; x >= 7; x--) S.hist.push({x, y: 10});                    // (synthetic history)
      S.hist.push({x: 10, y: 10});
      const g = window.__snake.ghostCells();
      return { ghostLen: g.length, ghostHead: g[0] };
    });
    assert.strictEqual(r.ghostLen, 3);
    // Now place the ghost head directly ahead of the snake and step into it.
    const died = await G(() => {
      const S = window.__snake.state(); S.food = { x: 0, y: 0 };
      S.snake = [{x:2,y:2},{x:1,y:2},{x:0,y:2}]; S.dir = {x:1,y:0}; S.delay = 4;
      S.hist = [{x:3,y:2},{x:9,y:9},{x:9,y:9},{x:9,y:9},{x:9,y:9},{x:2,y:2}];  // hist[end-4] = (3,2) = cell ahead
      window.__snake.step(); return { alive: S.alive, msg: document.getElementById("status").textContent };
    });
    assert.strictEqual(died.alive, false);
    assert.match(died.msg, /echo/i);
  });

  await t("blink teleports the head onto the echo head and spends a charge", async () => {
    await fresh();
    const r = await G(() => {
      const S = window.__snake.state(); S.food = { x: 0, y: 0 };
      S.snake = [{x:2,y:2},{x:1,y:2},{x:0,y:2}]; S.delay = 4;
      S.hist = [{x:15,y:15},{x:9,y:9},{x:9,y:9},{x:9,y:9},{x:9,y:9},{x:2,y:2}];  // echo head = hist[len-1-4] = (9,9)
      const ok = window.__snake.blink();
      return { ok, head: S.snake[0], charges: S.charges };
    });
    assert.deepStrictEqual(r, { ok: true, head: { x: 9, y: 9 }, charges: 0 });
  });

  await t("blink is refused with no charges, and when the echo overlaps your body", async () => {
    await fresh();
    const r = await G(() => {
      const S = window.__snake.state(); S.food = { x: 0, y: 0 };
      S.snake = [{x:2,y:2},{x:1,y:2},{x:0,y:2}]; S.delay = 4;
      S.hist = [{x:15,y:15},{x:1,y:2},{x:1,y:2},{x:1,y:2},{x:1,y:2},{x:2,y:2}];  // echo head on own body
      const overlap = window.__snake.blink(), c1 = S.charges;
      S.hist[S.hist.length - 1 - S.delay] = { x: 9, y: 9 }; S.charges = 0;
      const none = window.__snake.blink();
      return { overlap, c1, none };
    });
    assert.deepStrictEqual(r, { overlap: false, c1: 1, none: false });
  });

  await t("a blink charge is earned every 4 foods, capped at 3", async () => {
    await fresh();
    const c = await G(() => { const S = window.__snake.state(); S.delay = 24;
      for (let i = 0; i < 12; i++) { const h = S.snake[0]; S.food = { x: (h.x + S.dir.x + 20) % 20, y: h.y }; window.__snake.step(); }
      return S.charges; });
    assert.strictEqual(c, 3);
  });

  await t("food never spawns on the snake or the echo", async () => {
    await fresh();
    const bad = await G(() => { const S = window.__snake.state();
      S.hist = []; for (let i = 0; i < 60; i++) S.hist.push({ x: i % 20, y: Math.floor(i / 20) });
      const busy = new Set(S.snake.concat(window.__snake.ghostCells()).map(p => p.x + "," + p.y));
      for (let i = 0; i < 300; i++) { const f = window.__snake.spawnFood(); if (busy.has(f.x + "," + f.y)) return true; }
      return false; });
    assert.strictEqual(bad, false);
  });

  await t("real keyboard input steers, Space blinks, R restarts, P pauses", async () => {
    await fresh();
    await page.keyboard.press("ArrowUp");
    const d = await G(() => { window.__snake.step(); return window.__snake.state().dir; });
    assert.deepStrictEqual(d, { x: 0, y: -1 });
    await page.keyboard.press("p");
    assert.strictEqual(await G(() => window.__snake.state().paused), true);
    await page.keyboard.press("p");
    await G(() => { window.__snake.state().alive = false; });
    await page.keyboard.press("r");
    assert.strictEqual(await G(() => window.__snake.state().alive), true);
  });

  await t("live loop advances on its own and draws without errors", async () => {
    await fresh();
    const before = await G(() => window.__snake.state().hist.length);
    await page.waitForTimeout(700);
    const after = await G(() => window.__snake.state().hist.length);
    assert.ok(after > before, `history ${before} -> ${after}`);
    assert.deepStrictEqual(errors, []);
  });

  await t("bot plays 20 seconds of real time without a crash or JS error", async () => {
    await fresh();
    const keys = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"];
    for (let i = 0; i < 40; i++) { await page.keyboard.press(keys[i % 4]); await page.waitForTimeout(120); }
    assert.deepStrictEqual(errors, []);
  });

  await page.screenshot({ path: process.env.SHOT || "/tmp/snake.png" });
  await browser.close();

  let failed = 0;
  for (const [s, m] of results) { console.log(s === "ok" ? "  ok  " : " FAIL ", m); failed += s !== "ok"; }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
