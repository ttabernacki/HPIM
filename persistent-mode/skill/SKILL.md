---
name: persistent-mode
description: Keep working after the final answer. Registers follow-ups (watch a deploy, CI run, long job, or any open loop) and re-prompts you until each is done or you are put to sleep, staying read-only unless the user approves. Use when the user asks you to keep working until something is done, watch/monitor/babysit something, check back later, keep going in the background, or says "persistent mode" or "/persist". Also handles first-time setup of the hooks that make it work. Not for ordinary one-shot tasks.
---

# Persistent mode

Persistent mode lets you keep working after you have delivered an answer. You register **follow-ups** (a target, a stopping condition, an authorized scope, a next check). A Stop hook re-prompts you when one is due, and while you are continuing on your own a guard denies anything that is not read-only. It is a re-creation of OpenAI Codex's unreleased "Persistent mode".

Use it only when the user asked for ongoing work: "keep going until CI is green", "watch this deploy", "check back on it". Do not turn it on for ordinary tasks. It never widens what you are allowed to do.

## 1. Check that the hooks are installed

```
{{PY}} "{{SKILL_DIR}}/install.py" {{SCOPE_ARGS}} --check
```

- Prints `OK`: the hooks are installed. Go to step 2.
- Otherwise: tell the user in a few lines what installing does (adds hooks and the `/persist`, `/sleep`, `/dream`, `/remember`, `/forget` commands under `{{CLAUDE_DIR}}`, merged into their existing settings, nothing overwritten; the hooks do nothing in any project until persistent mode is turned on there). Preview with `--dry-run`, and once they agree run:

  ```
  {{PY}} "{{SKILL_DIR}}/install.py" {{SCOPE_ARGS}}
  ```

  Hooks load only at session start. After installing, tell the user to **restart Claude Code and ask again**. Do not pretend persistent mode works in this session.

## 2. Turn it on for this project

```
{{PY}} "{{CLAUDE_DIR}}/hooks/persist.py" on [--max-hours H] [--max-per-hour N]
```

Defaults are 12 hours and 20 continuations per hour. For a long unattended watch, suggest tighter caps. Report the resulting limits in one line.

## 3. Rules while it is on

Read `{{SKILL_DIR}}/src/persistent/persistent_mode.md` now and follow it. This session started before it was turned on, so it was not injected automatically. (In that file, the CLI placeholder stands for the CLI command defined in step 4.) In short:

- After your final answer, when you are continued with no new user message, look for follow-ups that directly support the finished work: close an open loop, establish an awaited result, verify a change took effect. Do not invent unrelated work.
- Before starting one, define its scope, the outcome, the evidence, and a stopping condition. Register it. Keep going until the outcome is established, the user cancels, it is no longer relevant, or you need input or authorization. "Still pending" is not done.
- Check at a proportionate cadence (often 1-3 minutes for active work, backing off). When the hook asks for a scheduled wake, schedule it with the exact prompt it gives, then end your turn quietly.
- Stay quiet between meaningful changes. Report the outcome, a real blocker, or something that needs the user. Lead with the finding. Do not narrate bookkeeping or announce "follow-up tasks".
- Only safe, non-mutating follow-ups within the scope the user authorized. Anything that needs new authority or changes external state: describe it and wait for approval.

## 4. Registering and finishing follow-ups

```
CLI="{{PY}} {{CLAUDE_DIR}}/hooks/persist.py"
$CLI add --target "<what>" --stop "<stopping condition>" --scope "<authorized scope>" [--state "<last known>"] [--next-in <seconds>]
$CLI update <id> --state "<observation>" [--next-in <seconds>]      # every check ends with update or done
$CLI done <id> --note "<outcome>"
$CLI cancel <id>
$CLI status
```

An `update` that changes nothing still resets the timer. Skip it and the same check comes straight back.

## 5. Stopping

`/sleep` (or `$CLI sleep`) stops all auto-continuation and keeps the follow-ups. The caps end it on their own. If the user types anything, the autonomous phase ends and you are in a normal conversation again.

## Notes

- State is per project (`.claude/persistent/state.json`) and is git-ignored automatically. One persistent session per project.
- Do not install this both user-wide and into a project: every hook would run twice. Remove one with `install.py --uninstall`.
- Details and limits: `{{SKILL_DIR}}/README.md`.
