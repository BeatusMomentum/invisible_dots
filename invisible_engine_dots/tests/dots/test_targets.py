"""What `tool.called` may show of a call: one redacted line, never the content a person typed."""

from __future__ import annotations

from typing import Any

import pytest

from nanobot.dots import targets
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
            ("memory_search", {"query": "rome trip"}, "rome trip"),
            ("memory_search", {}, None),
            ("memory_get", {"name": "trips"}, "trips"),
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
    def test_exec_cuts_its_first_line_at_120_characters_with_an_ellipsis(self) -> None:
        target = tool_target("exec", {"command": "echo " + "a" * 300})
        assert target is not None and len(target) == targets.EXEC_TARGET_MAX == 120
        assert target.endswith("…") and target.startswith("echo aaa")

    def test_a_command_of_exactly_the_limit_is_not_cut(self) -> None:
        command = "x" * 120
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
        assert tool_target("memory_search", {"query": "a\nb"}) == "a b"


class TestCredentialsInACommand:
    @pytest.mark.parametrize(
        ("command", "shown"),
        [
            ("curl https://alice:s3cret@example.com/x", "curl https://example.com/x"),
            ("git clone ssh://git:tok@host/repo.git", "git clone ssh://host/repo.git"),
            ("curl -H 'Authorization: Bearer abc.def-123' https://e.com", "curl -H 'Authorization: ***' https://e.com"),
            ('curl -H "Authorization: Basic dXNlcjpwdw==" https://e.com', 'curl -H "Authorization: ***" https://e.com'),
            ("curl -H 'X-Api-Key: k123' https://e.com", "curl -H 'X-Api-Key: ***' https://e.com"),
            ("curl -b 'Cookie: sid=1; a=2' https://e.com", "curl -b 'Cookie: ***' https://e.com"),
            ("curl -u me --header Bearer tok123 x", "curl -u *** --header *** *** x"),
            ("API_KEY=sk-123 python run.py", "API_KEY=*** python run.py"),
            ("export GITHUB_TOKEN='a b c' && make", "export GITHUB_TOKEN=*** && make"),
            ("mysql --password=hunter2 -u root", "mysql --password=*** -u ***"),
            ("mysql --password hunter2 -u root", "mysql --password *** -u ***"),
            ("tool --client-secret \"a b\" --verbose", "tool --client-secret *** --verbose"),
            ("curl 'https://e.com/x?token=abc&page=2'", "curl 'https://e.com/x?token=***&page=***'"),
            ("DB_PASSWORD=pw SECRET_KEY=k run", "DB_PASSWORD=*** SECRET_KEY=*** run"),
        ],
    )
    def test_the_credential_is_masked_and_the_rest_is_kept(self, command: str, shown: str) -> None:
        assert tool_target("exec", {"command": command}) == shown

    @pytest.mark.parametrize(
        "command",
        [
            "echo token generation",
            "grep -rn password docs/",
            "cat /etc/passwd",
            "ls --all --password-less-dir",
            "git log --author=tokens",
            "python3 serve.py 8000",
            "docker run --rm -it ubuntu bash",
            "tar -xzf a.tar -C /srv",
            "mkdir -p /srv/a && cd /srv/a",
            "scp a.txt me@host:/srv/",
            "ssh-keyscan host:22",
            "make 2>&1 | tail -5",
        ],
    )
    def test_a_command_that_only_names_a_word_is_shown_as_it_is(self, command: str) -> None:
        assert tool_target("exec", {"command": command}) == command

    @pytest.mark.parametrize(
        ("command", "shown"),
        [
            ("curl --proxy-user bob:s3cret -x proxy:8080 https://a", "curl --proxy-user *** -x *** https://a"),
            ("curl --proxy-user=bob:s3cret https://a", "curl --proxy-user=*** https://a"),
            ("curl -U bob:s3cret -x proxy:8080 https://a", "curl -U *** -x *** https://a"),
            ("curl -x bob:s3cret@proxy:8080 a", "curl -x *** a"),
            ("curl --proxy bob:s3cret@proxy:8080 a", "curl --proxy *** a"),
            ("curl -u admin:hunter2 https://x.example", "curl -u *** https://x.example"),
            ("curl admin:hunter2@x.example", "curl ***"),
            ("mysql -uroot -phunter2 db", "mysql -u*** -p*** db"),
            ("sshpass -p hunter2 ssh host", "sshpass -p *** ssh host"),
            ("docker login -p hunter2 -u me", "docker login -p *** -u ***"),
            ("redis-cli -a hunter2 ping", "redis-cli -a *** ping"),
            ('curl -H "PRIVATE-TOKEN: abc" x', 'curl -H "PRIVATE-TOKEN: ***" x'),
            ("curl -H'X-Auth: abc' x", "curl -H*** x"),
            ("curl --header='PRIVATE-TOKEN: abc' x", "curl --header=*** x"),
            ("curl https://api.x.com/v1?key=AKIAXYZ123", "curl https://api.x.com/v1?key=***"),
            ("curl https://u:p@h/x#access_token=abc", "curl https://h/x#access_token=***"),
            ("curl --data 'password=abc def' x", "curl --data *** x"),
            ("curl --data password=abc x", "curl --data password=*** x"),
            ("psql 'host=h password=abc dbname=d'", "psql ***"),
            ("psql postgres://u:abc@h/d", "psql postgres://h/d"),
            ("PGPASSWORD=abc psql -h h", "PGPASSWORD=*** psql -h ***"),
            ("echo Bearer abc", "echo Bearer ***"),
            ("http GET h Authorization:'Bearer abc'", "http GET h ***"),
            ("echo $(curl -u a:b x)", "echo $(curl -u *** x)"),
            ("curl -u 'a:b", "curl -u '***"),
            ("curl -- -u", "curl -- -u"),
        ],
    )
    def test_the_credential_forms_of_common_programs_are_masked(self, command: str, shown: str) -> None:
        assert tool_target("exec", {"command": command}) == shown

    @pytest.mark.parametrize("secret", ["s3cret", "hunter2", "AKIAXYZ123", "pa/ss", "12345678", "abc"])
    @pytest.mark.parametrize(
        "template",
        [
            "tool -p {}",
            "tool -p{}",
            "tool -u bob:{}",
            "tool -x bob:{}@proxy:8080",
            "tool --proxy-user bob:{}",
            "tool --password {}",
            "tool --password={}",
            "tool -H 'Authorization: Bearer {}'",
            "tool -H 'Cookie: sid={}'",
            "tool 'https://h/x?token={}'",
            "tool --data 'a b {}'",
            "TOKEN={} tool",
        ],
    )
    def test_the_value_of_a_secret_is_in_no_form_it_is_written_in(self, template: str, secret: str) -> None:
        target = tool_target("exec", {"command": template.format(secret)})
        assert target is not None
        assert secret not in target

    @pytest.mark.parametrize("secret", ["s3cret", "hunter2", "AKIAXYZ123", "12345678", "abc"])
    def test_the_user_and_password_of_a_url_are_in_no_target(self, secret: str) -> None:
        target = tool_target("exec", {"command": f"tool https://bob:{secret}@h/x"})
        assert target == "tool https://h/x"

    def test_only_the_first_line_is_looked_at_so_a_later_line_is_never_shown(self) -> None:
        assert tool_target("exec", {"command": "run.sh\nexport TOKEN=abc"}) == "run.sh"
