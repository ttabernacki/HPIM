/* Echo Snake core: pure game rules, no DOM. Used by the page and by the bot simulator.
 *
 * The snake is a dashed trail along your own path. Measured in ticks behind the head:
 *   offsets 0..L-1                  your body
 *   then a safe gap, then an ECHO segment (deadly), then a gap, another echo, ...
 * Echoes are your past path replayed, so they are fully predictable. Phase lets you
 * pass through echoes for a few ticks. Grazing an echo and fast routes score extra.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EchoCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEFAULTS = {
    N: 20,
    startLen: 3,
    graceFoods: 2,         // echoes are visible but harmless until you have eaten this many foods
    startGap: 14,          // safe cells between your tail and the first echo at the start
    minGap: 5,
    gapStep: 1,            // gap shrinks by this per food, down to minGap
    echoLen: 4,            // length of each echo at the start
    echoLenEvery: 8,       // echoes grow by 1 every this many foods
    maxEchoLen: 8,
    echoEvery: 10,         // a new echo appears every this many foods
    maxEchoes: 3,
    startCharges: 1,
    maxCharges: 3,
    foodsPerCharge: 4,
    phaseTicks: 4,
    phaseBody: false,      // if true, phasing also lets you pass through your own body
    phaseThroughScore: 15, // bonus (x multiplier) for entering an echo cell while phasing
    goldenEvery: 6,        // a golden food appears after every this many foods
    goldenScore: 50,
    goldenSlack: 18,       // ticks of life beyond the shortest route
    goldenMinDist: 4,
    grazeScore: 1,
    comboSlack: 8,         // ticks of slack over the shortest route to keep a combo
    maxMult: 5,
    baseMs: 125, minMs: 75, msPerFood: 2,
  };

  function createGame(opts) {
    const P = Object.assign({}, DEFAULTS, opts || {});
    const N = P.N;
    const rng = P.rng || (P.seed != null ? mulberry32(P.seed) : Math.random);
    const eq = (a, b) => a.x === b.x && a.y === b.y;
    const wrap = v => (v + N) % N;
    const dist1 = (a, b) => {
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      return Math.min(dx, N - dx) + Math.min(dy, N - dy);
    };
    const g = { P, N, rng, events: [] };

    // ---- derived parameters ------------------------------------------------
    g.gap = () => Math.max(P.minGap, P.startGap - g.foods * P.gapStep);
    g.echoLength = () => Math.min(P.maxEchoLen, P.echoLen + Math.floor(g.foods / P.echoLenEvery));
    g.echoCount = () => Math.min(P.maxEchoes, 1 + Math.floor(g.foods / P.echoEvery));
    g.tickMs = () => Math.max(P.minMs, P.baseMs - g.foods * P.msPerFood);
    g.echoArmed = () => g.foods >= P.graceFoods;
    g.multiplier = () => Math.min(P.maxMult, 1 + Math.floor(g.combo / 2));

    // Deadly offset ranges [start,end] (ticks behind the head) for body length L.
    g.echoRanges = function (L, foods) {
      const f = foods == null ? g.foods : foods;
      const gap = Math.max(P.minGap, P.startGap - f * P.gapStep);
      const len = Math.min(P.maxEchoLen, P.echoLen + Math.floor(f / P.echoLenEvery));
      const n = Math.min(P.maxEchoes, 1 + Math.floor(f / P.echoEvery));
      const out = [];
      let s = L + gap;
      for (let i = 0; i < n; i++) { out.push([s, s + len - 1]); s += len + gap; }
      return out;
    };

    // Echo cells as currently drawn (relative to the current head). Each has .echo (index).
    g.ghostCells = function () {
      const out = [], end = g.hist.length - 1;
      g.echoRanges(g.snake.length).forEach(([a, b], e) => {
        for (let o = a; o <= b; o++) { const p = g.hist[end - o]; if (p) out.push({ x: p.x, y: p.y, echo: e, head: o === a }); }
      });
      return out;
    };

    // ---- lifecycle ---------------------------------------------------------
    g.reset = function () {
      const snake = [];
      for (let i = 0; i < P.startLen; i++) snake.push({ x: 10 - i, y: 10 });
      g.snake = snake;
      g.dir = { x: 1, y: 0 };
      g.queue = [];
      g.hist = snake.slice().reverse();
      g.score = 0; g.foods = 0; g.ticks = 0; g.grazes = 0; g.won = false;
      g.combo = 0; g.foodDeadline = 0; g.foodSpawnTick = 0;
      g.charges = P.startCharges; g.phase = 0;
      g.golden = null;
      g.stats = { maxCombo: 0, phases: 0, phaseThroughs: 0, goldens: 0, grazes: 0, comboBreaks: 0 };
      g.alive = true; g.cause = null;
      g.events.length = 0;
      g.food = g.spawnFood();
      g.armCombo();
    };

    g.armCombo = function () {
      g.foodWindow = (g.food ? dist1(g.snake[0], g.food) : 0) + P.comboSlack;   // ticks allowed for this food
      g.foodDeadline = g.ticks + g.foodWindow;
    };

    g.spawnFood = function () {
      const busy = new Set(g.snake.concat(g.ghostCells()).map(p => p.x + "," + p.y));
      const free = [];
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) if (!busy.has(x + "," + y)) free.push({ x, y });
      return free.length ? free[Math.floor(rng() * free.length)] : null;
    };

    g.spawnGolden = function () {
      const echoCells = g.ghostCells();
      const busy = new Set(g.snake.concat(echoCells, g.food ? [g.food] : []).map(p => p.x + "," + p.y));
      const risky = new Set();
      echoCells.forEach(c => [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => risky.add(wrap(c.x + dx) + "," + wrap(c.y + dy))));
      const near = [], far = [], h = g.snake[0];
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
        const k = x + "," + y, c = { x, y };
        if (busy.has(k) || dist1(c, h) < P.goldenMinDist) continue;
        (risky.has(k) ? near : far).push(c);
      }
      const pool = near.length ? near : far;
      if (!pool.length) return null;
      const c = pool[Math.floor(rng() * pool.length)];
      return { x: c.x, y: c.y, expires: g.ticks + dist1(h, c) + P.goldenSlack };
    };

    g.drainEvents = function () { const e = g.events.slice(); g.events.length = 0; return e; };

    g.turn = function (x, y) {
      const last = g.queue.length ? g.queue[g.queue.length - 1] : g.dir;
      if (last.x === x && last.y === y) return;
      if (g.queue.length < 2) g.queue.push({ x, y });
    };

    function die(cause) { g.alive = false; g.cause = cause; g.events.push({ type: "die", cause }); }

    // Which echo cells will be deadly after the next move (they advance one step).
    function nextEchoCells(eating) {
      const out = [], end = g.hist.length - 1, L = g.snake.length + (eating ? 1 : 0);
      g.echoRanges(L).forEach(([a, b]) => {
        for (let o = a; o <= b; o++) { const p = g.hist[end + 1 - o]; if (p) out.push(p); }
      });
      return out;
    }

    g.step = function () {
      if (!g.alive) return;
      if (g.queue.length) {
        const d = g.queue.shift();
        if (!(d.x === -g.dir.x && d.y === -g.dir.y)) g.dir = d;
      }
      const h = g.snake[0];
      const nh = { x: wrap(h.x + g.dir.x), y: wrap(h.y + g.dir.y) };
      const gold = !!(g.golden && eq(nh, g.golden));
      const eat = !!(g.food && eq(nh, g.food));
      const grow = eat || gold;
      const phasingNow = g.phase > 0;
      const body = grow ? g.snake : g.snake.slice(0, -1);
      if (!(g.phase > 0 && P.phaseBody) && body.some(p => eq(p, nh))) return die("self");
      const echoes = nextEchoCells(grow);
      const inEcho = echoes.some(p => eq(p, nh));
      const armed = g.echoArmed();
      if (!phasingNow && armed && inEcho) return die("echo");

      g.snake.unshift(nh);
      if (!grow) g.snake.pop();
      g.hist.push(nh);
      while (g.hist.length > 900) g.hist.shift();
      g.ticks++;
      if (g.phase > 0) { g.phase--; if (g.phase === 0) g.events.push({ type: "phaseEnd" }); }

      if (phasingNow && armed && inEcho) {
        g.stats.phaseThroughs++;
        const pts = P.phaseThroughScore * g.multiplier();
        g.score += pts; g.events.push({ type: "phaseThrough", at: nh, pts });
      }
      // Graze: ended the move adjacent to an echo cell (and not phasing).
      if (g.phase <= 0 && armed && echoes.some(p => dist1(p, nh) === 1)) {
        g.grazes++; g.stats.grazes++;
        g.score += P.grazeScore * g.multiplier();
        g.events.push({ type: "graze", at: nh });
      }

      if (gold) {
        const pts = P.goldenScore * g.multiplier();
        g.score += pts; g.stats.goldens++; g.golden = null;
        if (g.charges < P.maxCharges) g.charges++;
        g.events.push({ type: "golden", at: nh, pts });
      } else if (g.golden && g.ticks > g.golden.expires) {
        g.golden = null; g.events.push({ type: "goldenGone" });
      }

      if (eat) {
        if (g.ticks <= g.foodDeadline) g.combo++; else { if (g.combo > 0) g.stats.comboBreaks++; g.combo = 0; }
        g.stats.maxCombo = Math.max(g.stats.maxCombo, g.combo);
        const pts = 10 * g.multiplier();
        const echoesBefore = g.echoCount();
        g.score += pts; g.foods++;
        const eaten = g.food;
        if (g.foods % P.foodsPerCharge === 0 && g.charges < P.maxCharges) { g.charges++; g.events.push({ type: "charge" }); }
        if (g.echoCount() > echoesBefore) g.events.push({ type: "newEcho" });
        if (P.graceFoods > 0 && g.foods === P.graceFoods) g.events.push({ type: "armed" });
        g.food = g.spawnFood();
        if (!g.food) { g.won = true; return die("clear"); }
        if (!g.golden && g.foods % P.goldenEvery === 0) {
          g.golden = g.spawnGolden();
          if (g.golden) g.events.push({ type: "goldenSpawn", at: g.golden });
        }
        g.armCombo();
        g.events.push({ type: "eat", at: eaten, pts, combo: g.combo, mult: g.multiplier() });
      } else if (g.ticks > g.foodDeadline && g.combo > 0) {
        g.combo = 0; g.stats.comboBreaks++; g.events.push({ type: "comboLost" });
      }
    };

    // Non-mutating lookahead used by the UI (danger cues) and the tension metric.
    g.wouldDie = function (dx, dy) {
      const h = g.snake[0];
      const nh = { x: wrap(h.x + dx), y: wrap(h.y + dy) };
      const eat = !!((g.food && eq(nh, g.food)) || (g.golden && eq(nh, g.golden)));
      const body = eat ? g.snake : g.snake.slice(0, -1);
      if (!(g.phase > 0 && P.phaseBody) && body.some(p => eq(p, nh))) return "self";
      if (g.phase <= 0 && g.echoArmed() && nextEchoCells(eat).some(p => eq(p, nh))) return "echo";
      return null;
    };
    g.safeMoves = function () {
      const out = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (dx === -g.dir.x && dy === -g.dir.y) continue;
        if (!g.wouldDie(dx, dy)) out.push([dx, dy]);
      }
      return out;
    };

    g.canPhase = () => g.alive && g.charges > 0 && g.phase <= 0;
    g.phaseShift = function () {
      if (!g.canPhase()) { g.events.push({ type: "phaseFail" }); return false; }
      g.charges--; g.phase = P.phaseTicks; g.stats.phases++;
      g.events.push({ type: "phase" });
      return true;
    };

    g.reset();
    return g;
  }

  function dailySeed(d) {
    d = d || new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  return { createGame, mulberry32, dailySeed, DEFAULTS };
});
