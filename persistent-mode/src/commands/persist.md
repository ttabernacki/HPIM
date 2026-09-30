---
description: Turn persistent mode on (agent keeps working on registered follow-ups until put to sleep)
allowed-tools: Bash({{PY}} {{HOOKS}}/persist.py:*)
---
Turn persistent mode on for this project.

Arguments: `$ARGUMENTS`

1. Split the arguments. Leading options `--max-per-hour N` and `--max-hours H` (an em dash such as `—max-hours` is a typo for `--max-hours`) are limits. Everything else is the task to work on.
2. Run `{{PY}} {{HOOKS}}/persist.py on` followed by ONLY those limit options, and report the resulting limits in one line.
3. Read `{{PERSISTENT}}/persistent_mode.md`; its proactivity rules apply from now on. Register a follow-up with the CLI whenever finished work has an open loop worth monitoring, and stay within the scope I authorized.
4. If there is task text, start on it now.
