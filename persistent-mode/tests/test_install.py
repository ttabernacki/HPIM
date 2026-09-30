import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALL = os.path.join(PKG, "install.py")


def run(args, cwd=None, script=INSTALL, env=None, check=False):
    r = subprocess.run([sys.executable, script, *args], capture_output=True, text=True, cwd=cwd, env=env)
    if check:
        assert r.returncode == 0, r.stderr + r.stdout
    return r


def read(path):
    with open(path) as f:
        return f.read()


def hook_commands(settings):
    return [h["command"] for groups in settings.get("hooks", {}).values() for g in groups for h in g["hooks"]]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.proj = os.path.join(self.tmp, "proj")
        os.makedirs(self.proj)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def cl(self, *p):
        return os.path.join(self.proj, ".claude", *p)

    def settings(self, name="settings.json"):
        with open(self.cl(name)) as f:
            return json.load(f)

    def install(self, *extra):
        return run(["--project", self.proj, *extra])


class ProjectInstall(Base):
    def test_fresh_install_creates_files_and_hooks(self):
        r = self.install()
        self.assertEqual(r.returncode, 0, r.stderr)
        for rel in ["hooks/persist.py", "hooks/memory.py", "persistent/persistent_mode.md", "commands/persist.md",
                    "commands/sleep.md", "commands/dream.md", "agents/memory-writer.md", "persistent-mode.manifest.json"]:
            self.assertTrue(os.path.exists(self.cl(rel)), rel)
        cmds = hook_commands(self.settings())
        self.assertEqual(len(cmds), 7)
        self.assertTrue(all('"$CLAUDE_PROJECT_DIR/.claude/hooks/' in c for c in cmds))
        self.assertIn("Restart Claude Code", r.stdout)

    def test_no_unresolved_template_tokens(self):
        self.install()
        for rel in ["commands/persist.md", "commands/sleep.md", "commands/dream.md", "agents/memory-writer.md",
                    "agents/memory-consolidator.md"]:
            text = read(self.cl(rel))
            self.assertNotIn("{{", text, rel)
        self.assertIn("python3 .claude/hooks/persist.py", read(self.cl("commands/persist.md")))
        # the prompt keeps its RUNTIME token; the hook fills it in
        self.assertIn("{{CLI}}", read(self.cl("persistent/persistent_mode.md")))

    def test_idempotent(self):
        self.install()
        before = read(self.cl("settings.json"))
        r = self.install()
        self.assertIn("already up to date", r.stdout)
        self.assertEqual(read(self.cl("settings.json")), before)

    def test_preserves_existing_settings_and_hooks(self):
        os.makedirs(self.cl())
        foreign = {"type": "command", "command": "echo my-own-stop-hook"}
        with open(self.cl("settings.json"), "w") as f:
            json.dump({"permissions": {"allow": ["Bash(ls:*)"]}, "model": "x",
                       "hooks": {"Stop": [{"hooks": [foreign]}]}}, f)
        self.install()
        s = self.settings()
        self.assertEqual(s["permissions"], {"allow": ["Bash(ls:*)"]})
        self.assertEqual(s["model"], "x")
        self.assertIn(foreign["command"], hook_commands(s))
        self.assertEqual(len(s["hooks"]["Stop"]), 3)             # foreign + persist + memory
        self.assertTrue(os.path.exists(self.cl("settings.json.pre-persistent-mode")))

    def test_dry_run_changes_nothing(self):
        r = self.install("--dry-run")
        self.assertEqual(r.returncode, 0)
        self.assertIn("create", r.stdout)
        self.assertFalse(os.path.exists(self.cl()))

    def test_no_memory(self):
        self.install("--no-memory")
        self.assertFalse(os.path.exists(self.cl("hooks/memory.py")))
        self.assertFalse(os.path.exists(self.cl("agents")))
        self.assertEqual(len(hook_commands(self.settings())), 4)

    def test_local_writes_settings_local_only(self):
        self.install("--local")
        self.assertTrue(os.path.exists(self.cl("settings.local.json")))
        self.assertFalse(os.path.exists(self.cl("settings.json")))

    def test_invalid_settings_json_aborts_without_touching_anything(self):
        os.makedirs(self.cl())
        with open(self.cl("settings.json"), "w") as f:
            f.write("{ not json")
        r = self.install()
        self.assertEqual(r.returncode, 2)
        self.assertIn("not valid JSON", r.stderr)
        self.assertEqual(read(self.cl("settings.json")), "{ not json")

    def test_conflicting_file_is_skipped_then_forced_with_backup(self):
        os.makedirs(self.cl("commands"))
        with open(self.cl("commands/sleep.md"), "w") as f:
            f.write("my own sleep command\n")
        r = self.install()
        self.assertIn("skipped commands/sleep.md", r.stderr)
        self.assertEqual(read(self.cl("commands/sleep.md")), "my own sleep command\n")
        self.install("--force")
        self.assertIn("persist.py", read(self.cl("commands/sleep.md")))
        self.assertEqual(read(self.cl("commands/sleep.md.pre-persistent-mode")), "my own sleep command\n")

    def test_upgrade_updates_untouched_files_and_protects_edited_ones(self):
        pkg2 = os.path.join(self.tmp, "pkg2")
        shutil.copytree(PKG, pkg2, ignore=shutil.ignore_patterns("tests", "__pycache__"))
        script2 = os.path.join(pkg2, "install.py")
        run(["--project", self.proj], script=script2, check=True)
        with open(self.cl("commands/persist.md"), "a") as f:            # user edits one installed file
            f.write("\nmy tweak\n")
        for rel in ("commands/sleep.md", "commands/persist.md"):        # "new version" changes both
            with open(os.path.join(pkg2, "src", rel), "a") as f:
                f.write("\n<!-- v2 -->\n")
        r = run(["--project", self.proj], script=script2)
        self.assertIn("<!-- v2 -->", read(self.cl("commands/sleep.md")))         # untouched -> upgraded
        self.assertIn("my tweak", read(self.cl("commands/persist.md")))          # edited -> preserved
        self.assertNotIn("<!-- v2 -->", read(self.cl("commands/persist.md")))
        self.assertIn("skipped commands/persist.md", r.stderr)


