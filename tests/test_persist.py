import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, ".claude", "hooks", "persist.py")


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, ".claude", "persistent"))
        shutil.copy(os.path.join(ROOT, ".claude", "persistent", "persistent_mode.md"),
                    os.path.join(self.dir, ".claude", "persistent"))
        self.env = dict(os.environ, CLAUDE_PROJECT_DIR=self.dir, PERSIST_MAX_INLINE_WAIT="3")

    def tearDown(self):
        shutil.rmtree(self.dir)

    def cli(self, *args):
        return subprocess.run([sys.executable, SCRIPT, *args], env=self.env,
                              capture_output=True, text=True, check=True).stdout

    def hook(self, name, evt=None):
        r = subprocess.run([sys.executable, SCRIPT, "hook", name], env=self.env,
                           input=json.dumps(evt or {}), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout) if r.stdout.strip().startswith("{") else r.stdout

    def state(self):
        with open(os.path.join(self.dir, ".claude", "persistent", "state.json")) as f:
            return json.load(f)

    def add(self, next_in=0):
        self.cli("add", "--target", "deploy X", "--stop", "healthy", "--scope", "read-only",
                 "--next-in", str(next_in))


class StopHook(Base):
    def test_off_allows_stop(self):
        self.add()
        self.assertEqual(self.hook("stop"), "")

    def test_on_no_followups_allows_stop(self):
        self.cli("on")
        self.assertEqual(self.hook("stop"), "")

    def test_due_followup_blocks_and_sets_autonomous(self):
        self.cli("on")
        self.add()
        out = self.hook("stop")
        self.assertEqual(out["decision"], "block")
        self.assertIn("deploy X", out["reason"])
        self.assertTrue(self.state()["autonomous"])

    def test_short_wait_sleeps_then_blocks(self):
        self.cli("on")
        self.add(next_in=1)
        t = time.time()
        out = self.hook("stop")
        self.assertGreaterEqual(time.time() - t, 0.9)
        self.assertEqual(out["decision"], "block")

    def test_long_wait_requests_wake_once_then_allows_stop(self):
        self.cli("on")
        self.add(next_in=600)
        out = self.hook("stop")
        self.assertEqual(out["decision"], "block")
        self.assertIn("[persistent-wake]", out["reason"])
        self.assertIn("ScheduleWakeup", out["reason"])
        self.assertEqual(self.hook("stop"), "")  # wake already requested
        self.assertFalse(self.state()["autonomous"])

    def test_update_after_wake_request_requests_again(self):
        self.cli("on")
        self.add(next_in=600)
        self.hook("stop")
        self.cli("update", "1", "--state", "pending", "--next-in", "900")
        self.assertEqual(self.hook("stop")["decision"], "block")

    def test_done_ends_loop(self):
        self.cli("on")
        self.add()
        self.cli("done", "1", "--note", "healthy")
        self.assertEqual(self.hook("stop"), "")

    def test_update_resets_timer(self):
        self.cli("on")
        self.add()
        self.cli("update", "1", "--state", "still pending", "--next-in", "600")
        out = self.hook("stop")
        self.assertIn("next check is", out["reason"])  # not treated as due

    def test_sleep_stops_blocking(self):
        self.cli("on")
        self.add()
        self.cli("sleep")
        self.assertEqual(self.hook("stop"), "")

    def test_hourly_cap(self):
        self.cli("on", "--max-per-hour", "2")
        self.add()
        self.assertEqual(self.hook("stop")["decision"], "block")
        self.assertEqual(self.hook("stop")["decision"], "block")
        out = self.hook("stop")
        self.assertNotIn("decision", out)
        self.assertIn("cap", out["systemMessage"])

    def test_total_hours_cap_sleeps(self):
        self.cli("on")
        self.add()
        st = self.state()
        st["started_at"] -= 13 * 3600
        with open(os.path.join(self.dir, ".claude", "persistent", "state.json"), "w") as f:
            json.dump(st, f)
        out = self.hook("stop")
        self.assertNotIn("decision", out)
        self.assertEqual(self.state()["mode"], "sleeping")


