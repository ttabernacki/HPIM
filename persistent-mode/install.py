#!/usr/bin/env python3
"""Install persistent mode (and the optional cross-session memory layer) for Claude Code.

  python3 install.py --project /path/to/repo        # into <repo>/.claude, shared with the team
  python3 install.py --project . --local            # hooks in settings.local.json (personal, not committed)
  python3 install.py --user                         # into ~/.claude, active in every project
  python3 install.py --project . --no-memory        # persistent mode only
  python3 install.py --project . --dry-run          # show what would change
  python3 install.py --project . --check            # verify an existing install
  python3 install.py --project . --uninstall        # remove exactly what was installed

  python3 install.py --skill                        # system-wide SKILL in ~/.claude/skills/persistent-mode
  python3 install.py --skill --activate             # ...and the user-wide hooks and commands in one step
  python3 install.py --skill --uninstall            # remove the skill (hooks: install.py --user --uninstall)

Safe to re-run. Existing settings and hooks are merged, never replaced. Files you edited
after installing are never overwritten or deleted without --force. Python 3.8+, stdlib only.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
VERSION = "1.0.0"
MANIFEST = "persistent-mode.manifest.json"
SKILL_NAME = "persistent-mode"
SKILL_MANIFEST = ".skill-manifest.json"

PERSIST_FILES = ["hooks/persist.py", "persistent/persistent_mode.md", "commands/persist.md", "commands/sleep.md"]
MEMORY_FILES = ["hooks/memory.py", "commands/dream.md", "commands/remember.md", "commands/forget.md",
                "agents/memory-writer.md", "agents/memory-consolidator.md"]
RUNTIME_TOKENS = ("{{CLI}}",)        # substituted by the hooks at run time, kept verbatim here

# (event, matcher, script, hook subcommand, timeout seconds)
PERSIST_HOOKS = [
    ("SessionStart", None, "persist.py", "session-start", None),
    ("UserPromptSubmit", None, "persist.py", "prompt-submit", None),
    ("Stop", None, "persist.py", "stop", 300),
    ("PreToolUse", "*", "persist.py", "guard", None),
]
MEMORY_HOOKS = [
    ("SessionStart", None, "memory.py", "session-start", None),
    ("Stop", None, "memory.py", "touch", None),
    ("SessionEnd", None, "memory.py", "touch", None),
]


class Fail(Exception):
    pass


# ------------------------------------------------------------------ helpers

def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def read_json(path):
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text() or "{}")
    except json.JSONDecodeError as e:
        raise Fail(f"{path} is not valid JSON ({e}); fix or move it, nothing was changed")
    if not isinstance(data, dict):
        raise Fail(f"{path} must contain a JSON object")
    return data


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


class Plan:
    """Collects actions so --dry-run and real runs share one code path."""

    def __init__(self, dry):
        self.dry = dry
        self.lines = []
        self.warnings = []

    def do(self, verb, what, fn=None):
        self.lines.append(f"  {verb:<10} {what}")
        if not self.dry and fn:
            fn()

    def warn(self, msg):
        self.warnings.append(msg)


class Target:
    def __init__(self, args):
        if args.user:
            base = Path(args.claude_dir or os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
            self.scope = "user"
            self.base = base.expanduser().resolve()
            self.settings = self.base / "settings.json"
            self.hooks_ref = str(self.base / "hooks")           # absolute: works from any project
            self.persistent_ref = str(self.base / "persistent")
            self.cmd_path = lambda script: '"' + str(self.base / "hooks" / script) + '"'
        else:
            root = Path(args.project or ".").expanduser().resolve()
            if not root.is_dir():
                raise Fail(f"project directory {root} does not exist")
            self.scope = "project"
            self.root = root
            self.base = Path(args.claude_dir).resolve() if args.claude_dir else root / ".claude"
            self.settings = self.base / ("settings.local.json" if args.local else "settings.json")
            self.hooks_ref = ".claude/hooks"
            self.persistent_ref = ".claude/persistent"
            self.cmd_path = lambda script: '"$CLAUDE_PROJECT_DIR/.claude/hooks/' + script + '"'
        self.py = args.python or ("python3" if shutil.which("python3") else "python")
        self.manifest_path = self.base / MANIFEST

    def tokens(self):
        return {"{{PY}}": self.py, "{{HOOKS}}": self.hooks_ref, "{{PERSISTENT}}": self.persistent_ref}

    def hook_command(self, script, sub):
        return f"{self.py} {self.cmd_path(script)} hook {sub}"


def render(text, tokens):
    for k, v in tokens.items():
        text = text.replace(k, v)
    left = [t for t in _find_tokens(text) if t not in RUNTIME_TOKENS]
    if left:
        raise Fail("unresolved template tokens in source: " + ", ".join(sorted(set(left))))
    return text


def _find_tokens(text):
    import re
    return re.findall(r"\{\{[A-Z_]+\}\}", text)


def wanted_files(memory):
    return PERSIST_FILES + (MEMORY_FILES if memory else [])


def wanted_hooks(memory):
    return PERSIST_HOOKS + (MEMORY_HOOKS if memory else [])


# ------------------------------------------------------------------ settings merge

def command_present(groups, command):
    return any(h.get("command") == command for g in groups for h in g.get("hooks", []))


def merge_hooks(settings, tgt, memory, plan):
    hooks = settings.setdefault("hooks", {})
    added = []
    for event, matcher, script, sub, timeout in wanted_hooks(memory):
        command = tgt.hook_command(script, sub)
        groups = hooks.setdefault(event, [])
        if command_present(groups, command):
            continue
        entry = {"type": "command", "command": command}
        if timeout:
            entry["timeout"] = timeout
        group = {"hooks": [entry]}
        if matcher:
            group = {"matcher": matcher, **group}
        groups.append(group)
        added.append(command)
        plan.lines.append(f"  {'hook':<10} {event}: {script} {sub}")
    return added


def strip_hooks(settings, commands):
    hooks = settings.get("hooks", {})
    removed = 0
    for event in list(hooks):
        kept = []
        for g in hooks[event]:
            g["hooks"] = [h for h in g.get("hooks", []) if h.get("command") not in commands]
            removed += 0
            if g["hooks"]:
                kept.append(g)
        hooks[event] = kept
        if not kept:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)


# ------------------------------------------------------------------ install / uninstall

def load_manifest(tgt):
    return read_json(tgt.manifest_path) if tgt.manifest_path.exists() else {}


def install(args):
    tgt = Target(args)
    plan = Plan(args.dry_run)
    memory = not args.no_memory
    old = load_manifest(tgt)
    old_files = old.get("files", {})
    tokens = tgt.tokens()
    new_files = {}

    print(f"{'Would install' if args.dry_run else 'Installing'} persistent mode "
          f"{'+ memory ' if memory else ''}into {tgt.base}  ({tgt.scope} scope, settings: {tgt.settings.name})")

    if not (SRC / "hooks" / "persist.py").exists():
        raise Fail(f"package sources not found at {SRC}")

    if tgt.scope == "project" and not args.claude_dir:
        user_base = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
        if (user_base / MANIFEST).exists() and user_base.resolve() != tgt.base.resolve():
            plan.warn(f"persistent mode is ALSO installed user-wide ({user_base}). Installing it in this project too "
                      f"would run every hook twice. Remove one: install.py --uninstall (project) or install.py --user --uninstall.")

    for rel in wanted_files(memory):
        src = SRC / rel
        raw = src.read_bytes()
        content = raw if rel.endswith(".py") else render(raw.decode(), tokens).encode()
        digest = sha(content)
        dest = tgt.base / rel
        new_files[rel] = digest
        if not dest.exists():
            plan.do("create", str(rel), lambda d=dest, c=content: _write(d, c, rel))
        elif sha(dest.read_bytes()) == digest:
            continue
        elif old_files.get(rel) == sha(dest.read_bytes()):
            plan.do("update", str(rel), lambda d=dest, c=content: _write(d, c, rel))
        elif args.force:
            plan.do("overwrite", f"{rel} (backup: {dest.name}.pre-persistent-mode)",
                    lambda d=dest, c=content: (shutil.copy2(d, str(d) + ".pre-persistent-mode"), _write(d, c, rel)))
        else:
            plan.warn(f"skipped {rel}: a different file already exists (yours or edited). Use --force to overwrite (a backup is kept).")
            new_files.pop(rel)

    settings = read_json(tgt.settings)
    before = json.dumps(settings, sort_keys=True)
    commands_before = set(old.get("hooks", []))
    added = merge_hooks(settings, tgt, memory, plan)
    if json.dumps(settings, sort_keys=True) != before:
        def save_settings():
            bak = tgt.settings.with_name(tgt.settings.name + ".pre-persistent-mode")
            if tgt.settings.exists() and not bak.exists():
                shutil.copy2(tgt.settings, bak)
            write_json(tgt.settings, settings)
        plan.do("settings", f"merge hooks into {tgt.settings.name}", save_settings)

    all_hooks = sorted(commands_before | {tgt.hook_command(s, sub) for _, _, s, sub, _ in wanted_hooks(memory)})
    manifest = {"version": VERSION, "scope": tgt.scope, "memory": memory, "files": {**old_files, **new_files}, "hooks": all_hooks}
    if manifest != old:
        plan.do("manifest", MANIFEST, lambda: write_json(tgt.manifest_path, manifest))

    for line in plan.lines:
        print(line)
    if not plan.lines:
        print("  already up to date")
    for w in plan.warnings:
        print("  WARNING:", w, file=sys.stderr)
    if not args.dry_run:
        print(next_steps(tgt, memory))
    return 0


def _write(dest, content, rel):
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)
    if rel.endswith(".py"):
        dest.chmod(dest.stat().st_mode | 0o111)


def next_steps(tgt, memory):
    lines = ["", "Done. Restart Claude Code in the project (hooks load at session start), then:",
             "  /persist        turn persistent mode on   (/persist --max-hours 2 --max-per-hour 10)",
             "  /sleep          put it to sleep"]
    if memory:
        lines += ["  /dream          distill past sessions into memory", "  /remember, /forget   edit memory"]
    lines.append("State is per project in .claude/persistent/ and .claude/memory/ (both git-ignored automatically).")
    return "\n".join(lines)


def uninstall(args):
    tgt = Target(args)
    plan = Plan(args.dry_run)
    man = load_manifest(tgt)
    if not man:
        print(f"Nothing to uninstall: no {MANIFEST} in {tgt.base}")
        return 0
    print(f"{'Would remove' if args.dry_run else 'Removing'} persistent mode from {tgt.base}")
    for rel, digest in man.get("files", {}).items():
        dest = tgt.base / rel
        if not dest.exists():
            continue
        if sha(dest.read_bytes()) == digest or args.force:
            plan.do("remove", rel, dest.unlink)
        else:
            plan.warn(f"kept {rel}: modified since install (use --force to delete)")
    settings = read_json(tgt.settings)
    if settings.get("hooks"):
        snapshot = json.dumps(settings, sort_keys=True)
        strip_hooks(settings, set(man.get("hooks", [])))
        if json.dumps(settings, sort_keys=True) != snapshot:
            plan.do("settings", f"remove our hooks from {tgt.settings.name}", lambda: write_json(tgt.settings, settings))
    if args.purge:
        for name in ("persistent/state.json", "persistent/state.json.lock", "persistent/.gitignore"):
            p = tgt.base / name
            if p.exists():
                plan.do("purge", name, p.unlink)
        mem = tgt.base / "memory"
        if mem.exists():
            plan.do("purge", "memory/ (generated memory)", lambda: shutil.rmtree(mem))
    plan.do("remove", MANIFEST, lambda: tgt.manifest_path.unlink())
    if not args.dry_run:
        for d in ("hooks", "persistent", "commands", "agents"):
            p = tgt.base / d
            if p.is_dir() and not any(p.iterdir()):
                p.rmdir()
    for line in plan.lines:
        print(line)
    for w in plan.warnings:
        print("  WARNING:", w, file=sys.stderr)
    if not args.purge:
        print("  (kept your data: .claude/persistent/state.json and .claude/memory/; use --purge to delete)")
    return 0


def check(args):
    tgt = Target(args)
    man = load_manifest(tgt)
    problems = []
    if not man:
        problems.append(f"no {MANIFEST}: not installed by this installer")
    else:
        for rel, digest in man.get("files", {}).items():
            p = tgt.base / rel
            if not p.exists():
                problems.append(f"missing file {rel}")
            elif sha(p.read_bytes()) != digest:
                problems.append(f"modified since install: {rel} (fine if intentional)")
        settings = read_json(tgt.settings)
        registered = {h.get("command") for groups in settings.get("hooks", {}).values() for g in groups for h in g.get("hooks", [])}
        for c in man.get("hooks", []):
            if c not in registered:
                problems.append(f"hook not registered in {tgt.settings.name}: {c}")
    py = tgt.py
    if not shutil.which(py):
        problems.append(f"interpreter '{py}' not on PATH")
    else:                                   # smoke test the real script in a scratch project
        script = tgt.base / "hooks" / "persist.py"
        if script.exists():
            with tempfile.TemporaryDirectory() as tmp:
                env = dict(os.environ, CLAUDE_PROJECT_DIR=tmp)
                for argv in ([py, str(script), "status"], [py, str(script), "hook", "session-start"]):
                    r = subprocess.run(argv, env=env, input="{}", capture_output=True, text=True)
                    if r.returncode != 0:
                        problems.append(f"{' '.join(argv[1:])} exited {r.returncode}: {r.stderr.strip()[:120]}")
    hard = [p for p in problems if not p.startswith("modified since install")]
    for p in problems:
        print(("  problem: " if p in hard else "  note:    ") + p)
    print("OK" if not hard else "FAILED")
    return 1 if hard else 0


# ------------------------------------------------------------------ skill (system-wide)

def skill_context(args):
    if args.project:
        root = Path(args.project).expanduser().resolve()
        base = Path(args.claude_dir).resolve() if args.claude_dir else root / ".claude"
        scope_args = f'--project "{root}"'
        if args.claude_dir:
            scope_args += f' --claude-dir "{base}"'
    else:
        base = Path(args.claude_dir or os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser().resolve()
        scope_args = "--user" + (f' --claude-dir "{base}"' if args.claude_dir else "")
    py = args.python or ("python3" if shutil.which("python3") else "python")
    skill_dir = base / "skills" / SKILL_NAME
    tokens = {"{{PY}}": py, "{{SKILL_DIR}}": str(skill_dir), "{{CLAUDE_DIR}}": str(base), "{{SCOPE_ARGS}}": scope_args}
    return base, skill_dir, tokens


def skill_payload(tokens):
    """{relative path: bytes} of everything that makes the skill self-contained."""
    tpl = HERE / "skill" / "SKILL.md"
    if not tpl.exists():
        raise Fail(f"skill template not found at {tpl}")
    files = {"SKILL.md": render(tpl.read_text(), tokens).encode(), "skill/SKILL.md": tpl.read_bytes()}
    for name in ("install.py", "README.md"):
        if (HERE / name).exists():
            files[name] = (HERE / name).read_bytes()
    for f in sorted(SRC.rglob("*")):
        if f.is_file() and "__pycache__" not in f.parts:
            files["src/" + f.relative_to(SRC).as_posix()] = f.read_bytes()
    return files


def install_skill(args):
    base, skill_dir, tokens = skill_context(args)
    plan = Plan(args.dry_run)
    manifest_path = skill_dir / SKILL_MANIFEST
    old = read_json(manifest_path) if manifest_path.exists() else {}
    old_files = old.get("files", {})
    print(f"{'Would install' if args.dry_run else 'Installing'} the persistent-mode skill into {skill_dir}")
    new_files = {}
    for rel, content in skill_payload(tokens).items():
        digest, dest = sha(content), skill_dir / rel
        new_files[rel] = digest
        if not dest.exists():
            plan.do("create", rel, lambda d=dest, c=content, r=rel: _write(d, c, r))
        elif sha(dest.read_bytes()) == digest:
            continue
        elif old_files.get(rel) == sha(dest.read_bytes()) or args.force:
            plan.do("update", rel, lambda d=dest, c=content, r=rel: _write(d, c, r))
        else:
            plan.warn(f"skipped {rel}: modified since install (use --force to overwrite)")
            new_files.pop(rel)
    manifest = {"version": VERSION, "files": {**old_files, **new_files}}
    if manifest != old:
        plan.do("manifest", SKILL_MANIFEST, lambda: write_json(manifest_path, manifest))
    for line in plan.lines:
        print(line)
    if not plan.lines:
        print("  already up to date")
    for w in plan.warnings:
        print("  WARNING:", w, file=sys.stderr)
    if args.activate:
        print()
        rc = install(args)
        return rc
    if not args.dry_run:
        print("\nSkill installed. It can now be used from any project: ask Claude to \"use persistent mode\", or\n"
              "have it follow SKILL.md, which installs the hooks the first time (with your OK).\n"
              "To install the hooks now instead: install.py --skill --activate  (or --user).")
    return 0


def uninstall_skill(args):
    base, skill_dir, _ = skill_context(args)
    plan = Plan(args.dry_run)
    manifest_path = skill_dir / SKILL_MANIFEST
    if not manifest_path.exists():
        print(f"Nothing to uninstall: no {SKILL_MANIFEST} in {skill_dir}")
        return 0
    man = read_json(manifest_path)
    print(f"{'Would remove' if args.dry_run else 'Removing'} the persistent-mode skill from {skill_dir}")
    for rel, digest in man.get("files", {}).items():
        dest = skill_dir / rel
        if not dest.exists():
            continue
        if sha(dest.read_bytes()) == digest or args.force:
            plan.do("remove", rel, dest.unlink)
        else:
            plan.warn(f"kept {rel}: modified since install (use --force to delete)")
    plan.do("remove", SKILL_MANIFEST, manifest_path.unlink)
    if not args.dry_run:
        for d in sorted((p for p in skill_dir.rglob("*") if p.is_dir()), key=lambda p: -len(p.parts)):
            if not any(d.iterdir()):
                d.rmdir()
        if skill_dir.exists() and not any(skill_dir.iterdir()):
            skill_dir.rmdir()
    for line in plan.lines:
        print(line)
    for w in plan.warnings:
        print("  WARNING:", w, file=sys.stderr)
    print("  (hooks and commands are separate: install.py --user --uninstall)")
    return 0


def check_skill(args):
    base, skill_dir, tokens = skill_context(args)
    problems = []
    mp = skill_dir / SKILL_MANIFEST
    if not mp.exists():
        problems.append(f"no {SKILL_MANIFEST} in {skill_dir}: skill not installed")
    else:
        for rel, digest in read_json(mp).get("files", {}).items():
            p = skill_dir / rel
            if not p.exists():
                problems.append(f"missing file {rel}")
            elif sha(p.read_bytes()) != digest:
                problems.append(f"modified since install: {rel} (fine if intentional)")
        text = (skill_dir / "SKILL.md").read_text() if (skill_dir / "SKILL.md").exists() else ""
        if not text.startswith("---\nname: " + SKILL_NAME + "\n"):
            problems.append("SKILL.md frontmatter is missing or has the wrong name")
        if "{{" in text:
            problems.append("SKILL.md has unresolved template tokens")
    hard = [p for p in problems if not p.startswith("modified since install")]
    for p in problems:
        print(("  problem: " if p in hard else "  note:    ") + p)
    print("OK" if not hard else "FAILED")
    return 1 if hard else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    scope = ap.add_mutually_exclusive_group()
    scope.add_argument("--project", metavar="DIR", help="install into DIR/.claude (default: current directory)")
    scope.add_argument("--user", action="store_true", help="install into ~/.claude (all projects)")
    ap.add_argument("--local", action="store_true", help="project scope: write hooks to settings.local.json (personal, not committed)")
    ap.add_argument("--no-memory", action="store_true", help="skip the cross-session memory layer")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="overwrite/delete files even if they differ from what was installed")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--purge", action="store_true", help="with --uninstall: also delete state and generated memory")
    ap.add_argument("--check", action="store_true", help="verify an existing installation")
    ap.add_argument("--skill", action="store_true", help="install/uninstall/check the self-contained SKILL (default scope: user-wide)")
    ap.add_argument("--activate", action="store_true", help="with --skill: also install the hooks and commands")
    ap.add_argument("--python", help="interpreter name to put in hook commands (default: python3)")
    ap.add_argument("--claude-dir", help="override the .claude directory (advanced/testing)")
    ap.add_argument("--version", action="version", version=VERSION)
    args = ap.parse_args(argv)
    if args.skill and not args.project:
        args.user = True                       # a skill is system-wide unless a project is named
    elif not args.user and not args.project:
        args.project = "."
    if args.activate and not args.skill:
        ap.error("--activate only applies with --skill")
    if args.local and args.user:
        ap.error("--local only applies to project scope")
    try:
        if args.skill:
            if args.check:
                return check_skill(args)
            return uninstall_skill(args) if args.uninstall else install_skill(args)
        if args.check:
            return check(args)
        return uninstall(args) if args.uninstall else install(args)
    except Fail as e:
        print("error:", e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
