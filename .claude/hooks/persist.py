#!/usr/bin/env python3
"""Persistent mode for Claude Code: state CLI plus hook handlers.

CLI:   persist.py on|sleep|status|add|update|done|cancel
Hooks: persist.py hook session-start|prompt-submit|stop|guard   (JSON on stdin)

Stdlib only. State is a single JSON file, written atomically.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import sys
import tempfile
import time

DEFAULT_LIMITS = {"max_continuations_per_hour": 20, "max_total_hours": 12}
MAX_INLINE_WAIT = int(os.environ.get("PERSIST_MAX_INLINE_WAIT", "170"))
DEFAULT_NEXT_IN = 120
WAKE_TAG = "[persistent-wake]"
NOTICE_DEDUPE_S = 3600     # identical notification suppressed for this long
NOTICE_MIN_GAP_S = 600     # autonomous continuations: at most one notification per gap


# --------------------------------------------------------------- state

def project_dir():
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def state_path():
    return os.path.join(project_dir(), ".claude", "persistent", "state.json")


def prompt_path():
    return os.path.join(project_dir(), ".claude", "persistent", "persistent_mode.md")


def fresh_state():
    return {"mode": "off", "autonomous": False, "started_at": None,
            "limits": dict(DEFAULT_LIMITS), "continuations": [],
            "next_id": 1, "followups": [],
            "wake_for": None, "notices": []}


def load():
    try:
        with open(state_path()) as f:
            st = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return fresh_state()
    base = fresh_state()
    base.update(st)
    return base


def save(st):
    p = state_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(st, f, indent=2)
    os.replace(tmp, p)


def active(st):
    return [f for f in st["followups"] if f["status"] == "active"]


def fmt_followup(f, now=None):
    now = now or time.time()
    due = int(f["next_check_at"] - now)
    when = "due now" if due <= 0 else f"due in {due}s"
    return (f"[{f['id']}] target: {f['target']}\n"
            f"    last state: {f.get('last_state') or '(none yet)'}\n"
            f"    stop when: {f['stop_condition']}\n"
            f"    scope: {f['scope']}\n"
            f"    next check: {when}")


# ----------------------------------------------------------------- CLI

def cmd_on(a):
    st = load()
    st["mode"] = "on"
    st["autonomous"] = False
    st["started_at"] = time.time()
    st["continuations"] = []
    st["limits"] = dict(DEFAULT_LIMITS)  # limits never carry over from an earlier run
    if a.max_per_hour:
        st["limits"]["max_continuations_per_hour"] = a.max_per_hour
    if a.max_hours:
        st["limits"]["max_total_hours"] = a.max_hours
    save(st)
    print("persistent mode: on", st["limits"])


def cmd_sleep(a):
    st = load()
    st["mode"] = "sleeping"
    st["autonomous"] = False
    save(st)
    print("persistent mode: sleeping (follow-ups kept, no auto-continuation)")


def cmd_status(a):
    st = load()
    print(f"mode: {st['mode']}  limits: {st['limits']}")
    for f in st["followups"]:
        if f["status"] == "active":
            print(fmt_followup(f))
        else:
            print(f"[{f['id']}] {f['status']}: {f['target']} -- {f.get('note', '')}")
    if not st["followups"]:
        print("no follow-ups")


def cmd_add(a):
    st = load()
    now = time.time()
    f = {"id": st["next_id"], "target": a.target, "stop_condition": a.stop,
         "scope": a.scope, "last_state": a.state or "", "status": "active",
         "created_at": now, "updated_at": now,
         "next_check_at": now + (DEFAULT_NEXT_IN if a.next_in is None else a.next_in)}
    st["next_id"] += 1
    st["followups"].append(f)
    save(st)
    print(f"added follow-up {f['id']}")


def find(st, fid):
    for f in st["followups"]:
        if f["id"] == fid:
            return f
    sys.exit(f"no follow-up {fid}")


def cmd_update(a):
    st = load()
    f = find(st, a.id)
    now = time.time()
    if a.state is not None:
        f["last_state"] = a.state
    if a.stop:
        f["stop_condition"] = a.stop
    f["next_check_at"] = now + (DEFAULT_NEXT_IN if a.next_in is None else a.next_in)
    f["updated_at"] = now
    save(st)
    print(f"updated follow-up {a.id}")


def cmd_finish(status):
    def run(a):
        st = load()
        f = find(st, a.id)
        f["status"] = status
        f["note"] = getattr(a, "note", "") or ""
        f["updated_at"] = time.time()
        save(st)
        print(f"follow-up {a.id}: {status}")
    return run


def build_cli():
    p = argparse.ArgumentParser(prog="persist.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("on")
    s.add_argument("--max-per-hour", type=int)
    s.add_argument("--max-hours", type=float)
    s.set_defaults(fn=cmd_on)
    sub.add_parser("sleep").set_defaults(fn=cmd_sleep)
    for name in ("status", "list"):
        sub.add_parser(name).set_defaults(fn=cmd_status)
    s = sub.add_parser("add")
    s.add_argument("--target", required=True)
    s.add_argument("--stop", required=True)
    s.add_argument("--scope", required=True)
    s.add_argument("--state")
    s.add_argument("--next-in", type=int)
    s.set_defaults(fn=cmd_add)
    s = sub.add_parser("update")
    s.add_argument("id", type=int)
    s.add_argument("--state")
    s.add_argument("--stop")
    s.add_argument("--next-in", type=int)
    s.set_defaults(fn=cmd_update)
    s = sub.add_parser("done")
    s.add_argument("id", type=int)
    s.add_argument("--note")
    s.set_defaults(fn=cmd_finish("done"))
    s = sub.add_parser("cancel")
    s.add_argument("id", type=int)
    s.set_defaults(fn=cmd_finish("cancelled"))
    return p


# --------------------------------------------------------------- hooks

def emit(obj):
    print(json.dumps(obj))


def hook_session_start(_evt):
    st = load()
    if st["mode"] != "on":
        return
    try:
        with open(prompt_path()) as f:
            text = f.read()
    except FileNotFoundError:
        return
    out = [text, "\n### Current follow-ups\n"]
    act = active(st)
    out.append("\n".join(fmt_followup(f) for f in act) if act else "none active")
    print("\n".join(out))


def hook_prompt_submit(evt):
    st = load()
    prompt = (evt.get("prompt") or "").lstrip()
    if prompt.startswith(WAKE_TAG) and st["mode"] == "on" and active(st):
        # A scheduled wake is not a user request: stay autonomous (guard on).
        st["autonomous"], st["wake_for"] = True, None
        save(st)
        now = time.time()
        print("Persistent mode wake. Registered follow-ups:\n"
              + "\n".join(fmt_followup(f, now) for f in active(st))
              + "\nCheck what is due (safe, non-mutating only), then update/done.")
        return
    if st["autonomous"]:
        st["autonomous"] = False
        save(st)


def hook_stop(_evt):
    st = load()
    if st["mode"] != "on":
        return
    now = time.time()
    lim = st["limits"]
    if st["started_at"] and now - st["started_at"] > lim["max_total_hours"] * 3600:
        st["mode"], st["autonomous"] = "sleeping", False
        save(st)
        emit({"systemMessage": "persistent mode: max_total_hours reached; going to sleep"})
        return
    st["continuations"] = [t for t in st["continuations"] if now - t < 3600]
    if len(st["continuations"]) >= lim["max_continuations_per_hour"]:
        st["autonomous"] = False
        save(st)
        emit({"systemMessage": "persistent mode: hourly continuation cap reached; stopping"})
        return
    act = active(st)
    if not act:
        st["autonomous"] = False
        save(st)
        return
    nxt = min(f["next_check_at"] for f in act)
    wait = nxt - now
    if wait > MAX_INLINE_WAIT:
        if st.get("wake_for") == nxt:
            # Wake already requested for this exact check time: let the turn end.
            st["autonomous"] = False
            save(st)
            return
        st["wake_for"] = nxt
        st["autonomous"] = True
        st["continuations"].append(now)
        save(st)
        secs = int(wait) + 5
        emit({"decision": "block", "reason":
              f"Persistent mode: the next check is {int(wait)}s away. Schedule a wake, "
              f"then end your turn without further output. Use ScheduleWakeup "
              f"(delaySeconds={secs}), or else a one-shot CronCreate (recurring=false) "
              f"about {secs}s from now, or else send_later (delay_minutes="
              f"{max(1, -(-secs // 60))}), with the prompt exactly: "
              f"\"{WAKE_TAG} check due follow-ups\"."})
        return
    if wait > 0:
        time.sleep(wait)
    st = load()  # re-read: user may have run /sleep or done/cancel while we waited
    if st["mode"] != "on" or not active(st):
        return
    now = time.time()
    due = [f for f in active(st) if f["next_check_at"] <= now + 1]
    if not due:
        return
    st["continuations"].append(now)
    st["autonomous"] = True
    save(st)
    reason = ("Persistent mode: a registered follow-up is due. Check it using only "
              "safe, non-mutating actions inside its scope. Then run "
              "`python3 .claude/hooks/persist.py update <id> --state ... --next-in ...` "
              "or `done <id> --note ...`. Stay quiet unless there is a meaningful "
              "outcome, a genuine blocker, or something needing the user.\n\n"
              + "\n".join(fmt_followup(f, now) for f in due))
    emit({"decision": "block", "reason": reason})


# ---- guard: while a continuation is autonomous, only read-only tools run

ALWAYS_ALLOW = {"Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch",
                "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "ScheduleWakeup",
                "CronList", "ListMcpResourcesTool",
                "ReadMcpResourceTool", "ReadMcpResourceDirTool"}
READ_VERBS = ("get", "list", "search", "read", "fetch", "query", "lookup", "find")
WRITE_VERBS = ("create", "update", "delete", "send", "write", "push", "merge",
               "trash", "share", "move", "upload", "spawn", "stop", "respond",
               "forward", "reply", "label", "apply", "set", "run", "trigger",
               "fork", "resolve", "request", "enable", "disable", "add", "remove",
               "archive", "copy", "duplicate", "mark", "convert", "download")
SIMPLE_READONLY = {"ls", "cat", "head", "tail", "wc", "grep", "rg", "stat", "file",
                   "pwd", "date", "sleep", "true", "which", "echo", "printf", "ps",
                   "df", "du", "uname", "whoami", "id", "jq", "sort", "uniq", "tr",
                   "cut", "basename", "dirname", "realpath", "test", "["}
GIT_READONLY = {"status", "log", "diff", "show", "rev-parse", "ls-files", "describe",
                "blame", "shortlog", "ls-remote"}
CURL_BAD_LONG = ("--request", "--data", "--form", "--upload-file", "--output",
                 "--remote-name", "--config", "--json")
# "sleep" is allowed: it only reduces autonomy. "on" is not.
PERSIST_OK = {"status", "list", "add", "update", "done", "cancel", "sleep"}


def segment_ok(argv):
    name = os.path.basename(argv[0])
    if name in ("python3", "python") and len(argv) > 2 and argv[1].endswith("persist.py"):
        return argv[2] in PERSIST_OK
    if name in SIMPLE_READONLY:
        return True
    if name == "find":
        return not {"-exec", "-execdir", "-ok", "-delete", "-fprint", "-fprintf",
                    "-fls"} & set(argv)
    if name == "git":
        if len(argv) < 2 or argv[1].startswith("-"):
            return False
        if argv[1] == "remote":
            return argv[2:] in ([], ["-v"])
        return argv[1] in GIT_READONLY and "--output" not in argv
    if name == "curl":
        for a in argv[1:]:
            if a.startswith("--"):
                if a.split("=")[0] in CURL_BAD_LONG or a.startswith("--data"):
                    return False
            elif a.startswith("-") and any(c in "dFTOoKX" for c in a[1:]):
                return False
        return True
    return False


OPERATORS = {";", "&&", "||", "|"}


def bash_segments(cmd):
    """Tokenize like a shell (quotes respected) and split into argv segments.

    Returns None if the command has anything we cannot prove read-only:
    redirects to real files, heredocs, background jobs, subshells, newlines.
    """
    if "\n" in cmd or "`" in cmd or "$(" in cmd:
        return None
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    try:
        toks = list(lex)
    except ValueError:
        return None
    segs, cur, i = [], [], 0
    while i < len(toks):
        t = toks[i]
        nxt = toks[i + 1] if i + 1 < len(toks) else ""
        if t in OPERATORS:
            segs.append(cur)
            cur = []
        elif t == ">&" and re.fullmatch(r"\d", nxt):        # 2>&1
            i += 1
            if cur and re.fullmatch(r"\d", cur[-1]):
                cur.pop()
        elif t == ">" and nxt == "/dev/null":                # 2>/dev/null
            i += 1
            if cur and re.fullmatch(r"\d", cur[-1]):
                cur.pop()
        elif all(c in "();<>&|" for c in t):
            return None  # unhandled pure-operator token; mixed words came from quotes
        else:
            cur.append(t)
        i += 1
    segs.append(cur)
    return [g for g in segs if g]


def bash_readonly(cmd):
    segs = bash_segments(cmd)
    return segs is not None and all(segment_ok(argv) for argv in segs)


def mcp_readonly(tool):
    suffix = tool.split("__")[-1].lower()
    words = re.split(r"[-_]", suffix)
    if any(w in WRITE_VERBS for w in words):
        return False
    return any(w in READ_VERBS for w in words)


def guard_decision(evt):
    tool = evt.get("tool_name", "")
    inp = evt.get("tool_input") or {}
    if tool in ALWAYS_ALLOW:
        return True
    if tool in ("Bash", "Monitor"):
        return bash_readonly(inp.get("command", ""))
    if tool.startswith("mcp__"):
        return mcp_readonly(tool)
    return False


def norm_msg(msg):
    return hashlib.sha1(re.sub(r"\s+", " ", msg.strip().lower()).encode()).hexdigest()


def notice_check(st, msg):
    """Return a deny reason for a redundant PushNotification, else None (and record it)."""
    now = time.time()
    st["notices"] = [n for n in st["notices"] if now - n["t"] < 86400]
    h = norm_msg(msg)
    if any(n["h"] == h and now - n["t"] < NOTICE_DEDUPE_S for n in st["notices"]):
        return "Duplicate notification already sent recently; do not repeat it."
    if st["autonomous"] and st["notices"] and now - st["notices"][-1]["t"] < NOTICE_MIN_GAP_S:
        return ("Autonomous continuations notify sparingly: a notification was sent "
                "recently. Stay quiet unless this is a blocker, and then wait.")
    st["notices"].append({"h": h, "t": now})
    save(st)
    return None


WAKE_TOOLS_OK = {"mcp__Claude_Code_Remote__send_later"}


def deny(reason):
    emit({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                 "permissionDecision": "deny",
                                 "permissionDecisionReason": reason}})


def hook_guard(evt):
    st = load()
    if st["mode"] != "on":
        return
    tool = evt.get("tool_name", "")
    if tool == "PushNotification":
        reason = notice_check(st, (evt.get("tool_input") or {}).get("message", ""))
        if reason:
            deny("Persistent mode: " + reason)
        return
    if not st["autonomous"]:
        return
    if tool in WAKE_TOOLS_OK:
        return
    if tool == "CronCreate":
        if (evt.get("tool_input") or {}).get("recurring") is False:
            return  # one-shot wake only
    elif guard_decision(evt):
        return
    deny("Persistent mode: this autonomous continuation may only use safe, "
         "non-mutating tools. Do not run it. Describe the proposed action to "
         "the user and wait for approval.")


HOOKS = {"session-start": hook_session_start, "prompt-submit": hook_prompt_submit,
         "stop": hook_stop, "guard": hook_guard}


def main(argv):
    if len(argv) >= 2 and argv[0] == "hook":
        try:
            evt = json.load(sys.stdin)
        except json.JSONDecodeError:
            evt = {}
        HOOKS[argv[1]](evt)
        return
    a = build_cli().parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main(sys.argv[1:])
