"""What `tool.called` shows of a call: one line, never the content a person typed."""

from __future__ import annotations

from typing import Any

import pytest

from nanobot.dots.permissions import tool_target
from nanobot.dots.protocol import TOOL_TARGET_MAX


class TestTheTargetOfEachTool:
    @pytest.mark.parametrize(
        ("tool", "arguments", "target"),
        [
            ("exec", {"command": "ls -la /home/dot"}, "ls -la /home/dot"),
            ("exec", {"cmd": "pwd"}, "pwd"),
            ("exec", {"command": "", "cmd": "pwd"}, "pwd"),
            ("exec", {"command": "python3", "tty": True}, "python3"),
            ("exec", {"command": "echo one\necho two\n"}, "echo one"),
            ("exec", {"command": "\n\n  make test  \nmake lint"}, "make test"),
            ("exec", {}, None),
            ("exec", {"command": "   "}, None),
            ("exec", {"command": 5}, None),
            ("exec_session", {"session_id": "ab12", "input": "my password\n"}, "input to ab12"),
            ("exec_session", {"session_id": "ab12", "input": ""}, "input to ab12"),
            ("exec_session", {"session_id": "ab12", "terminate": True}, "terminate ab12"),
            ("exec_session", {"session_id": "ab12", "wait_for": "ready"}, "output of ab12"),
            ("exec_session", {"session_id": "ab12", "input": None}, "output of ab12"),
            ("exec_session", {}, None),
            ("list_exec_sessions", {}, None),
            ("read_file", {"path": "/home/dot/workspace/a.py", "offset": 3}, "/home/dot/workspace/a.py"),
            ("list_dir", {"path": "src"}, "src"),
            ("write_file", {"path": "notes/a.md", "content": "SECRET BODY"}, "notes/a.md"),
            ("edit_file", {"path": "a.md", "old_text": "SECRET", "new_text": "OTHER"}, "a.md"),
            ("read_file", {}, None),
            ("read_file", {"path": ["a"]}, None),
            ("find_files", {"query": "readme", "path": "docs"}, "readme"),
            ("find_files", {"glob": "**/*.py"}, "**/*.py"),
            ("find_files", {"path": "docs"}, "docs"),
            ("find_files", {}, None),
            ("grep", {"pattern": "TODO", "path": "src"}, "TODO"),
            ("grep", {}, None),
            ("apply_patch", {"edits": [{"path": "a.py", "action": "add", "new_text": "SECRET"}]}, "a.py"),
            (
                "apply_patch",
                {"edits": [{"path": " a.py ", "action": "add"}, {"path": "b.py", "action": "add"}, {"path": "c.py", "action": "add"}]},
                "3 files, first a.py",
            ),
            ("apply_patch", {"edits": [{"action": "add"}, "x", {"path": "", "action": "add"}]}, None),
            ("apply_patch", {"edits": "nope"}, None),
            ("apply_patch", {}, None),
            ("cron", {"action": "add", "name": "daily-standup", "message": "SECRET INSTRUCTION", "every_seconds": 60}, "add daily-standup"),
            ("cron", {"action": "list"}, "list"),
            ("cron", {"action": "remove", "job_id": "j1"}, "remove j1"),
            ("cron", {"name": "x"}, None),
        ],
    )
    def test_names_what_the_call_acted_on(self, tool: str, arguments: dict[str, Any], target: str | None) -> None:
        assert tool_target(tool, arguments) == target

    def test_a_tool_that_is_not_the_dots_has_no_target(self) -> None:
        assert tool_target("web_search", {"query": "x"}) is None
        assert tool_target("", {"path": "x"}) is None

    @pytest.mark.parametrize("arguments", [None, "ls", ["ls"], 5])
    def test_arguments_that_are_not_an_object_have_no_target(self, arguments: Any) -> None:
        assert tool_target("exec", arguments) is None

    def test_content_a_person_or_the_model_wrote_is_in_no_target(self) -> None:
        secret = "HUNTER2-BODY"
        seen = [
            tool_target("write_file", {"path": "a.md", "content": secret}),
            tool_target("edit_file", {"path": "a.md", "old_text": secret, "new_text": secret}),
            tool_target("exec_session", {"session_id": "s1", "input": secret, "wait_for": secret}),
            tool_target("cron", {"action": "add", "name": "n", "message": secret}),
            tool_target("apply_patch", {"edits": [{"path": "a.md", "action": "add", "new_text": secret}]}),
        ]
        assert all(secret not in (target or "") for target in seen)


class TestOneLineAndItsLength:
    def test_exec_cuts_its_first_line_at_the_maximum_with_an_ellipsis(self) -> None:
        target = tool_target("exec", {"command": "echo " + "a" * 300})
        assert target is not None and len(target) == TOOL_TARGET_MAX
        assert target.endswith("…") and target.startswith("echo aaa")

    def test_a_command_of_exactly_the_limit_is_not_cut(self) -> None:
        command = "x" * TOOL_TARGET_MAX
        assert tool_target("exec", {"command": command}) == command

    def test_every_other_target_is_cut_at_the_contract_maximum(self) -> None:
        target = tool_target("read_file", {"path": "/" + "d/" * 200})
        assert target is not None and len(target) == TOOL_TARGET_MAX == 160
        assert target.endswith("…")

    def test_the_maximum_counts_code_points_as_the_hosts_schema_does(self) -> None:
        # A character outside the BMP is one character here and in zod 4, which counts code points and
        # not UTF-16 units. packages/shared/test/events.test.ts checks this very string against the schema.
        target = tool_target("read_file", {"path": "\U0001f600" * 200})
        assert target == "\U0001f600" * 159 + "…"
        assert len(target) == TOOL_TARGET_MAX

    def test_the_maximum_is_never_exceeded_by_what_a_tool_adds_to_a_name(self) -> None:
        target = tool_target("cron", {"action": "add", "name": "n" * 500})
        assert target is not None and len(target) <= TOOL_TARGET_MAX

    @pytest.mark.parametrize("path", ["a\nb.txt", "a\r\nb.txt", "a\tb\x00c\x1b[31m.txt"])
    def test_a_target_is_one_line_without_control_characters(self, path: str) -> None:
        target = tool_target("read_file", {"path": path})
        assert target is not None
        assert not any(ord(ch) < 32 or ord(ch) == 127 for ch in target)

    def test_a_multi_line_search_term_is_one_line(self) -> None:
        assert tool_target("grep", {"pattern": "a\nb"}) == "a b"
