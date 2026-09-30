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
| Tests | `tests/` (`python3 -W error::ResourceWarning -m unittest discover -s tests`) |

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

## Demo: Echo Snake

`snake/index.html` is a single-file snake variant built with persistent mode on. Mechanic: your own past replays behind you as a deadly *echo*. Each food shrinks the echo's delay (24 down to 10 ticks), Space *blinks* you onto the echo's head (1 charge, +1 per 4 foods, max 3). Open the file in a browser. Playtest: `NODE_PATH=$(npm root -g) node tests/e2e_snake.js` (headless Chromium, 15 checks).

## Known limits

- Hooks load at session start; restart Claude Code after cloning. The hook logic is unit-tested and the memory pipeline was run end to end once with real subagents, but persistent mode has not been exercised inside a long-running interactive session.
- The Bash guard is a heuristic allowlist, not a sandbox.
- Wakes rely on session-local schedulers (`CronCreate` jobs die with the session), so a wake does not survive the session being closed.
- Only the prompt template of Codex persistent mode is public; the harness (re-sampling trigger, reasoning-effort setting) is re-implemented here from press descriptions.