class Uninstall(Base):
    def test_uninstall_removes_only_ours(self):
        os.makedirs(self.cl("hooks"))
        with open(self.cl("hooks/mine.py"), "w") as f:
            f.write("print(1)\n")
        foreign = {"type": "command", "command": "echo mine"}
        with open(self.cl("settings.json"), "w") as f:
            json.dump({"hooks": {"Stop": [{"hooks": [foreign]}]}, "model": "x"}, f)
        self.install()
        r = run(["--project", self.proj, "--uninstall"])
        self.assertEqual(r.returncode, 0, r.stderr)
        s = self.settings()
        self.assertEqual(hook_commands(s), ["echo mine"])
        self.assertEqual(s["model"], "x")
        self.assertTrue(os.path.exists(self.cl("hooks/mine.py")))
        self.assertFalse(os.path.exists(self.cl("hooks/persist.py")))
        self.assertFalse(os.path.exists(self.cl("commands")))                # empty dirs cleaned
        self.assertFalse(os.path.exists(self.cl("persistent-mode.manifest.json")))

    def test_uninstall_keeps_modified_files_and_user_data_unless_forced_or_purged(self):
        self.install()
        with open(self.cl("commands/persist.md"), "a") as f:
            f.write("edited\n")
        os.makedirs(self.cl("memory"))
        run(["--project", self.proj, "--uninstall"])
        self.assertTrue(os.path.exists(self.cl("commands/persist.md")))       # modified: kept
        self.assertTrue(os.path.exists(self.cl("memory")))                    # user data: kept
        self.install("--force")                     # the kept, edited file is now yours: --force takes it back
        os.makedirs(self.cl("memory"), exist_ok=True)
        run(["--project", self.proj, "--uninstall", "--purge", "--force"])
        self.assertFalse(os.path.exists(self.cl("memory")))
        self.assertFalse(os.path.exists(self.cl("commands/persist.md")))

    def test_uninstall_without_install_is_a_noop(self):
        r = run(["--project", self.proj, "--uninstall"])
        self.assertEqual(r.returncode, 0)
        self.assertIn("Nothing to uninstall", r.stdout)

    def test_reinstall_after_uninstall_restores_everything(self):
        self.install(); run(["--project", self.proj, "--uninstall"]); r = self.install()
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(hook_commands(self.settings())), 7)


