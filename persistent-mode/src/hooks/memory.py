#!/usr/bin/env python3
"""Cross-session memory for Claude Code, modelled on Codex's two-phase memories.

Cheap capture happens in hooks (register sessions). Distillation is done by
subagents driven from /dream: phase 1 writes one rollout summary per idle session,
phase 2 consolidates summaries into memory_summary.md. This script holds every
mechanical step: registry, transcript extraction + redaction, workspace diff
(git baseline, so deletions propagate as forgetting), validation, notes.

Layout under .claude/memory/ (its own git repo, ignored by the outer repo):
  memory_summary.md              injected at every session start (<= 10,000 bytes)
  rollout_summaries/<slug>.md    phase-1 output, one per session
  extensions/ad_hoc/notes/*.md   /remember and /forget notes, applied by phase 2
  .registry.json                 session registry (git-ignored)
  phase2_workspace_diff.md       generated diff since last consolidation (git-ignored)
"""
import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

MAX_SUMMARY_BYTES = 10000
MIN_IDLE_DEFAULT = 6 * 3600
EXTRACT_CAP = 60000
SECTIONS = ["## User Profile", "## User preferences", "## General Tips",
            "## What's in Memory"]

SECRET_PATTERNS = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", "[REDACTED_SECRET]"),
    (r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{16,}", "[REDACTED_SECRET]"),
    (r"\bgh[pousr]_[A-Za-z0-9]{20,}", "[REDACTED_SECRET]"),
    (r"\bgithub_pat_[A-Za-z0-9_]{20,}", "[REDACTED_SECRET]"),
    (r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED_SECRET]"),
    (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", "[REDACTED_SECRET]"),
    (r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", "[REDACTED_SECRET]"),
    (r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{16,}", r"\1 [REDACTED_SECRET]"),
    (r"(?i)\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)(\s*[:=]\s*)[^\s'\"]{4,}",
     r"\1\2[REDACTED_SECRET]"),
    (r"(?i)([?&](?:token|key|sig|signature|access_token)=)[^&\s]+", r"\1[REDACTED_SECRET]"),
    (r"(://[^/\s:@]+:)[^/\s@]+@", r"\1[REDACTED_SECRET]@"),
    # patient identifiers (the user works in a clinical setting)
    (r"\b\d{3}-\d{2}-\d{4}\b", "[REDACTED_PHI]"),
    (r"(?i)\b(mrn|medical record (?:number|no\.?))(\s*[:#]?\s*)\d{5,}", r"\1\2[REDACTED_PHI]"),
]
_SECRET_RES = [(re.compile(p, re.S), r) for p, r in SECRET_PATTERNS]


def redact(text):
    for rx, rep in _SECRET_RES:
        text = rx.sub(rep, text)
    return text


# ---------------------------------------------------------------- paths

def project_dir():
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def git_exclude(patterns):
    """Keep generated files out of `git status` without touching the project's .gitignore:
    add them to the local-only .git/info/exclude (never committed). No-op outside git."""
    try:
        proj = project_dir()
        r = subprocess.run(["git", "-C", proj, "rev-parse", "--git-path", "info/exclude"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode != 0 or not r.stdout.strip():
            return
        path = r.stdout.strip()
        path = path if os.path.isabs(path) else os.path.join(proj, path)
        have = set(open(path).read().splitlines()) if os.path.exists(path) else set()
        missing = [p for p in patterns if p not in have]
        if missing:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a") as f:
                f.write(("" if not have or open(path).read().endswith("\n") else "\n") + "\n".join(missing) + "\n")
    except Exception:
        pass


def mem_dir():
    return os.path.join(project_dir(), ".claude", "memory")


def P(*parts):
    return os.path.join(mem_dir(), *parts)


def ensure_repo():
    git_exclude([".claude/memory/"])
    os.makedirs(P("rollout_summaries"), exist_ok=True)
    os.makedirs(P("extensions", "ad_hoc", "notes"), exist_ok=True)
    if not os.path.isdir(P(".git")):
        git("init", "-q")
    ign = P(".gitignore")
    if not os.path.exists(ign):
        with open(ign, "w") as f:
            f.write(".registry.json\nphase2_workspace_diff.md\n")


def git(*args, check=True):
    cmd = ["git", "-C", mem_dir(), "-c", "user.name=memory", "-c", "user.email=memory@local",
           "-c", "core.autocrlf=false", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=check).stdout


# ------------------------------------------------------------- registry

def load_registry():
    try:
        with open(P(".registry.json")) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_registry(reg):
    if not os.path.isdir(mem_dir()):
        git_exclude([".claude/memory/"])
    os.makedirs(mem_dir(), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=mem_dir(), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(reg, f, indent=2)
    os.replace(tmp, P(".registry.json"))


def touch(evt):
    sid = evt.get("session_id")
    if not sid:
        return
    reg = load_registry()
    e = reg.get(sid, {"status": "pending"})
    e.update(transcript_path=evt.get("transcript_path") or e.get("transcript_path", ""),
             cwd=evt.get("cwd") or e.get("cwd", ""), ended_at=time.time())
    if e["status"] in ("done", "skipped"):
        e["status"] = "pending"  # resumed after consolidation: eligible again
    reg[sid] = e
    save_registry(reg)


def min_idle():
    return int(os.environ.get("PERSIST_MEMORY_MIN_IDLE", MIN_IDLE_DEFAULT))


def eligible(reg, idle, now=None):
    now = now or time.time()
    return {sid: e for sid, e in reg.items()
            if e["status"] == "pending" and now - e["ended_at"] >= idle
            and e.get("transcript_path") and os.path.exists(e["transcript_path"])}


# ----------------------------------------------------------- extraction

def _text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text":
            out.append(b.get("text", ""))
    return "\n".join(out)


def _clip(s, n):
    s = s.strip()
    return s if len(s) <= n else s[:n] + f" ...[+{len(s) - n} chars]"


def extract_transcript(path):
    """Condensed, redacted view. User text is primary evidence, so it is kept fullest."""
    lines = []
    i = 0
    with open(path) as f:
        for raw in f:
            try:
                d = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = d.get("type")
            m = d.get("message") or {}
            ts = (d.get("timestamp") or "")[:19]
            if t == "user" and not d.get("isSidechain"):
                c = m.get("content")
                if isinstance(c, list):
                    if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                        for b in c:
                            if isinstance(b, dict) and b.get("is_error"):
                                bc = b.get("content")
                                lines.append("[tool-error] " + _clip(bc if isinstance(bc, str) else _text_of(bc), 300))
                        continue
                text = _text_of(c)
                if text.strip():
                    i += 1
                    lines.append(f"[USER #{i} {ts}] {_clip(text, 2500)}")
            elif t == "assistant" and not d.get("isSidechain"):
                for b in m.get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text" and b.get("text", "").strip():
                        lines.append(f"[ASSISTANT] {_clip(b['text'], 1200)}")
                    elif b.get("type") == "tool_use":
                        inp = json.dumps(b.get("input", {}), ensure_ascii=False)
                        lines.append(f"[TOOL {b.get('name')}] {_clip(inp, 200)}")
    out = redact("\n".join(lines))
    if len(out) > EXTRACT_CAP:
        half = EXTRACT_CAP // 2
        out = out[:half] + "\n...[middle of session omitted]...\n" + out[-half:]
    return out


# ---------------------------------------------------------------- hooks

READ_PATH = """## Memory

Use the injected MEMORY_SUMMARY as historical context: apply the user's actual
preferences, corrections, decisions, and supported task scope. Its exact rollout,
source, pull-request, discussion, and document pointers can guide independently
useful work without an extra lookup merely to rediscover them. Read a matching
rollout under `.claude/memory/rollout_summaries/` when its additional evidence,
wording, chronology, or uncertainty could change your answer; otherwise do not
retrieve history speculatively. Search selectively when a genuinely needed route
is missing.

Memory is not proof of current behavior. For consequential or changeable claims,
use judgment about drift, verification cost, and harm; inspect the actual owning
source when warranted and acknowledge material uncertainty. Follow current
instructions and cite only memory actually used, never in pull requests. Update
memory only when the user explicitly asks: for an explicit remember, forget, or
correction request, run `{cli} note --kind
remember|forget|correct "<the requested addition, deletion, or correction>"`. Do
not edit generated memory files directly; consolidation applies these notes.

When a rollout summary informs the answer, end the final reply with one line
outside code fences: `memory used: rollout_summaries/<file>.md:<line range>`. Do
not cite memory_summary.md.

========= MEMORY_SUMMARY BEGINS =========
{summary}
========= MEMORY_SUMMARY ENDS =========
"""


def self_cli():
    py = "python3" if shutil.which("python3") else "python"
    return py + " " + shlex.quote(os.path.abspath(__file__))


def hook_session_start(evt):
    try:
        with open(P("memory_summary.md"), "rb") as f:
            summary = f.read(MAX_SUMMARY_BYTES).decode("utf-8", "ignore")
    except FileNotFoundError:
        summary = ""
    if summary.strip():
        print(READ_PATH.replace("{cli}", self_cli()).replace("{summary}", summary.strip()))
    n = len(eligible(load_registry(), min_idle()))
    if n:
        print(f"\n({n} past session(s) not yet distilled into memory; run /dream to consolidate.)")


# ------------------------------------------------------------------ CLI

def cmd_pending(a):
    idle = 0 if a.all else min_idle()
    for sid, e in sorted(eligible(load_registry(), idle).items(), key=lambda kv: kv[1]["ended_at"]):
        print(json.dumps({"session_id": sid, "cwd": e["cwd"], "ended_at": int(e["ended_at"])}))


def cmd_extract(a):
    e = load_registry().get(a.session_id)
    if not e:
        sys.exit(f"unknown session {a.session_id}")
    print(f"thread_id: {a.session_id}\ncwd: {e['cwd']}\n"
          f"updated_at: {time.strftime('%Y-%m-%d', time.gmtime(e['ended_at']))}\n---")
    print(extract_transcript(e["transcript_path"]))


def cmd_finish(a):
    ensure_repo()
    reg = load_registry()
    if a.session_id not in reg:
        sys.exit(f"unknown session {a.session_id}")
    if a.noop:
        reg[a.session_id]["status"] = "skipped"
    else:
        if not a.slug or not re.fullmatch(r"[a-z0-9_\-]{1,80}", a.slug):
            sys.exit("--slug must be lowercase [a-z0-9_-], <= 80 chars")
        path = P("rollout_summaries", a.slug + ".md")
        if not os.path.exists(path):
            sys.exit(f"missing {path}")
        with open(path) as f:
            body = f.read()
        if a.session_id not in body:
            sys.exit("summary must contain the exact thread_id line")
        with open(path, "w") as f:
            f.write(redact(body))
        reg[a.session_id]["status"] = "done"
        reg[a.session_id]["slug"] = a.slug
    save_registry(reg)
    print(f"{a.session_id}: {reg[a.session_id]['status']}")


def cmd_redact(a):
    for p in a.files:
        with open(p) as f:
            s = f.read()
        with open(p, "w") as f:
            f.write(redact(s))


def cmd_diff(a):
    ensure_repo()
    git("add", "-A")
    d = git("diff", "--cached", "--no-color", check=False)
    body = d if d.strip() else "(no changes since last consolidation)\n"
    with open(P("phase2_workspace_diff.md"), "w") as f:
        f.write(body)
    print(P("phase2_workspace_diff.md"), f"({len(body)} bytes)")


def cmd_baseline(a):
    ensure_repo()
    git("add", "-A")
    if git("status", "--porcelain").strip():
        git("commit", "-q", "-m", f"consolidation {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    print("baseline updated")


def validate_summary(text):
    problems = []
    if not text.startswith("v1\n"):
        problems.append("first line must be exactly `v1`")
    for sec in SECTIONS:
        if sec not in text:
            problems.append(f"missing section {sec}")
    if len(text.encode()) >= MAX_SUMMARY_BYTES:
        problems.append(f"must be under {MAX_SUMMARY_BYTES} UTF-8 bytes")
    if re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text):
        problems.append("contains an email address; memory must not hold contact identifiers")
    if redact(text) != text:
        problems.append("contains an unredacted secret/identifier pattern")
    files = set(re.findall(r"rollout_summaries/([A-Za-z0-9_\-]+\.md)", text))
    for fn in sorted(files):
        if not os.path.exists(P("rollout_summaries", fn)):
            problems.append(f"pointer to nonexistent rollout_summaries/{fn}")
    return problems


def cmd_validate(a):
    try:
        with open(P("memory_summary.md")) as f:
            text = f.read()
    except FileNotFoundError:
        sys.exit("memory_summary.md missing")
    probs = validate_summary(text)
    if probs:
        sys.exit("INVALID:\n- " + "\n- ".join(probs))
    print(f"valid ({len(text.encode())} bytes)")


def cmd_note(a):
    ensure_repo()
    ts = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
    path = P("extensions", "ad_hoc", "notes", f"{ts}-{a.kind}.md")
    with open(path, "w") as f:
        f.write(f"kind: {a.kind}\ncreated: {ts}\n\n{redact(a.text)}\n")
    print(path)


def build_cli():
    p = argparse.ArgumentParser(prog="memory.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("pending")
    s.add_argument("--all", action="store_true", help="ignore the idle threshold")
    s.set_defaults(fn=cmd_pending)
    s = sub.add_parser("extract")
    s.add_argument("session_id")
    s.set_defaults(fn=cmd_extract)
    s = sub.add_parser("finish")
    s.add_argument("session_id")
    s.add_argument("--slug")
    s.add_argument("--noop", action="store_true")
    s.set_defaults(fn=cmd_finish)
    s = sub.add_parser("redact")
    s.add_argument("files", nargs="+")
    s.set_defaults(fn=cmd_redact)
    sub.add_parser("diff").set_defaults(fn=cmd_diff)
    sub.add_parser("baseline").set_defaults(fn=cmd_baseline)
    sub.add_parser("validate").set_defaults(fn=cmd_validate)
    s = sub.add_parser("note")
    s.add_argument("--kind", choices=["remember", "forget", "correct"], required=True)
    s.add_argument("text")
    s.set_defaults(fn=cmd_note)
    return p


def main(argv):
    if len(argv) >= 2 and argv[0] == "hook":
        try:
            evt = json.load(sys.stdin)
        except json.JSONDecodeError:
            evt = {}
        {"touch": touch, "session-start": hook_session_start}[argv[1]](evt)
        return
    a = build_cli().parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main(sys.argv[1:])
