---
description: Remove something from memory (applied at the next /dream)
allowed-tools: Bash(python3 .claude/hooks/memory.py:*)
---
Run `python3 .claude/hooks/memory.py note --kind forget "$ARGUMENTS"`. Reply with one line. Tell the user it takes effect after `/dream`; to delete a whole past session, delete its file under `.claude/memory/rollout_summaries/` and run `/dream`.
