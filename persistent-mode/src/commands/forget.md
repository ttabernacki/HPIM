---
description: Remove something from memory (applied at the next /dream)
allowed-tools: Bash({{PY}} {{HOOKS}}/memory.py:*)
---
Run `{{PY}} {{HOOKS}}/memory.py note --kind forget "$ARGUMENTS"`. Reply with one line. Tell the user it takes effect after `/dream`; to delete a whole past session, delete its file under `.claude/memory/rollout_summaries/` and run `/dream`.
