---
description: Turn persistent mode on (agent keeps working on registered follow-ups until put to sleep)
allowed-tools: Bash(python3 .claude/hooks/persist.py:*)
---
Run `python3 .claude/hooks/persist.py on $ARGUMENTS` and report the resulting limits in one line.

Persistent mode is now on. The proactivity instructions in `.claude/persistent/persistent_mode.md` apply from now on. Read that file, register a follow-up with the CLI whenever the work you just finished has an open loop worth monitoring, and stay within the scope I authorized.
