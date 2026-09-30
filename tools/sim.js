// Balance simulator. Usage: node tools/sim.js [--games 200] [--opts '{"startDelay":24}'] [--bot plan|random|noisy] [--max 1500]
const { createGame, mulberry32 } = require("../snake/core.js");
const { makeBot, randomBot, humanBot } = require("../snake/bots.js");

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i < 0 ? def : process.argv[i + 1]; }

function runOne(seed, opts, botName, maxTicks) {
  const rng = mulberry32(seed * 7919 + 13);
  const g = createGame(Object.assign({}, opts, { seed }));
  const bot = botName === "random" ? randomBot(rng)
    : botName === "novice" ? humanBot({ depth: 6, slip: 0.10, lag: 2, rng })
    : botName === "human" ? humanBot({ rng })
    : botName === "expert" ? humanBot({ depth: 25, slip: 0.01, rng })
    : botName === "nogold" ? makeBot({ gold: "ignore", rng }) : botName === "noisy" ? makeBot({ noise: 0.06, rng }) : makeBot({ rng });
  const m = { phases: 0, echoNear: 0, foodTicks: [], lastFood: 0, tight: 0, tightTicks: 0 };
  while (g.alive && g.ticks < maxTicks) {
    const sm = g.safeMoves().length; m.tightTicks++; if (sm <= 1) m.tight++;
    const d = bot(g);
    if (d.phase) { if (g.phaseShift()) m.phases++; } else if (d.dir) g.turn(d.dir[0], d.dir[1]);
    const before = g.foods;
    g.step();
    if (!g.alive) break;
    if (g.foods > before) { m.foodTicks.push(g.ticks - m.lastFood); m.lastFood = g.ticks; }
  }
  return { foods: g.foods, ticks: g.ticks, cause: g.alive ? "alive" : g.cause, ...m, grazes: g.grazes, score: g.score, goldens: g.stats.goldens, phaseThroughs: g.stats.phaseThroughs, tension: m.tight / Math.max(1, m.tightTicks),
           len: g.snake.length, charges: g.charges, echoes: g.echoCount(), gap: g.gap() };
}

function pct(a, p) { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
function summarize(rows) {
  const f = rows.map(r => r.foods), t = rows.map(r => r.ticks), sc = rows.map(r => r.score);
  const causes = {}; rows.forEach(r => causes[r.cause] = (causes[r.cause] || 0) + 1);
  const avg = k => (rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(1);
  return { games: rows.length, foods_p10_p50_p90: [pct(f, .1), pct(f, .5), pct(f, .9)].join("/"),
    ticks_p50: pct(t, .5), score_p50: pct(sc, .5), causes, phases_avg: avg("phases"), golden_avg: (rows.reduce((a, r) => a + r.goldens, 0) / rows.length).toFixed(1), phaseThru_avg: (rows.reduce((a, r) => a + r.phaseThroughs, 0) / rows.length).toFixed(1), grazes_avg: avg("grazes"),
    tension_avg: (rows.reduce((a, r) => a + r.tension, 0) / rows.length).toFixed(3),
    reach: [5, 10, 20, 30, 50, 75].map(k => k + ":" + (rows.filter(r => r.foods >= k).length / rows.length).toFixed(2)).join(" "),
    charges_left_avg: avg("charges"), echoes_avg: avg("echoes"), len_avg: avg("len") };
}

if (require.main === module) {
  const games = +arg("games", 200), maxTicks = +arg("max", 1500), botName = arg("bot", "plan");
  const opts = JSON.parse(arg("opts", "{}"));
  const rows = [];
  for (let s = 1; s <= games; s++) rows.push(runOne(s, opts, botName, maxTicks));
  console.log(JSON.stringify({ bot: botName, opts, ...summarize(rows) }, null, 1));
}
module.exports = { runOne, summarize };