class Check(Base):
    def test_check_passes_after_install_and_fails_when_broken(self):
        self.install()
        self.assertEqual(run(["--project", self.proj, "--check"]).returncode, 0)
        os.remove(self.cl("hooks/persist.py"))
        r = run(["--project", self.proj, "--check"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("missing file hooks/persist.py", r.stdout)

    def test_check_flags_unregistered_hooks(self):
        self.install()
        os.remove(self.cl("settings.json"))
        r = run(["--project", self.proj, "--check"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("hook not registered", r.stdout)


class RealUse(Base):
    """The installed copy must behave correctly from any project, exactly as Claude Code runs it."""

    def run_hook(self, command, project, stdin="{}"):
        env = dict(os.environ, CLAUDE_PROJECT_DIR=project)
        return subprocess.run(command, shell=True, env=env, input=stdin, capture_output=True, text=True)

    def test_registered_hook_commands_run_verbatim_in_a_shell(self):
        self.install()
        for c in hook_commands(self.settings()):
            r = self.run_hook(c, self.proj)
            self.assertEqual(r.returncode, 0, f"{c}\n{r.stderr}")

    def test_user_scope_serves_many_projects_with_separate_state(self):
        claude = os.path.join(self.tmp, "home", ".claude")
        run(["--user", "--claude-dir", claude], check=True)
        with open(os.path.join(claude, "settings.json")) as f:
            cmds = hook_commands(json.load(f))
        self.assertTrue(all(claude in c for c in cmds), cmds)                       # absolute paths
        self.assertNotIn("{{", read(os.path.join(claude, "commands", "persist.md")))
        self.assertIn(claude, read(os.path.join(claude, "commands", "sleep.md")))
        persist = os.path.join(claude, "hooks", "persist.py")
        projA, projB = os.path.join(self.tmp, "A"), os.path.join(self.tmp, "B")
        for p in (projA, projB):
            os.makedirs(p)
            subprocess.run(["git", "init", "-q", p], check=True)
        envA = dict(os.environ, CLAUDE_PROJECT_DIR=projA)
        envB = dict(os.environ, CLAUDE_PROJECT_DIR=projB)
        subprocess.run([sys.executable, persist, "on"], env=envA, check=True, capture_output=True)
        subprocess.run([sys.executable, persist, "add", "--target", "t", "--stop", "s", "--scope", "x"], env=envA, check=True, capture_output=True)
        # project A is on, B was never turned on
        a = subprocess.run([sys.executable, persist, "hook", "session-start"], env=envA, input="{}", capture_output=True, text=True)
        b = subprocess.run([sys.executable, persist, "hook", "session-start"], env=envB, input="{}", capture_output=True, text=True)
        self.assertIn("Proactivity", a.stdout)
        self.assertNotIn("{{CLI}}", a.stdout)
        self.assertIn(persist, a.stdout)                                            # prompt tells the agent the real CLI path
        self.assertEqual(b.stdout, "")
        self.assertTrue(os.path.exists(os.path.join(projA, ".claude", "persistent", "state.json")))
        self.assertFalse(os.path.exists(os.path.join(projB, ".claude", "persistent")))
        self.assertFalse(os.path.exists(os.path.join(claude, "persistent", "state.json")))   # never in the config dir
        # generated state does not dirty the user's repo
        st = subprocess.run(["git", "-C", projA, "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertEqual(st, "")

    def test_memory_is_ignored_by_git_and_read_path_uses_installed_cli(self):
        claude = os.path.join(self.tmp, "home", ".claude")
        run(["--user", "--claude-dir", claude], check=True)
        memory = os.path.join(claude, "hooks", "memory.py")
        subprocess.run(["git", "init", "-q", self.proj], check=True)
        env = dict(os.environ, CLAUDE_PROJECT_DIR=self.proj)
        os.makedirs(os.path.join(self.proj, ".claude", "memory"))
        with open(os.path.join(self.proj, ".claude", "memory", "memory_summary.md"), "w") as f:
            f.write("v1\n## User Profile\nx\n## User preferences\ny\n## General Tips\nz\n## What's in Memory\nw\n")
        out = subprocess.run([sys.executable, memory, "hook", "session-start"], env=env, input="{}", capture_output=True, text=True).stdout
        self.assertIn("MEMORY_SUMMARY BEGINS", out)
        self.assertIn(memory, out)
        self.assertNotIn("{cli}", out)
        subprocess.run([sys.executable, memory, "note", "--kind", "remember", "x"], env=env, check=True, capture_output=True)
        st = subprocess.run(["git", "-C", self.proj, "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertEqual(st, "")

    def test_stop_hook_reason_names_the_installed_cli(self):
        claude = os.path.join(self.tmp, "home", ".claude")
        run(["--user", "--claude-dir", claude], check=True)
        persist = os.path.join(claude, "hooks", "persist.py")
        env = dict(os.environ, CLAUDE_PROJECT_DIR=self.proj)
        for argv in (["on"], ["add", "--target", "t", "--stop", "s", "--scope", "x", "--next-in", "0"]):
            subprocess.run([sys.executable, persist, *argv], env=env, check=True, capture_output=True)
        r = subprocess.run([sys.executable, persist, "hook", "stop"], env=env, input="{}", capture_output=True, text=True)
        reason = json.loads(r.stdout)["reason"]
        self.assertIn(persist, reason)


class SkillInstall(Base):
    def setUp(self):
        super().setUp()
        self.claude = os.path.join(self.tmp, "home", ".claude")
        self.skill = os.path.join(self.claude, "skills", "persistent-mode")

    def skill_install(self, *extra, script=INSTALL):
        return run(["--skill", "--claude-dir", self.claude, *extra], script=script)

    def md(self):
        return read(os.path.join(self.skill, "SKILL.md"))

    def test_skill_bundle_is_self_contained_and_valid(self):
        r = self.skill_install()
        self.assertEqual(r.returncode, 0, r.stderr)
        for rel in ("SKILL.md", "install.py", "README.md", "skill/SKILL.md", "src/hooks/persist.py",
                    "src/hooks/memory.py", "src/persistent/persistent_mode.md", "src/commands/persist.md",
                    ".skill-manifest.json"):
            self.assertTrue(os.path.exists(os.path.join(self.skill, rel)), rel)
        md = self.md()
        self.assertTrue(md.startswith("---\nname: persistent-mode\ndescription: "))
        head = md.split("---\n")[1]
        self.assertLessEqual(len(head.split("description: ", 1)[1].strip()), 1024)
        self.assertNotIn("{{", md)
        self.assertIn(self.skill, md)                     # absolute skill path
        self.assertIn(self.claude, md)                    # absolute path to the hooks it installs
        self.assertFalse(os.path.exists(os.path.join(self.claude, "settings.json")))    # hooks NOT installed yet
        self.assertFalse(os.path.exists(os.path.join(self.claude, "hooks")))

    def test_idempotent(self):
        self.skill_install()
        r = self.skill_install()
        self.assertIn("already up to date", r.stdout)

    def test_skill_check(self):
        self.skill_install()
        self.assertEqual(run(["--skill", "--claude-dir", self.claude, "--check"]).returncode, 0)
        os.remove(os.path.join(self.skill, "src", "hooks", "persist.py"))
        r = run(["--skill", "--claude-dir", self.claude, "--check"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("missing file src/hooks/persist.py", r.stdout)

    def test_activate_also_installs_user_wide_hooks_and_commands(self):
        r = self.skill_install("--activate")
        self.assertEqual(r.returncode, 0, r.stderr)
        cmds = hook_commands(json.loads(read(os.path.join(self.claude, "settings.json"))))
        self.assertEqual(len(cmds), 7)
        self.assertTrue(all(self.claude in c for c in cmds))
        self.assertTrue(os.path.exists(os.path.join(self.claude, "commands", "persist.md")))
        self.assertTrue(os.path.exists(os.path.join(self.claude, "skills", "persistent-mode", "SKILL.md")))

    def test_the_commands_written_in_SKILL_md_actually_work(self):
        """SKILL.md tells Claude to run these; a rendering bug would break the skill for every user."""
        self.skill_install()
        check = next(l.strip() for l in self.md().splitlines() if l.strip().startswith("python3") and "--check" in l)
        before = subprocess.run(check, shell=True, capture_output=True, text=True)
        self.assertEqual(before.returncode, 1)                       # hooks not installed yet
        install_cmd = next(l.strip() for l in self.md().splitlines()
                           if l.strip().startswith("python3") and "install.py" in l and "--check" not in l)
        self.assertEqual(subprocess.run(install_cmd, shell=True, capture_output=True, text=True).returncode, 0)
        after = subprocess.run(check, shell=True, capture_output=True, text=True)
        self.assertEqual(after.returncode, 0, after.stdout + after.stderr)
        self.assertIn("OK", after.stdout)
        on = next(l.strip() for l in self.md().splitlines() if l.strip().startswith("python3") and " on " in l)
        env = dict(os.environ, CLAUDE_PROJECT_DIR=self.proj)
        r = subprocess.run(on.replace("[--max-hours H] [--max-per-hour N]", "--max-hours 1"), shell=True, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("persistent mode: on", r.stdout)
        cli_prefix = next(l.strip() for l in self.md().splitlines() if l.strip().startswith('CLI="'))
        self.assertIn(os.path.join(self.claude, "hooks", "persist.py"), cli_prefix)

    def test_bundled_installer_bootstraps_offline_from_the_skill_dir(self):
        self.skill_install()
        other = os.path.join(self.tmp, "other", ".claude")
        r = run(["--user", "--claude-dir", other], script=os.path.join(self.skill, "install.py"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(hook_commands(json.loads(read(os.path.join(other, "settings.json"))))), 7)

    def test_rerun_from_inside_the_skill_dir_keeps_it_intact(self):
        self.skill_install()
        r = self.skill_install(script=os.path.join(self.skill, "install.py"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(run(["--skill", "--claude-dir", self.claude, "--check"]).returncode, 0)

    def test_edited_skill_files_are_protected_until_forced(self):
        self.skill_install()
        with open(os.path.join(self.skill, "README.md"), "a") as f:
            f.write("\nmine\n")
        pkg2 = os.path.join(self.tmp, "pkg2")
        shutil.copytree(PKG, pkg2, ignore=shutil.ignore_patterns("tests", "__pycache__"))
        with open(os.path.join(pkg2, "README.md"), "a") as f:
            f.write("\nv2\n")
        r = self.skill_install(script=os.path.join(pkg2, "install.py"))
        self.assertIn("skipped README.md", r.stderr)
        self.assertIn("mine", read(os.path.join(self.skill, "README.md")))
        self.skill_install("--force", script=os.path.join(pkg2, "install.py"))
        self.assertIn("v2", read(os.path.join(self.skill, "README.md")))

    def test_uninstall_removes_the_skill_but_not_the_hooks(self):
        self.skill_install("--activate")
        r = run(["--skill", "--claude-dir", self.claude, "--uninstall"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(os.path.exists(self.skill))
        self.assertEqual(len(hook_commands(json.loads(read(os.path.join(self.claude, "settings.json"))))), 7)

    def test_project_scoped_skill(self):
        r = run(["--skill", "--project", self.proj])
        self.assertEqual(r.returncode, 0, r.stderr)
        md = read(os.path.join(self.proj, ".claude", "skills", "persistent-mode", "SKILL.md"))
        self.assertIn(f'--project "{self.proj}"', md)
        self.assertNotIn("--user", md.split("## 2.")[0])

    def test_activate_requires_skill(self):
        self.assertEqual(run(["--project", self.proj, "--activate"]).returncode, 2)

    def test_project_install_warns_when_also_installed_user_wide(self):
        home = os.path.join(self.tmp, "home")
        env = dict(os.environ, HOME=home)
        run(["--user"], env=env, check=True)
        r = run(["--project", self.proj], env=env)
        self.assertEqual(r.returncode, 0)
        self.assertIn("ALSO installed user-wide", r.stderr)
        self.assertNotIn("ALSO installed", run(["--project", self.proj], env=dict(os.environ, HOME=os.path.join(self.tmp, "clean"))).stderr)


class Concurrency(Base):
    def test_parallel_cli_calls_do_not_lose_updates(self):
        self.install()
        persist = self.cl("hooks", "persist.py")
        env = dict(os.environ, CLAUDE_PROJECT_DIR=self.proj)
        subprocess.run([sys.executable, persist, "on"], env=env, check=True, capture_output=True)
        procs = [subprocess.Popen([sys.executable, persist, "add", "--target", f"t{i}", "--stop", "s", "--scope", "x"],
                                  env=env, stdout=subprocess.DEVNULL) for i in range(12)]
        for p in procs:
            p.wait()
        with open(self.cl("persistent", "state.json")) as f:
            st = json.load(f)
        self.assertEqual(len(st["followups"]), 12)
        self.assertEqual(sorted(f["id"] for f in st["followups"]), list(range(1, 13)))


class DogfoodInSync(Base):
    """This repo installs its own package; the installed copy must never drift from src/."""

    def test_repo_dot_claude_matches_a_fresh_install(self):
        repo_claude = os.path.join(os.path.dirname(PKG), ".claude")
        manifest = os.path.join(repo_claude, "persistent-mode.manifest.json")
        if not os.path.exists(manifest):
            self.skipTest("this checkout has no installed copy")
        self.install()
        with open(manifest) as f:
            files = json.load(f)["files"]
        for rel in files:
            self.assertEqual(read(os.path.join(repo_claude, rel)), read(self.cl(rel)),
                             f".claude/{rel} is out of sync; run: python3 persistent-mode/install.py --project . --force")


if __name__ == "__main__":
    unittest.main()
