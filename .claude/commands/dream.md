---
description: Consolidate past sessions into cross-session memory (two-phase, like Codex memories)
allowed-tools: Bash(python3 .claude/hooks/memory.py:*), Agent, Read
---
Run memory consolidation.

1. `python3 .claude/hooks/memory.py pending $ARGUMENTS` lists sessions idle long enough to distill (pass `--all` to ignore the idle threshold). Each output line is JSON with a `session_id`.
2. Phase 1: for each pending session, spawn the `memory-writer` subagent with the session id (independent sessions may run in parallel).
3. Phase 2: spawn the `memory-consolidator` subagent once, even if there were no pending sessions, since user notes or edits may be waiting.
4. Run `python3 .claude/hooks/memory.py validate`. Only if it passes, run `python3 .claude/hooks/memory.py baseline`. If it fails, report the failure and do not baseline.
5. Reply in three lines or fewer: sessions distilled, sessions skipped as no-op, and whether the summary changed.
