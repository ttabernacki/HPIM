# Persistent mode for Claude Code

An agent that keeps working after its final answer: it registers follow-ups (a target, a stopping condition, an authorized scope, a next check), gets re-prompted when one is due, and stays read-only unless you approve. A re-creation of OpenAI Codex's unreleased "Persistent mode" (prompt: `codex-rs/core/templates/persistent_mode.md`), plus an optional Codex-style cross-session memory layer.

Stdlib-only Python 3.8+, no dependencies, macOS/Linux (file locking is a no-op on Windows).

## Install

```bash
git clone --depth 1 -b persistent-mode https://github.com/ttabernacki/HPIM.git
python3 HPIM/persistent-mode/install.py --project /path/to/your/repo
```

| Goal | Command |
|---|---|
| Into one repo, shared with the team (`.claude/settings.json`) | `install.py --project /path/to/repo` |
| Into one repo, just for you (`.claude/settings.local.json`) | `install.py --project /path/to/repo --local` |
| For every project on this machine (`~/.claude`) | `install.py --user` |
| Persistent mode only, no memory layer | add `--no-memory` |
| See what would change first | add `--dry-run` |
| Verify an install (files, hooks, smoke test) | `install.py --project /path/to/repo --check` |
| Remove it | `install.py --project /path/to/repo --uninstall` (`--purge` also deletes state and generated memory) |

Then **restart Claude Code** in the project: hooks load at session start.

The installer is safe to re-run and to run on a repo that already has Claude Code settings:
- Hooks are **merged** into your existing `settings.json`; your other settings and hooks are untouched. The first time it changes a settings file it keeps a `*.pre-persistent-mode` copy.
- It never overwrites a file that differs from what it installed. It skips it and warns. `--force` overwrites (keeping a `.pre-persistent-mode` backup).
- Re-running upgrades files you have not edited, and protects the ones you have.
- Uninstall removes exactly what was installed and leaves anything you modified.
- Slash commands are named `/persist`, `/sleep`, `/dream`, `/remember`, `/forget`. If one collides with an existing command of yours, the installer skips it and tells you.

### As a system-wide skill

```bash
python3 HPIM/persistent-mode/install.py --skill               # skill only: ~/.claude/skills/persistent-mode/
python3 HPIM/persistent-mode/install.py --skill --activate    # skill + user-wide hooks and commands, one step
```

The skill is a self-contained bundle (SKILL.md, the installer, all sources), so it works offline and in every project. Ask Claude to "keep working until CI is green" or "use persistent mode" and it follows SKILL.md: it checks for the hooks, offers to install them the first time (previewing with `--dry-run` and asking you first), turns the mode on for the project, and applies the rules. Hooks load at session start, so after the first install you restart Claude Code once.

- `--skill --check` verifies it; `--skill --uninstall` removes the skill (the hooks are separate: `--user --uninstall`).
- The hooks do nothing in a project until persistent mode is turned on there, so a user-wide install is inert everywhere else.
- Install user-wide **or** per project, not both: every hook would run twice. The installer warns when it detects this.

## Use

```
/persist                      turn on (defaults: at most 20 continuations/hour, 12 hours)
/persist --max-hours 2 --max-per-hour 10
/persist --max-hours 1  Watch the deploy and tell me when it is healthy   # text after the flags is the task
/sleep                        stop all auto-continuation (follow-ups are kept)
```

While on, when the agent tries to stop and a follow-up exists:

1. **Checks under ~3 minutes away** are waited out inside the Stop hook, then the agent is re-prompted.
2. **Longer waits**: the hook asks once for a scheduled wake (`ScheduleWakeup`, a one-shot `CronCreate`, or `send_later`) with the prompt `[persistent-wake] check due follow-ups`, then lets the turn end.
3. **Autonomous turns are read-only.** A `PreToolUse` guard denies edits, mutating shell commands and write-verb MCP tools; the agent must describe the action and wait for you. Typing anything yourself ends the autonomous phase.
4. **Caps** stop runaway loops (continuations per hour, total hours). `PushNotification` is deduped and rate-limited.

Optional memory layer (`/dream`, `/remember`, `/forget`): sessions are registered by hooks; `/dream` distills idle sessions into `.claude/memory/memory_summary.md` (two subagents, validation, git-diff based forgetting), which is injected at every session start. Secrets and patient-identifier patterns are redacted before anything is stored.

## What gets installed where

```
<claude dir>/                    (<repo>/.claude, or ~/.claude with --user)
  hooks/persist.py               state CLI + all persistent-mode hook handlers
  hooks/memory.py                memory layer (unless --no-memory)
  persistent/persistent_mode.md  the proactivity prompt (edit it to taste)
  commands/ persist.md sleep.md [dream.md remember.md forget.md]
  agents/   [memory-writer.md memory-consolidator.md]
  persistent-mode.manifest.json  what was installed, with hashes (for upgrade/uninstall)
  settings.json | settings.local.json   hooks merged in

<each project>/.claude/          per-project runtime state, created on first use
  persistent/state.json          mode, follow-ups, counters
  memory/                        generated memory (its own git repo)
```

State is always per project, even with `--user`. The scripts add their generated files to the project's local `.git/info/exclude`, so `git status` stays clean and your `.gitignore` is not modified. In a project that never runs `/persist`, the hooks do nothing and create nothing.

## Limits

- One persistent session per project: state is shared by every Claude Code session opened in the same directory.
- The Bash guard is a heuristic allowlist, not a sandbox.
- Wake scheduling relies on session-local schedulers, so a wake does not survive closing the session.
- Only the prompt template of Codex persistent mode is public; the harness around it (re-sampling, sleep/wake, reasoning-effort setting) is re-implemented here from press descriptions.

## Development

```
python3 -m unittest discover -s persistent-mode/tests -p 'test_*.py'   # 77 tests
```

`src/` is the source of truth. This repository installs its own copy into `.claude/` (`python3 persistent-mode/install.py --project . --force`), and a test fails if the two drift.
