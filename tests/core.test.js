// Unit tests for snake/core.js. Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const { createGame, dailySeed, mulberry32 } = require("../snake/core.js");
const { randomBot, makeBot } = require("../snake/bots.js");

const cell = (x, y) => ({ x, y });
const line = (n, y = 10, x0 = 10) => Array.from({ length: n }, (_, i) => cell(x0 - i, y));

// A game with a hand-built board. hist = path oldest -> newest (head last).
function setup(o = {}) {
  const g = createGame(Object.assign({ seed: 1, graceFoods: 0 }, o.params));
  g.snake = o.snake || line(3);
  g.hist = o.hist || g.snake.slice().reverse();
  g.dir = o.dir || cell(1, 0);
  g.queue = [];
  g.food = o.food === undefined ? cell(0, 0) : o.food;
  g.golden = o.golden || null;
  g.foods = o.foods || 0;
  g.combo = 0; g.foodDeadline = 1e9;
  g.charges = o.charges == null ? 1 : o.charges;
  g.phase = o.phase || 0;
  return g;
}

test("echo ranges: body, then gap, then echo of fixed length", () => {
  const g = createGame({ seed: 1 });
  assert.deepStrictEqual(g.echoRanges(3, 0), [[17, 20]]);            // L=3 + gap 14
  assert.deepStrictEqual(g.echoRanges(3, 9), [[8, 12]]);             // gap shrank to 5, echo grew to 5
  // 30 foods: gap 5, echo length 4+3=7, three echoes, each starting after the previous + gap
  assert.deepStrictEqual(g.echoRanges(10, 30), [[15, 21], [27, 33], [39, 45]]);
});

test("gap shrinks per food and bottoms out at minGap", () => {
  const g = createGame({ seed: 1 });
  g.foods = 0; assert.strictEqual(g.gap(), 14);
  g.foods = 4; assert.strictEqual(g.gap(), 10);
  g.foods = 50; assert.strictEqual(g.gap(), 5);
});

test("a new echo every 10 foods up to the cap; echoes lengthen every 8 foods", () => {
  const g = createGame({ seed: 1 });
  const at = f => { g.foods = f; return [g.echoCount(), g.echoLength()]; };
  assert.deepStrictEqual(at(0), [1, 4]);
  assert.deepStrictEqual(at(9), [1, 5]);
  assert.deepStrictEqual(at(10), [2, 5]);
  assert.deepStrictEqual(at(20), [3, 6]);
  assert.deepStrictEqual(at(200), [3, 8]);
});

test("moving straight on the wrapped board: 17 safe moves, then you hit your own echo", () => {
  const g = createGame({ seed: 1, graceFoods: 0 });
  g.food = cell(0, 0);
  let n = 0;
  while (g.alive && n < 40) { g.step(); n++; }
  assert.strictEqual(g.alive, false);
  assert.strictEqual(g.cause, "echo");
  assert.strictEqual(g.ticks, 17);
});

test("moving into the cell your tail is vacating is safe", () => {
  const g = setup({ snake: [cell(5, 5), cell(5, 6), cell(6, 6), cell(6, 5), cell(6, 4), cell(5, 4)], dir: cell(0, -1) });
  g.step();
  assert.strictEqual(g.alive, true);
});

test("hitting a non-tail body cell kills you (self)", () => {
  const g = setup({ snake: [cell(5, 5), cell(5, 6), cell(6, 6), cell(6, 5), cell(6, 4), cell(5, 4), cell(4, 4)], dir: cell(0, -1) });
  g.step();
  assert.strictEqual(g.cause, "self");
});

test("death records what you hit and where", () => {
  const g = setup({ snake: [cell(5, 5), cell(5, 6), cell(6, 6), cell(6, 5), cell(6, 4), cell(5, 4), cell(4, 4)], dir: cell(0, -1) });
  g.step();
  assert.deepStrictEqual(g.deathAt, cell(5, 4));
  const ev = g.drainEvents().find(e => e.type === "die");
  assert.strictEqual(ev.cause, "self");
  assert.deepStrictEqual(ev.at, cell(5, 4));
});

test("cannot reverse into yourself; queue is capped at 2", () => {
  const g = setup();
  g.turn(-1, 0); g.step();
  assert.deepStrictEqual(g.dir, cell(1, 0));
  g.turn(0, 1); g.turn(-1, 0); g.turn(0, -1);
  assert.strictEqual(g.queue.length, 2);
});

