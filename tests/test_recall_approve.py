"""Read-only auto-approval: scripts/recall-approve.sh.

Moved here with the script from kemory-plugin, where it was tested since it
shipped. Runs with: python3 tests/test_recall_approve.py
"""
import json
import os
import pathlib
import re
import subprocess
import tempfile
import shutil
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
HOOKS = ROOT / "hooks" / "hooks.json"


class RecallApproveTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)

    def env(self, **extra):
        e = {k: v for k, v in os.environ.items()
             if not k.startswith("KEMORY_") and k != "CLAUDE_CODE_ENTRYPOINT"}
        e.update({"HOME": self.home})
        e.update(extra)
        return e

    def test_hook_is_registered_synchronously_on_pretooluse(self):
        # An async PreToolUse hook's output is discarded: the approval would
        # silently never reach the engine.
        hooks = json.loads(HOOKS.read_text())["hooks"]["PreToolUse"]
        for group in hooks:
            for hook in group["hooks"]:
                self.assertNotEqual(hook.get("async"), True)

    def test_matcher_covers_claude_code_and_grok_names(self):
        rx = re.compile(json.loads(HOOKS.read_text())["hooks"]["PreToolUse"][0]["matcher"])
        for name in ("mcp__plugin_kemory_kemory__kemory_recall_memory",
                     "kemory__kemory_recall_memory",
                     "mcp__plugin_kemory_kemory__s9nmem_recall"):
            with self.subTest(name=name):
                self.assertTrue(rx.match(name))

    # --- read-only auto-approval (PreToolUse) -----------------------------
    READ_ONLY = ("recall", "recall_memory", "get_context", "ask",
                 "find_similar", "get_compressed", "get_raw",
                 "get_session_context", "get_namespace_summary", "get_profile",
                 "get_user_context", "get_history", "list_namespaces",
                 "list_projects", "list_skills", "whoami", "check_access",
                 "rehydrate_session_sources")
    # kemory_memory is "Save one memory. Friendly alias of kemory_store_memory"
    # — it requires memory:write despite reading like a read. rate_memory is a
    # write whose rows move an org-level indicator.
    WRITES = ("memory", "store_memory", "store_skill", "capture_session",
              "consolidate_session", "delete_memory", "forget",
              "promote_memory", "resolve_conflict", "rate_memory")

    def approve(self, tool_name, **extra):
        payload = {"session_id": "s", "hook_event_name": "PreToolUse",
                   "tool_name": tool_name, "tool_input": {}}
        payload.update(extra)
        return subprocess.run([str(SCRIPTS / "recall-approve.sh")],
                              input=json.dumps(payload), text=True,
                              capture_output=True, env=self.env())

    def _decision(self, stdout):
        try:
            return json.loads(stdout)["hookSpecificOutput"]["permissionDecision"]
        except Exception:
            return None

    def test_approve_matches_real_payload(self):
        fixture = json.loads((ROOT / "tests" / "fixtures" /
                              "pretooluse-kemory-recall.json").read_text())
        self.assertIsInstance(fixture["tool_input"], dict,
                              "fixture must keep the real payload shape")
        r = subprocess.run([str(SCRIPTS / "recall-approve.sh")],
                           input=json.dumps(fixture), text=True,
                           capture_output=True, env=self.env())
        self.assertEqual(self._decision(r.stdout), "allow")
        self.assertIn("hybrid search", json.loads(r.stdout)["systemMessage"])

    def test_approve_allows_every_read_only_tool(self):
        for prefix in ("kemory", "s9nmem"):
            for tool in self.READ_ONLY:
                name = f"mcp__plugin_kemory_kemory__{prefix}_{tool}"
                with self.subTest(tool=name):
                    self.assertEqual(self._decision(self.approve(name).stdout),
                                     "allow")

    def test_approve_never_allows_a_write(self):
        # This is the assertion that stops a future "simplification" of the
        # allowlist into a regex over the tool family.
        for prefix in ("kemory", "s9nmem"):
            for tool in self.WRITES:
                name = f"mcp__plugin_kemory_kemory__{prefix}_{tool}"
                with self.subTest(tool=name):
                    self.assertIsNone(self._decision(self.approve(name).stdout),
                                      f"{tool} is a write and must still prompt")

    def test_approve_covers_grok_tool_names(self):
        # Grok Build names an MCP tool <server>__<tool>, with no mcp__ prefix.
        self.assertEqual(self._decision(self.approve("kemory__kemory_recall_memory").stdout), "allow")
        self.assertIsNone(self._decision(self.approve("kemory__kemory_store_memory").stdout),
                          "a write must still prompt under Grok's names too")

    def test_approve_ignores_non_kemory_tools(self):
        for name in ("Bash", "Read", "mcp__other__search_memory", "other__search_memory"):
            with self.subTest(tool=name):
                self.assertIsNone(self._decision(self.approve(name).stdout))

    def test_approve_silent_on_unparseable_input(self):
        r = subprocess.run([str(SCRIPTS / "recall-approve.sh")], input="not json",
                           text=True, capture_output=True, env=self.env())
        self.assertIsNone(self._decision(r.stdout))

    def test_approve_never_denies(self):
        for name in ("mcp__plugin_kemory_kemory__kemory_store_memory", "Bash"):
            with self.subTest(tool=name):
                self.assertNotIn("deny", self.approve(name).stdout)


if __name__ == "__main__":
    unittest.main()