class Guard(Base):
    def deny(self, tool, **inp):
        out = self.hook("guard", {"tool_name": tool, "tool_input": inp})
        return isinstance(out, dict) and \
            out["hookSpecificOutput"]["permissionDecision"] == "deny"

    def autonomous(self):
        self.cli("on")
        self.add()
        self.hook("stop")  # sets autonomous

    def test_inactive_when_not_autonomous(self):
        self.cli("on")
        self.assertFalse(self.deny("Bash", command="rm -rf /tmp/x"))
        self.assertFalse(self.deny("Write", file_path="a"))

    def test_user_prompt_clears_autonomous(self):
        self.autonomous()
        self.assertTrue(self.deny("Write", file_path="a"))
        self.hook("prompt-submit")
        self.assertFalse(self.deny("Write", file_path="a"))

    def test_blocks_mutating_tools(self):
        self.autonomous()
        for tool in ("Write", "Edit", "NotebookEdit", "Agent", "CronCreate"):
            self.assertTrue(self.deny(tool), tool)

    def test_bash_readonly_allowed(self):
        self.autonomous()
        for cmd in ("ls -la", "git status", "git log --oneline | head -5",
                    "grep -rn foo . 2>/dev/null", "curl -sSL https://example.com",
                    "find . -name '*.py'", "sleep 5 && git diff",
                    "python3 .claude/hooks/persist.py update 1 --state ok"):
            self.assertFalse(self.deny("Bash", command=cmd), cmd)

    def test_bash_mutating_denied(self):
        self.autonomous()
        for cmd in ("rm -rf x", "git push origin main", "git commit -m x",
                    "echo hi > f", "cat a >> b", "ls; rm x", "ls && touch x",
                    "curl -X POST https://e.com", "curl -d a=b https://e.com",
                    "curl -o out https://e.com", "find . -delete",
                    "find . -exec rm {} +", "echo $(rm x)", "echo `rm x`",
                    "python3 -c 'import os'", "npm install", "sed -i s/a/b/ f",
                    "python3 .claude/hooks/persist.py on", "sleep 1 &",
                    "git -c core.pager=x log", "tee f"):
            self.assertTrue(self.deny("Bash", command=cmd), cmd)

    def test_mcp(self):
        self.autonomous()
        self.assertFalse(self.deny("mcp__github__get_file_contents"))
        self.assertFalse(self.deny("mcp__github__list_commits"))
        self.assertFalse(self.deny("mcp__Notion__notion-search"))
        self.assertTrue(self.deny("mcp__github__create_pull_request"))
        self.assertTrue(self.deny("mcp__github__actions_run_trigger"))
        self.assertTrue(self.deny("mcp__Gmail__send_message"))
        self.assertTrue(self.deny("mcp__Notion__notion-update-page"))
        self.assertTrue(self.deny("mcp__Foo__frobnicate"))


class Wake(Base):
    def test_wake_prompt_stays_autonomous_and_injects_followups(self):
        self.cli("on")
        self.add(next_in=600)
        out = self.hook("prompt-submit", {"prompt": "[persistent-wake] check due follow-ups"})
        self.assertIn("deploy X", out)
        st = self.state()
        self.assertTrue(st["autonomous"])
        self.assertIsNone(st["wake_for"])

    def test_real_prompt_clears_autonomous(self):
        self.cli("on")
        self.add()
        self.hook("stop")
        self.hook("prompt-submit", {"prompt": "hello"})
        self.assertFalse(self.state()["autonomous"])

    def test_wake_prompt_ignored_when_no_active_followup(self):
        self.cli("on")
        self.hook("prompt-submit", {"prompt": "[persistent-wake] x"})
        self.assertFalse(self.state()["autonomous"])

    def test_wake_tools_allowed_only_one_shot(self):
        self.cli("on")
        self.add()
        self.hook("stop")
        g = lambda t, **i: self.hook("guard", {"tool_name": t, "tool_input": i})
        self.assertEqual(g("CronCreate", cron="30 14 1 1 *", prompt="x", recurring=False), "")
        self.assertEqual(g("mcp__Claude_Code_Remote__send_later", message="x"), "")
        self.assertEqual(g("ScheduleWakeup", delaySeconds=60), "")
        self.assertIn("hookSpecificOutput", g("CronCreate", cron="*/5 * * * *", prompt="x"))


class Notify(Base):
    def push(self, msg):
        return self.hook("guard", {"tool_name": "PushNotification",
                                   "tool_input": {"message": msg, "status": "proactive"}})

    def test_duplicate_suppressed_case_and_space_insensitive(self):
        self.cli("on")
        self.assertEqual(self.push("Deploy X healthy"), "")
        out = self.push("  deploy   x HEALTHY ")
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_distinct_message_allowed_outside_autonomous(self):
        self.cli("on")
        self.assertEqual(self.push("a"), "")
        self.assertEqual(self.push("b"), "")

    def test_autonomous_min_gap(self):
        self.cli("on")
        self.add()
        self.hook("stop")
        self.assertEqual(self.push("a"), "")
        out = self.push("b")
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_inactive_when_off(self):
        self.assertEqual(self.push("a"), "")
        self.assertEqual(self.push("a"), "")


class SessionStart(Base):
    def test_injects_prompt_and_followups_when_on(self):
        self.cli("on")
        self.add()
        out = self.hook("session-start")
        self.assertIn("Proactivity", out)
        self.assertIn("deploy X", out)

    def test_silent_when_off_or_sleeping(self):
        self.assertEqual(self.hook("session-start"), "")
        self.cli("on")
        self.cli("sleep")
        self.assertEqual(self.hook("session-start"), "")


if __name__ == "__main__":
    unittest.main()