test("eating scores 10 x multiplier, grows, advances foods, spawns off-snake", () => {
  const g = setup({ food: cell(11, 10) });
  g.step();
  assert.strictEqual(g.snake.length, 4);
  assert.strictEqual(g.foods, 1);
  assert.ok(g.score >= 10);
  const busy = new Set(g.snake.concat(g.ghostCells()).map(p => p.x + "," + p.y));
  assert.ok(!busy.has(g.food.x + "," + g.food.y));
});

test("combo builds only when food is reached within the shortest route plus slack", () => {
  const g = setup({ food: cell(11, 10) });
  g.foodDeadline = g.ticks + 1 + g.P.comboSlack;
  g.step();
  assert.strictEqual(g.combo, 1);
  g.foodDeadline = -1;                       // next food is late
  g.food = cell(g.snake[0].x + 1, g.snake[0].y);
  g.step();
  assert.strictEqual(g.combo, 0);
  assert.strictEqual(g.stats.comboBreaks, 1);
});

test("multiplier: +1 per two combo, capped", () => {
  const g = createGame({ seed: 1 });
  g.combo = 0; assert.strictEqual(g.multiplier(), 1);
  g.combo = 2; assert.strictEqual(g.multiplier(), 2);
  g.combo = 99; assert.strictEqual(g.multiplier(), g.P.maxMult);
});

// Echo geometry helpers: with L=3, gap=14 the echo head is 17 ticks behind the head.
function withEchoAhead() {
  // Head at (2,2) heading right. Next echo cells (after the move) are offsets 17..20 from the
  // new head; place path so that the echo head lands exactly on (3,2).
  const hist = [];
  for (let i = 0; i < 30; i++) hist.push(cell(19, 19));           // filler, far away
  hist[30 - 1 - 16] = cell(3, 2);                                 // offset 17 from new head (idx 30)
  const snake = [cell(2, 2), cell(1, 2), cell(0, 2)];
  hist.length = 27; hist.push(cell(0, 2), cell(1, 2), cell(2, 2));   // path ends at head
  // recompute: head idx = 29 ; new head idx 30 ; offset 17 -> idx 13
  hist[13] = cell(3, 2);
  return setup({ snake, hist, dir: cell(1, 0), food: cell(0, 0) });
}

test("entering an echo cell kills; echo positions are evaluated after the move", () => {
  const g = withEchoAhead();
  g.step();
  assert.strictEqual(g.cause, "echo");
});

test("phase lets you through an echo, awards a bonus, and expires after phaseTicks moves", () => {
  const g = withEchoAhead();
  assert.strictEqual(g.phaseShift(), true);
  assert.strictEqual(g.charges, 0);
  const before = g.score;
  g.step();
  assert.strictEqual(g.alive, true);
  assert.ok(g.score - before >= g.P.phaseThroughScore);
  assert.strictEqual(g.stats.phaseThroughs, 1);
  assert.strictEqual(g.phase, g.P.phaseTicks - 1);
  for (let i = 0; i < g.P.phaseTicks - 1; i++) { g.food = cell(0, 0); g.step(); }
  assert.strictEqual(g.phase, 0);
});

test("phase needs a charge and cannot be stacked while active", () => {
  const g = setup({ charges: 0 });
  assert.strictEqual(g.phaseShift(), false);
  g.charges = 2;
  assert.strictEqual(g.phaseShift(), true);
  assert.strictEqual(g.phaseShift(), false);
  assert.strictEqual(g.charges, 1);
});

test("phase does not let you through your own body by default", () => {
  const g = setup({ snake: [cell(5, 5), cell(5, 6), cell(6, 6), cell(6, 5), cell(6, 4), cell(5, 4), cell(4, 4)], dir: cell(0, -1), phase: 3 });
  g.step();
  assert.strictEqual(g.cause, "self");
});

test("a charge is earned every foodsPerCharge foods, capped at maxCharges", () => {
  const g = setup({ charges: 0, foods: 3 });
  g.food = cell(11, 10); g.step();
  assert.strictEqual(g.charges, 1);
  g.foods = 7; g.charges = 3; g.food = cell(g.snake[0].x + 1, g.snake[0].y); g.step();
  assert.strictEqual(g.charges, 3);
});

test("golden food: +score, +charge, grows, does not advance echo progression", () => {
  const g = setup({ golden: { x: 11, y: 10, expires: 999 }, food: cell(0, 0), charges: 0 });
  g.step();
  assert.strictEqual(g.snake.length, 4);
  assert.strictEqual(g.foods, 0);
  assert.strictEqual(g.charges, 1);
  assert.strictEqual(g.stats.goldens, 1);
  assert.ok(g.score >= g.P.goldenScore);
  assert.strictEqual(g.golden, null);
});

