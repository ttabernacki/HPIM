# HPIM: persistent mode for Claude Code

Two things live in this repo:

1. **`persistent-mode/`**: a portable, installable re-creation of OpenAI Codex's unreleased *Persistent mode* (an agent that keeps working on follow-ups after its final answer, read-only unless you approve) plus a Codex-style cross-session memory layer. Install it into any repo or into `~/.claude`:

   ```bash
   python3 persistent-mode/install.py --project /path/to/your/repo      # or --user, --local, --dry-run, --check, --uninstall
   ```

   Full docs, design and limits: **[persistent-mode/README.md](persistent-mode/README.md)**. Source of truth is `persistent-mode/src/`; this repo installs its own copy into `.claude/` and a test fails if the two drift.

2. **`snake/`**: *Echo Snake*, a browser game built while persistent mode was on (below), with the headless balance simulator in `tools/`.

| Tests | Command |
|---|---|
| Persistent mode + memory + installer (65) | `python3 -W error::ResourceWarning -m unittest discover -s persistent-mode/tests -p 'test_*.py'` |
| Game rules (26, incl. fuzz) | `node --test tests/*.test.js` |
| Game in headless Chromium (20) | `NODE_PATH=$(npm root -g) node tests/e2e_snake.js` |

## Echo Snake (the demo game)

Open `snake/index.html` in a browser (no build, no server needed). Built while persistent mode was on; see `snake/` and `tools/`.

**The idea.** Your snake is a *dashed trail* along your own path: your body, a safe gap, then detached **echo** segments that replay where you were. Touching an echo ends the run. Echoes are fully predictable (they are your own history), so the game is planning, not reflexes.

| Mechanic | Rule |
|---|---|
| Echo | Segments follow your path with a gap. A new one every 10 foods (max 3); the gap tightens from 14 to 5. Dormant (harmless, dim) until food #2. |
| Phase | Space / button / A. Pass through echoes for 4 moves; +15 x multiplier for each echo cell you cross. Earn a charge every 4 foods (max 3). Never passes through your own body. |
| Graze | Ending a move next to an echo scores +1 x multiplier: risk pays. |
| Combo | Reach food within the shortest route + 8 ticks to raise the multiplier (x1 to x5). |
| Golden food | Every 6 foods. 50 x multiplier, +1 phase charge, grows you; spawns next to echoes and expires. |
| Daily | Seeded from the date: same food sequence for everyone. |

**Controls.** Arrows/WASD or swipe, Space/tap the button, P/Esc pause, R restart, M mute, gamepad (d-pad, A, Start). Settings: SFX, music, reduce motion, colorblind palette.

### How "fun" was measured

Fun can't be measured by a bot, but *design defects* can. `tools/sim.js` plays thousands of headless games with bots of different skill (`snake/bots.js`) and reports difficulty curves, tension and how much each mechanic matters:

```
node tools/sim.js --games 200 --bot novice|human|expert|plan|random [--opts '{"graceFoods":3}']
```

What the data changed:

1. **v1 (single ghost, blink teleport) was broken.** Bots never used Blink (0.0 uses, 3/3 charges banked) because the echo overlapped your body after ~10 foods, so the teleport was always blocked; the echo also turned into a plain longer tail. Redesigned into the dashed trail (gap + detached echoes) and replaced Blink with Phase.
2. **Phase through the body was rejected.** It made the perfect-play bot effectively immortal (119/120 survived 1500 ticks) while barely changing intermediate play.
3. **Skill ladder is healthy** (median foods): random 0, novice 3, intermediate 25, expert 45, perfect planner 66; every tier is clearly better than the one below.
4. **The echo costs skilled players 12-23% of run length** (echo off vs on), a real threat without dominating.
5. **Golden food is a true trade-off**: bots that chase it score about the same (3707 vs 3825 median) but survive fewer foods.
6. **Novices died to the echo early** (35% before their 2nd food), so the first echo is dormant until food #2.

Not measurable here, and left to a human: game feel by hand, sound by ear, and the exact constants (`DEFAULTS` in `snake/core.js`). Tune them and re-run the sim.

### Tests

```
node --test tests/*.test.js                     # 26 core/unit tests incl. a 300-game invariant fuzz
NODE_PATH=$(npm root -g) node tests/e2e_snake.js   # 20 headless-Chromium checks: screens, input, phone + landscape,
                                                #   persistence, audio output, gamepad, render performance
```

## Known limits

- Hooks load at session start; restart Claude Code after cloning. The hook logic is unit-tested and the memory pipeline was run end to end once with real subagents, but persistent mode has not been exercised inside a long-running interactive session.
- The Bash guard is a heuristic allowlist, not a sandbox.
- Wakes rely on session-local schedulers (`CronCreate` jobs die with the session), so a wake does not survive the session being closed.
- Only the prompt template of Codex persistent mode is public; the harness (re-sampling trigger, reasoning-effort setting) is re-implemented here from press descriptions.
