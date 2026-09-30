/* Echo Snake bots: used by the balance simulator and by the title-screen attract mode.
 * A bot is decide(game) -> { dir: [dx,dy] | null, phase: boolean }. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EchoBots = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function makeBot({ depth = 40, noise = 0, phasePolicy = "escape", gold = "take", rng = Math.random } = {}) {
  return function decide(g) {
    const N = g.N, L = g.snake.length;
    const head = g.snake[0], hist = g.hist, H = hist.length;
    const wrap = v => (v + N) % N;
    const at = (chain, i) => (i < H ? hist[i] : chain[i - H]);
    const ranges = g.echoRanges(L);
    const ranges1 = g.echoRanges(L + 1);

    // Would moving to (x,y) after `chain` be survivable? phaseLeft ticks ignore echoes.
    function safe(chain, x, y, eating, phaseLeft) {
      const end = H + chain.length - 1, hit = i => { const p = at(chain, i); return p && p.x === x && p.y === y; };
      const bodyN = eating ? L : L - 1;
      const phasing = phaseLeft - chain.length > 0;
      if (!(phasing && g.P.phaseBody)) for (let o = 1; o <= bodyN; o++) if (hit(end + 1 - o)) return false;
      if (phasing || !g.echoArmed()) return true;
      for (const [a, b] of eating ? ranges1 : ranges)
        for (let o = a; o <= b; o++) if (end + 1 - o >= 0 && hit(end + 1 - o)) return false;
      return true;
    }
    const isFood = (x, y) => (g.food && g.food.x === x && g.food.y === y) || (g.golden && g.golden.x === x && g.golden.y === y);
    const isGold = (x, y) => g.golden && g.golden.x === x && g.golden.y === y;
    const isPlain = (x, y) => g.food && g.food.x === x && g.food.y === y;

    function options(phaseLeft) {
      const out = [];
      for (const [dx, dy] of DIRS) {
        if (dx === -g.dir.x && dy === -g.dir.y) continue;
        const x = wrap(head.x + dx), y = wrap(head.y + dy);
        if (safe([], x, y, isFood(x, y), phaseLeft)) out.push({ dx, dy, x, y });
      }
      return out;
    }

    function bfs(first, phaseLeft, maxDepth, target) {
      target = target || isFood;
      const seen = new Set([head.x + "," + head.y]);
      let frontier = first.map(f => ({ x: f.x, y: f.y, chain: [{ x: f.x, y: f.y }], d: [f.dx, f.dy] }));
      frontier.forEach(n => seen.add(n.x + "," + n.y));
      for (let k = 0; k < maxDepth && frontier.length; k++) {
        for (const n of frontier) if (target(n.x, n.y)) return n.d;
        const next = [];
        for (const n of frontier) for (const [dx, dy] of DIRS) {
          const x = wrap(n.x + dx), y = wrap(n.y + dy), key = x + "," + y;
          if (seen.has(key) || !safe(n.chain, x, y, isFood(x, y), phaseLeft)) continue;
          seen.add(key);
          next.push({ x, y, chain: n.chain.concat({ x, y }), d: n.d });
        }
        frontier = next;
      }
      return null;
    }

    const first = options(g.phase);
    if (!first.length) {
      if (phasePolicy !== "never" && g.canPhase()) return { dir: null, phase: true };
      return { dir: null, phase: false };
    }
    if (noise && rng() < noise) { const f = first[Math.floor(rng() * first.length)]; return { dir: [f.dx, f.dy], phase: false }; }

    if (gold === "take" && g.golden) {
      const life = g.golden.expires - g.ticks;
      const r = bfs(first, g.phase, Math.min(depth, life), isGold);
      if (r) return { dir: r, phase: false };
    }
    const route = bfs(first, g.phase, depth, isPlain);
    if (route) return { dir: route, phase: false };

    // No echo-safe route. If phasing would open a short route, use it.
    if (phasePolicy !== "never" && g.canPhase()) {
      const ph = options(g.phase + 4);
      const r2 = bfs(ph, 4, 4);
      if (r2) return { dir: null, phase: true };
    }
    let best = first[0], bestArea = -1;
    for (const f of first) { const a = flood(g, f.x, f.y); if (a > bestArea) { bestArea = a; best = f; } }
    return { dir: [best.dx, best.dy], phase: false };
  };
}

function flood(g, sx, sy) {
  const N = g.N, blocked = new Set(g.snake.slice(0, -1).concat(g.ghostCells()).map(p => p.x + "," + p.y));
  const seen = new Set([sx + "," + sy]), q = [[sx, sy]];
  while (q.length && seen.size < 120) {
    const [x, y] = q.pop();
    for (const [dx, dy] of DIRS) {
      const nx = (x + dx + N) % N, ny = (y + dy + N) % N, k = nx + "," + ny;
      if (!seen.has(k) && !blocked.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen.size;
}

function randomBot(rng = Math.random) {
  return function (g) {
    const opts = DIRS.filter(([dx, dy]) => !(dx === -g.dir.x && dy === -g.dir.y));
    return { dir: opts[Math.floor(rng() * opts.length)], phase: false };
  };
}

// A human-ish bot: limited lookahead (cells of planning), random mis-steers ("slip"), and
// reaction lag (it only re-plans every `lag` ticks and otherwise keeps its last heading).
function humanBot({ depth = 12, slip = 0.04, lag = 1, rng = Math.random } = {}) {
  const smart = makeBot({ depth, rng });
  let n = 0, held = null;
  return function (g) {
    n++;
    if (rng() < slip) return randomBot(rng)(g);
    if (lag > 1 && n % lag !== 0 && held) return { dir: held, phase: false };
    const d = smart(g);
    held = d.dir;
    return d;
  };
}

return { makeBot, randomBot, humanBot, DIRS };

});
