# HPIM: persistent mode for Claude Code

A re-creation of OpenAI Codex's unreleased "Persistent mode" (prompt: `codex-rs/core/templates/persistent_mode.md`, commit `f1433fc`).

| Piece | File |
|---|---|
| Proactivity prompt (injected only while mode is `on`) | `.claude/persistent/persistent_mode.md` |
| State CLI + hook handlers | `.claude/hooks/persist.py` |
| Hook wiring | `.claude/settings.json` |
| `/persist`, `/sleep` | `.claude/commands/` |
| Tests | `tests/test_persist.py` (`python3 -m unittest discover -s tests`) |

Flow: `/persist` turns it on. The agent registers follow-ups (target, stop condition, scope, next check) via the CLI. When it tries to stop, the `Stop` hook waits up to 170s for the next check and re-prompts the agent if a follow-up is due. While that continuation is autonomous, the `PreToolUse` guard denies anything that isn't read-only. A user prompt ends the autonomous phase. `/sleep` stops all auto-continuation.

Caps (defaults): 20 continuations/hour, 12 hours total; override with `/persist --max-per-hour N --max-hours H`.

Not yet built: scheduled wakes for checks further out than 170s, push-notification dedupe, memory layer.
