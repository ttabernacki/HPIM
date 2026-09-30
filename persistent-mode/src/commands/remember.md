---
description: Save something to memory (applied at the next /dream)
allowed-tools: Bash({{PY}} {{HOOKS}}/memory.py:*)
---
Run `{{PY}} {{HOOKS}}/memory.py note --kind remember "$ARGUMENTS"` (write the note as a short standalone sentence stating the user's request faithfully). Reply with one line. Tell the user it takes effect after `/dream`.
