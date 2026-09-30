---
description: Save something to memory (applied at the next /dream)
allowed-tools: Bash(python3 .claude/hooks/memory.py:*)
---
Run `python3 .claude/hooks/memory.py note --kind remember "$ARGUMENTS"` (write the note as a short standalone sentence stating the user's request faithfully). Reply with one line. Tell the user it takes effect after `/dream`.