test("golden food expires", () => {
  const g = setup({ golden: { x: 0, y: 0, expires: 1 } });
  g.food = cell(19, 19);
  g.step(); g.step();
  assert.strictEqual(g.golden, null);
  assert.ok(g.drainEvents().some(e => e.type === "goldenGone"));
});

test("a golden food spawns after every goldenEvery foods, away from the head", () => {
  const g = setup({ food: cell(11, 10), foods: 5 });
  g.step();
  assert.ok(g.golden);
  const h = g.snake[0];
  const d = Math.min(Math.abs(g.golden.x - h.x), 20 - Math.abs(g.golden.x - h.x)) + Math.min(Math.abs(g.golden.y - h.y), 20 - Math.abs(g.golden.y - h.y));
  assert.ok(d >= g.P.goldenMinDist);
});

test("safeMoves excludes the reverse and deadly moves", () => {
  const g = setup({ snake: [cell(5, 5), cell(5, 6), cell(6, 6), cell(6, 5), cell(6, 4), cell(5, 4), cell(4, 4)], dir: cell(0, -1) });
  const moves = g.safeMoves().map(m => m.join(","));
  assert.ok(!moves.includes("0,-1"));   // into body
  assert.ok(!moves.includes("0,1"));    // reverse
  assert.ok(!moves.includes("1,0"));    // (6,5) is body
  assert.deepStrictEqual(moves, ["-1,0"]);
});

test("same seed, same inputs: identical game", () => {
  const run = () => {
    const g = createGame({ seed: 42 }), bot = makeBot({ rng: mulberry32(9) });
    for (let i = 0; i < 300 && g.alive; i++) { const d = bot(g); if (d.phase) g.phaseShift(); else if (d.dir) g.turn(...d.dir); g.step(); }
    return JSON.stringify([g.score, g.foods, g.ticks, g.snake]);
  };
  assert.strictEqual(run(), run());
});

test("dailySeed is YYYYMMDD", () => {
  assert.strictEqual(dailySeed(new Date(2026, 8, 30)), 20260930);
});

test("grace period: echoes are harmless (and no graze/phase bonus) until graceFoods foods are eaten", () => {
  const g = createGame({ seed: 1, graceFoods: 2 });
  g.food = { x: 0, y: 0 };
  for (let i = 0; i < 40; i++) g.step();          // straight line: would hit the echo at move 18 if armed
  assert.strictEqual(g.alive, true);
  assert.strictEqual(g.echoArmed(), false);
  assert.strictEqual(g.stats.grazes, 0);
});

test("the echo arms on the graceFoods-th food and announces it", () => {
  const g = setup({ params: { graceFoods: 2 }, foods: 1, food: cell(11, 10) });
  g.step();
  assert.strictEqual(g.echoArmed(), true);
  assert.ok(g.drainEvents().some(e => e.type === "armed"));
});

test("events are emitted and drained", () => {
  const g = setup({ food: cell(11, 10) });
  g.step();
  const ev = g.drainEvents();
  assert.ok(ev.some(e => e.type === "eat"));
  assert.strictEqual(g.events.length, 0);
});

test("fuzz: invariants hold across 300 random and bot games", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = mulberry32(seed);
    const g = createGame({ seed }), bot = seed % 2 ? randomBot(rng) : makeBot({ rng, noise: 0.1 });
    let lastScore = 0;
    for (let i = 0; i < 600 && g.alive; i++) {
      const d = bot(g);
      if (d.phase) g.phaseShift(); else if (d.dir) g.turn(...d.dir);
      g.step();
      assert.ok(g.score >= lastScore, "score never decreases"); lastScore = g.score;
      for (const p of g.snake) assert.ok(p.x >= 0 && p.x < 20 && p.y >= 0 && p.y < 20, "in bounds");
      if (g.alive) {
        assert.strictEqual(new Set(g.snake.map(p => p.x + "," + p.y)).size, g.snake.length, "body cells unique");
        if (g.food) {
          const busy = g.snake.concat(g.ghostCells());
          // food can end up under a newly advanced echo, but never on the body
          assert.ok(!g.snake.some(p => p.x === g.food.x && p.y === g.food.y), "food not on body");
        }
        assert.ok(g.charges >= 0 && g.charges <= g.P.maxCharges);
        assert.ok(g.phase >= 0 && g.phase <= g.P.phaseTicks);
        assert.ok(g.hist.length <= 900);
      }
    }
  }
});
