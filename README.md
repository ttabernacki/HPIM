# HPIM: persistent mode + memory for Claude Code

A re-creation of two OpenAI Codex features inside a Claude Code session:

- **Persistent mode**: unreleased Codex code (`codex-rs/core/templates/persistent_mode.md`, commit `f1433fc`). The agent keeps working on follow-ups after its final answer, until put to sleep.
- **Memories**: Codex's two-phase cross-session memory (`codex-rs/memories/write/templates/`, `consolidation_v2.md`, `read_path_v2.md`).

## Layout

| Piece | File |
|---|---|
| Proactivity prompt (injected only while mode is `on`) | `.claude/persistent/persistent_mode.md` |
| Persistent-mode state CLI + hook handlers | `.claude/hooks/persist.py` |
| Memory registry, extraction, redaction, diff, validation | `.claude/hooks/memory.py` |
| Phase 1 / Phase 2 memory prompts | `.claude/agents/memory-writer.md`, `memory-consolidator.md` |
| Commands | `/persist`, `/sleep`, `/dream`, `/remember`, `/forget` in `.claude/commands/` |
| Hook wiring | `.claude/settings.json` |
| Tests | `tests/` (`python3 -W error::ResourceWarning -m unittest discover -s tests -p 'test_*.py'`) |

## Persistent mode

`/persist` turns it on. The agent registers follow-ups (target, stop condition, authorized scope, next check) with `persist.py add`. Then:

- **Stop hook**: when the agent tries to stop and a follow-up is active, it waits up to 170s for the next check and re-prompts the agent if one is due. For longer waits it blocks once, asking the agent to schedule a wake (`ScheduleWakeup`, else one-shot `CronCreate`, else `send_later`) with the prompt `[persistent-wake] check due follow-ups`, then lets the turn end.
- **Wake**: a prompt beginning `[persistent-wake]` is not treated as the user; the session stays autonomous.
- **PreToolUse guard**: during an autonomous continuation, only read-only tools run (read-only Bash, read-verb MCP tools, one-shot wake scheduling). Everything else is denied with "describe the action and wait for approval". A real user prompt ends the autonomous phase.
- **Notifications**: `PushNotification` is deduped (same text within 1h) and, in autonomous continuations, limited to one per 10 minutes.
- **Caps**: 20 continuations/hour and 12 hours total by default (`/persist --max-per-hour N --max-hours H`). `/sleep` stops everything; follow-ups are kept.

State: `.claude/persistent/state.json` (git-ignored).

## Memory

Capture is cheap and mechanical; distillation is model-driven and on demand.

1. **Capture**: `Stop` and `SessionEnd` hooks register the session (id, transcript path, cwd, time) in `.claude/memory/.registry.json`.
2. **`/dream`** (sessions idle >= 6h, override with `PERSIST_MEMORY_MIN_IDLE`, or `--all`):
   - Phase 1: one `memory-writer` subagent per session reads a condensed, secret- and PHI-redacted extract of the transcript and writes `rollout_summaries/<slug>.md`, or no-ops.
   - Phase 2: `memory-consolidator` reads the git diff since the last consolidation (deleted summaries or user edits propagate as forgetting) plus `/remember` and `/forget` notes, and rewrites `memory_summary.md` (<= 10,000 bytes, `v1` header, four fixed sections).
   - `memory.py validate` must pass (format, size, no secrets/emails, no dangling pointers) before `baseline` commits the new state.
3. **Read path**: `SessionStart` injects `memory_summary.md` with read-path instructions (memory is not proof of current behavior; read rollout summaries only when they could change the answer).

Memory lives in `.claude/memory/` (its own git repo, ignored by this one). It is plain files: read, diff, edit, or delete anything.

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
