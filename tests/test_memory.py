import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, ".claude", "hooks", "memory.py")
sys.path.insert(0, os.path.join(ROOT, ".claude", "hooks"))
import memory  # noqa: E402

def wr(path, text):
    with open(path, "w") as f:
        f.write(text)


class rd:
    """Read helper: rd(p).read() / json.load(rd(p)) without leaking handles."""
    def __init__(self, path):
        with open(path) as f:
            self.text = f.read()

    def read(self):
        return self.text


VALID = """v1
## User Profile
- resident
## User preferences
- concise answers
## General Tips
- none
## What's in Memory
### proj
#### 2026-01-01
- rollout_summaries/a.md — did a thing; thread_id=s1
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.env = dict(os.environ, CLAUDE_PROJECT_DIR=self.dir, PERSIST_MEMORY_MIN_IDLE="3600")

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_cli(self, *args, stdin=None, check=True):
        r = subprocess.run([sys.executable, SCRIPT, *args], env=self.env, input=stdin,
                           capture_output=True, text=True)
        if check:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def touch(self, sid, path, age=0):
        self.run_cli("hook", "touch", stdin=json.dumps(
            {"session_id": sid, "transcript_path": path, "cwd": "/w"}))
        p = os.path.join(self.dir, ".claude", "memory", ".registry.json")
        reg = json.load(rd(p))
        reg[sid]["ended_at"] = time.time() - age
        wr(p, json.dumps(reg))

    def transcript(self, name="t.jsonl", extra=()):
        rows = [
            {"type": "user", "timestamp": "2026-01-02T10:00:00Z",
             "message": {"content": "always give me the answer first. key=sk-abcdefghijklmnopqrstuvwx"}},
            {"type": "assistant", "message": {"content": [
                {"type": "thinking", "thinking": "hidden"},
                {"type": "text", "text": "ok, will do"},
                {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "content": "boom", "is_error": True}]}},
            {"type": "user", "isSidechain": True, "message": {"content": "sidechain noise"}},
            {"type": "user", "message": {"content": "MRN: 12345678 and ssn 123-45-6789"}},
            *extra,
        ]
        p = os.path.join(self.dir, name)
        with open(p, "w") as f:
            f.write("\n".join(json.dumps(r) for r in rows))
        return p

    def mem(self, *parts):
        return os.path.join(self.dir, ".claude", "memory", *parts)


class Redaction(unittest.TestCase):
    def test_patterns(self):
        cases = ["sk-abcdefghijklmnopqrstuvwx", "ghp_" + "a" * 30, "AKIAABCDEFGHIJKLMNOP",
                 "password=hunter2xyz", "Bearer abcdefghijklmnopqrstuv",
                 "https://u:pw123@host/x", "https://h/x?token=abc123", "123-45-6789",
                 "MRN 98765432", "eyJhbGciOiJI.eyJzdWIiOiIx.abcdefghij",
                 "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"]
        for c in cases:
            out = memory.redact("x " + c + " y")
            self.assertIn("[REDACTED_", out, c)
        self.assertEqual(memory.redact("nothing secret here"), "nothing secret here")


class Registry(Base):
    def test_idle_threshold(self):
        t = self.transcript()
        self.touch("fresh", t, age=10)
        self.touch("old", t, age=7200)
        ids = [json.loads(l)["session_id"] for l in self.run_cli("pending").stdout.splitlines()]
        self.assertEqual(ids, ["old"])
        ids = [json.loads(l)["session_id"] for l in self.run_cli("pending", "--all").stdout.splitlines()]
        self.assertCountEqual(ids, ["fresh", "old"])

    def test_missing_transcript_not_eligible(self):
        self.touch("gone", "/nonexistent.jsonl", age=7200)
        self.assertEqual(self.run_cli("pending").stdout, "")

    def test_resumed_done_session_becomes_pending(self):
        t = self.transcript()
        self.touch("s", t, age=7200)
        os.makedirs(self.mem("rollout_summaries"))
        self.run_cli("finish", "s", "--noop")
        self.touch("s", t, age=7200)
        self.assertIn('"s"', self.run_cli("pending").stdout)


class Extract(Base):
    def test_extract_is_condensed_and_redacted(self):
        self.touch("s1", self.transcript(), age=7200)
        out = self.run_cli("extract", "s1").stdout
        self.assertIn("thread_id: s1", out)
        self.assertIn("[USER #1", out)
        self.assertIn("always give me the answer first", out)
        self.assertIn("[TOOL Bash]", out)
        self.assertIn("[tool-error] boom", out)
        self.assertNotIn("hidden", out)
        self.assertNotIn("sidechain noise", out)
        self.assertNotIn("sk-abcdefghijklmnop", out)
        self.assertNotIn("12345678", out)
        self.assertNotIn("123-45-6789", out)

    def test_cap_keeps_head_and_tail(self):
        big = [{"type": "user", "message": {"content": f"msg {i} " + "x" * 2000}} for i in range(80)]
        self.touch("s", self.transcript(extra=big), age=7200)
        out = self.run_cli("extract", "s").stdout
        self.assertIn("middle of session omitted", out)
        self.assertLess(len(out), memory.EXTRACT_CAP + 500)
        self.assertIn("msg 79", out)


class FinishDiffValidate(Base):
    def write_rollout(self, slug, sid, body="secret token=abcd1234efgh"):
        os.makedirs(self.mem("rollout_summaries"), exist_ok=True)
        with open(self.mem("rollout_summaries", slug + ".md"), "w") as f:
            f.write(f"thread_id: {sid}\n# x\n{body}\n")

    def test_finish_redacts_and_marks_done(self):
        self.touch("s1", self.transcript(), age=7200)
        self.write_rollout("a", "s1")
        self.run_cli("finish", "s1", "--slug", "a")
        self.assertNotIn("abcd1234efgh", rd(self.mem("rollout_summaries", "a.md")).read())
        self.assertEqual(self.run_cli("pending").stdout, "")

    def test_finish_rejects_bad_slug_missing_file_and_wrong_thread(self):
        self.touch("s1", self.transcript(), age=7200)
        self.assertNotEqual(self.run_cli("finish", "s1", "--slug", "Bad Slug", check=False).returncode, 0)
        self.assertNotEqual(self.run_cli("finish", "s1", "--slug", "nope", check=False).returncode, 0)
        self.write_rollout("a", "other-id")
        self.assertNotEqual(self.run_cli("finish", "s1", "--slug", "a", check=False).returncode, 0)

    def test_diff_baseline_and_forgetting(self):
        self.touch("s1", self.transcript(), age=7200)
        self.write_rollout("a", "s1", body="likes X")
        out = self.run_cli("diff").stdout
        d = rd(self.mem("phase2_workspace_diff.md")).read()
        self.assertIn("likes X", d)
        self.run_cli("baseline")
        self.run_cli("diff")
        self.assertIn("no changes", rd(self.mem("phase2_workspace_diff.md")).read())
        os.remove(self.mem("rollout_summaries", "a.md"))
        self.run_cli("diff")
        d = rd(self.mem("phase2_workspace_diff.md")).read()
        self.assertIn("deleted file", d)
        self.assertIn("-likes X", d)
        self.assertNotIn(".registry", d)

    def test_note_written_and_redacted(self):
        self.run_cli("note", "--kind", "forget", "drop pref X token=abcdef123456")
        notes = os.listdir(self.mem("extensions", "ad_hoc", "notes"))
        self.assertEqual(len(notes), 1)
        self.assertTrue(notes[0].endswith("-forget.md"))
        self.assertNotIn("abcdef123456", rd(self.mem("extensions", "ad_hoc", "notes", notes[0])).read())

    def test_validate(self):
        os.makedirs(self.mem("rollout_summaries"))
        wr(self.mem("rollout_summaries", "a.md"), "thread_id: s1\n")
        path = self.mem("memory_summary.md")
        wr(path, VALID)
        self.assertIn("valid", self.run_cli("validate").stdout)
        cases = {
            "no v1": VALID.replace("v1\n", "", 1),
            "missing section": VALID.replace("## General Tips", "## Tips"),
            "too big": VALID + "x" * 10000,
            "secret": VALID + "token=abcd1234efgh\n",
            "email": VALID + "contact: someone@example.com\n",
            "dangling pointer": VALID + "- rollout_summaries/zzz.md — x; thread_id=q\n",
        }
        for name, text in cases.items():
            wr(path, text)
            r = self.run_cli("validate", check=False)
            self.assertNotEqual(r.returncode, 0, name)
            self.assertIn("INVALID", r.stderr, name)


class SessionStart(Base):
    def start(self):
        return self.run_cli("hook", "session-start", stdin="{}").stdout

    def test_silent_with_no_memory(self):
        self.assertEqual(self.start(), "")

    def test_injects_summary_and_read_instructions(self):
        os.makedirs(self.mem())
        wr(self.mem("memory_summary.md"), VALID)
        out = self.start()
        self.assertIn("MEMORY_SUMMARY BEGINS", out)
        self.assertIn("concise answers", out)
        self.assertIn("not proof of current behavior", out)

    def test_hint_when_sessions_pending(self):
        self.touch("s", self.transcript(), age=7200)
        self.assertIn("run /dream", self.start())

    def test_summary_injection_capped(self):
        os.makedirs(self.mem())
        wr(self.mem("memory_summary.md"), VALID + "y" * 20000)
        self.assertLess(len(self.start().encode()), 13000)


if __name__ == "__main__":
    unittest.main()
