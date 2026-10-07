"""The Dot's policy on every tool call."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from nanobot.agent.tools.gate_types import SKIPPED_MESSAGE, Allow, Deny, GateCall, Park
from nanobot.agent.transcript_metadata import METADATA_KEY
from nanobot.dots import store as s
from nanobot.dots.gate import (
    DotsGate,
    close_open_calls,
    decide_tool_call,
    park_message,
    record_skipped,
)
from nanobot.dots.protocol import DotRuntimeConfig
from nanobot.dots.store import DotStore
from nanobot.dots.transcript_outbox import CLOSED

CHAT = s.CHAT_SESSION_KEY
MakeConfig = Callable[[dict[str, str]], DotRuntimeConfig]


def call(tool: str, params: object = None, call_id: str | None = "c1", session: str | None = CHAT) -> GateCall:
    return GateCall(tool, {} if params is None else params, call_id, session)


def approvals(store: DotStore) -> list[s.Approval]:
    return store.read(lambda c: s.list_approvals(c, "pending"))


def requested_events(store: DotStore) -> list[dict[str, Any]]:
    return [e for e in store.read(lambda c: s.read_outbox_after(c, 0, 50)) if e["type"] == "approval.requested"]


def take_decision(store: DotStore, call_id: str, session: str = CHAT) -> str | None:
    return store.write(lambda c: s.take_tool_decision(c, session, call_id))


def test_fails_closed_with_no_config_or_no_store(dot_store: DotStore, make_config: MakeConfig) -> None:
    read = call("read_file", {"path": "a"})
    no_config = decide_tool_call(read, None, dot_store)
    assert isinstance(no_config, Deny) and "no configuration" in no_config.reason
    no_store = decide_tool_call(read, make_config({"files.read": "allow"}), None)
    assert isinstance(no_store, Deny) and no_store.permission == "files.read"
    assert take_decision(dot_store, "c1") is None


def test_denies_a_tool_with_no_permission_and_a_permission_missing_from_the_pushed_map(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    config = make_config({"files.read": "allow"})
    unknown = decide_tool_call(call("gateway", call_id="c1"), config, dot_store)
    assert isinstance(unknown, Deny) and unknown.permission == ""
    assert unknown.reason == 'The tool "gateway" is not available to this Dot.'
    missing = decide_tool_call(call("exec", {"command": "ls"}, "c2"), config, dot_store)
    assert isinstance(missing, Deny) and missing.permission == "computer.exec"
    assert missing.reason == "The Dot's policy denies computer.exec."
    assert take_decision(dot_store, "c1") == "deny"
    assert take_decision(dot_store, "c2") == "deny"


def test_follows_allow_and_deny_from_the_map(dot_store: DotStore, make_config: MakeConfig) -> None:
    config = make_config({"computer.exec": "allow", "files.write": "deny"})
    assert decide_tool_call(call("exec"), config, dot_store) == Allow("computer.exec", "allow")
    denied = decide_tool_call(call("write_file", call_id="c2"), config, dot_store)
    assert isinstance(denied, Deny) and denied.permission == "files.write"
    assert approvals(dot_store) == []
    # An allowed call leaves no decision: a call with no row was allowed.
    assert take_decision(dot_store, "c1") is None
    assert take_decision(dot_store, "c2") == "deny"


def test_a_call_with_no_id_is_denied_without_a_record_and_allowed_when_the_map_allows_it(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    config = make_config({"computer.exec": "allow"})
    assert isinstance(decide_tool_call(call("write_file", call_id=None), config, dot_store), Deny)
    assert decide_tool_call(call("exec", call_id=None), config, dot_store) == Allow("computer.exec", "allow")
    assert dot_store.read(lambda c: c.execute("SELECT COUNT(*) FROM dots_tool_decisions").fetchone()[0]) == 0


def test_an_ask_with_no_session_or_no_call_id_has_nowhere_to_wait_and_is_denied(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    config = make_config({"computer.exec": "ask"})
    for gate_call in (call("exec", session=None), call("exec", session=""), call("exec", call_id=None), call("exec", call_id="")):
        decision = decide_tool_call(gate_call, config, dot_store)
        assert isinstance(decision, Deny) and "no session to wait in" in decision.reason
    assert approvals(dot_store) == []
    assert requested_events(dot_store) == []


def test_asks_it_records_the_call_with_its_full_arguments_and_tells_the_host_in_one_transaction(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    dot_store.write(lambda c: s.enqueue_task(c, task_id="t1", description="d", priority=0))
    session = s.task_session_key("t1")
    args = {"path": "/home/dot/workspace/a.txt", "content": "hello"}
    decision = decide_tool_call(call("write_file", args, "call-7", session), make_config({"files.write": "ask"}), dot_store)
    assert isinstance(decision, Park)
    assert decision.permission == "files.write"
    assert decision.message == park_message(decision.approval_id)
    stored = dot_store.read(lambda c: s.get_approval(c, decision.approval_id))
    assert stored is not None and stored.approval_id == decision.approval_id
    assert (stored.status, stored.session_key, stored.task_id, stored.tool, stored.arguments) == (
        "pending",
        session,
        "t1",
        "write_file",
        args,
    )
    events = requested_events(dot_store)
    assert len(events) == 1
    assert events[0]["data"] == {
        "approval_id": stored.approval_id,
        "task_id": "t1",
        "tool": "write_file",
        "permission": "files.write",
        "arguments": args,
        "reason": "The Dot's policy asks before files.write.",
    }
    assert take_decision(dot_store, "call-7", session) == "park"


def test_the_approval_of_a_chat_call_names_no_task(dot_store: DotStore, make_config: MakeConfig) -> None:
    decision = decide_tool_call(call("exec", {"command": "ls"}), make_config({"computer.exec": "ask"}), dot_store)
    assert isinstance(decision, Park)
    stored = dot_store.read(lambda c: s.get_approval(c, decision.approval_id))
    assert stored is not None and stored.task_id is None
    assert "task_id" not in requested_events(dot_store)[0]["data"]


def test_asks_once_per_call_a_retried_turn_reuses_the_approval_and_tells_the_host_nothing_new(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    config = make_config({"computer.exec": "ask"})
    gate_call = call("exec", {"command": "rm x"}, "call-1")
    first = decide_tool_call(gate_call, config, dot_store)
    second = decide_tool_call(gate_call, config, dot_store)
    assert isinstance(first, Park) and isinstance(second, Park)
    assert first.approval_id == second.approval_id
    assert len(requested_events(dot_store)) == 1


def test_lets_through_once_only_the_approved_call_made_again_in_its_session_with_exactly_its_arguments(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    config = make_config({"computer.exec": "ask"})

    def exec_call(call_id: str, params: dict[str, Any], session: str = CHAT) -> Any:
        return decide_tool_call(call("exec", params, call_id, session), config, dot_store)

    asked = exec_call("call-1", {"command": "echo hi", "cwd": "/tmp"})
    assert isinstance(asked, Park)
    approval_id = asked.approval_id
    # Approved, but the session has not been told yet: nothing passes.
    dot_store.write(lambda c: s.advance_approval(c, approval_id, "pending", "approved"))
    assert isinstance(exec_call("call-2", {"command": "echo hi", "cwd": "/tmp"}), Park)
    dot_store.write(lambda c: s.advance_approval(c, approval_id, "approved", "granted"))
    # Different arguments, or another session: not this approval.
    assert isinstance(exec_call("call-3", {"command": "echo HI", "cwd": "/tmp"}), Park)
    assert isinstance(exec_call("call-4", {"command": "echo hi", "cwd": "/tmp"}, "task:other"), Park)
    # Key order does not matter; the arguments must be the same.
    assert exec_call("call-5", {"cwd": "/tmp", "command": "echo hi"}) == Allow("computer.exec", "ask")
    running = dot_store.read(lambda c: s.get_approval(c, approval_id))
    assert (running.status, running.run_tool_call_id) == ("running", "call-5")
    assert take_decision(dot_store, "call-5") == "ask"
    # Once: the same call again is asked about anew.
    assert isinstance(exec_call("call-6", {"command": "echo hi", "cwd": "/tmp"}), Park)


def test_a_different_tool_with_the_same_arguments_does_not_use_the_approval(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    config = make_config({"computer.exec": "ask", "files.write": "ask"})
    asked = decide_tool_call(call("exec", {"command": "x"}, "call-1"), config, dot_store)
    assert isinstance(asked, Park)
    for before, after in (("pending", "approved"), ("approved", "granted")):
        dot_store.write(lambda c, b=before, a=after: s.advance_approval(c, asked.approval_id, b, a))  # type: ignore[arg-type]
    assert isinstance(decide_tool_call(call("write_file", {"command": "x"}, "call-2"), config, dot_store), Park)


def test_the_policy_in_force_at_the_moment_of_the_call_decides(dot_store: DotStore, make_config: MakeConfig) -> None:
    config = make_config({"computer.exec": "allow"})
    gate = DotsGate(lambda: config, dot_store)
    assert gate.decide(call("exec", call_id="c1")) == Allow("computer.exec", "allow")
    config = make_config({"computer.exec": "deny"})
    assert isinstance(gate.decide(call("exec", call_id="c2")), Deny)


def test_a_gate_with_no_config_yet_denies(dot_store: DotStore) -> None:
    gate = DotsGate(lambda: None, dot_store)
    assert isinstance(gate.decide(call("exec")), Deny)


def test_record_skipped_marks_a_call_that_a_park_kept_from_running(dot_store: DotStore) -> None:
    record_skipped(dot_store, CHAT, "call-2")
    assert dot_store.read(lambda c: s.peek_tool_decision(c, CHAT, "call-2")) == "skipped"
    # Its result reports nothing, and consumes the mark.
    dot_store.write(
        lambda c: s.append_messages(
            c, CHAT, [{"role": "tool", "tool_call_id": "call-2", "name": "exec", "content": "Not executed"}], final_index=None
        )
    )
    assert dot_store.read(lambda c: s.read_outbox_after(c, 0, 10)) == []
    assert dot_store.read(lambda c: s.peek_tool_decision(c, CHAT, "call-2")) is None


def test_the_gate_skips_through_its_store(dot_store: DotStore, make_config: MakeConfig) -> None:
    gate = DotsGate(lambda: make_config({}), dot_store)
    gate.skip("call-9", CHAT)
    assert dot_store.read(lambda c: s.peek_tool_decision(c, CHAT, "call-9")) == "skipped"


def test_a_parked_then_skipped_response_reports_nothing_until_a_call_runs(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    gate = DotsGate(lambda: make_config({"computer.exec": "ask", "files.read": "allow"}), dot_store)
    parked = gate.decide(call("exec", {"command": "ls"}, "call-1"))
    assert isinstance(parked, Park)
    gate.skip("call-2", CHAT)
    messages = [
        {"role": "tool", "tool_call_id": "call-1", "name": "exec", "content": park_message(parked.approval_id)},
        {"role": "tool", "tool_call_id": "call-2", "name": "read_file", "content": "Not executed"},
    ]
    dot_store.write(lambda c: s.append_messages(c, CHAT, messages, final_index=None))
    assert [e["type"] for e in dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))] == ["approval.requested"]


def test_the_park_message_names_the_approval_and_tells_the_model_not_to_repeat_the_call() -> None:
    message = park_message("appr_1")
    assert "(appr_1)" in message
    assert message.startswith("This call needs the user's approval")
    assert "Do not call it again" in message


class TestClosingOpenCalls:
    """A call the process or the turn left without a result is closed by what the database holds for it."""

    def open_calls(self, store: DotStore, *names: str) -> None:
        calls = [
            {"id": f"c{index}", "type": "function", "function": {"name": name, "arguments": "{}"}}
            for index, name in enumerate(names, 1)
        ]
        store.write(
            lambda c: s.append_messages(
                c, CHAT, [{"role": "user", "content": "go"}, {"role": "assistant", "content": None, "tool_calls": calls}],
                final_index=None,
            )
        )

    def close(self, store: DotStore) -> list[dict[str, Any]]:
        return store.write(lambda c: close_open_calls(c, CHAT))

    def events(self, store: DotStore) -> list[tuple[str, dict[str, Any]]]:
        return [(e["type"], e["data"]) for e in store.read(lambda c: s.read_outbox_after(c, 0, 50))]

    def test_a_call_with_nothing_recorded_never_started(self, dot_store: DotStore) -> None:
        self.open_calls(dot_store, "exec")

        (closed,) = self.close(dot_store)

        assert closed == {
            "role": "tool",
            "tool_call_id": "c1",
            "name": "exec",
            "content": "Not executed: the unit ended before this call ran.",
            METADATA_KEY: {CLOSED: "not_run"},
        }
        assert self.events(dot_store) == []
        assert dot_store.read(lambda c: s.read_messages(c, CHAT))[-1] == closed

    def test_a_call_with_an_intent_was_interrupted_and_may_have_taken_effect(self, dot_store: DotStore) -> None:
        self.open_calls(dot_store, "exec")
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c1", "exec", CHAT, None, s.clock_ms())))

        (closed,) = self.close(dot_store)

        assert closed["content"] == (
            "This call was interrupted before its result was recorded. It may have taken effect, "
            "and it may still be running. Check the current state before calling it again."
        )
        assert closed[METADATA_KEY] == {CLOSED: "interrupted"}
        assert self.events(dot_store) == [
            (
                "tool.called",
                {"tool": "exec", "permission": "computer.exec", "decision": "allow", "ok": False, "duration_ms": 0, "interrupted": True},
            )
        ]
        assert dot_store.read(lambda c: s.peek_tool_intent(c, CHAT, "c1")) is None

    def test_an_interrupted_call_that_used_an_approval_says_so_and_ends_the_approval(self, dot_store: DotStore) -> None:
        self.open_calls(dot_store, "exec")
        approval, _ = dot_store.write(
            lambda c: s.request_approval(
                c, session_key=CHAT, task_id=None, tool_call_id="c0", tool="exec", permission="computer.exec", arguments={}
            )
        )
        for before, after in (("pending", "approved"), ("approved", "granted")):
            dot_store.write(lambda c, b=before, a=after: s.advance_approval(c, approval.approval_id, b, a))
        dot_store.write(lambda c: s.advance_approval(c, approval.approval_id, "granted", "running", run_tool_call_id="c1"))
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "c1", "ask"))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c1", "exec", CHAT, None, s.clock_ms())))

        (closed,) = self.close(dot_store)

        assert closed["content"].endswith("Check the current state before calling it again. The approval was used.")
        (kind, data) = self.events(dot_store)[0]
        assert kind == "tool.called" and data["decision"] == "ask" and data["interrupted"] is True
        assert dot_store.read(lambda c: s.get_approval(c, approval.approval_id)).status == "done"

    def test_a_parked_call_says_again_that_it_waits_for_the_user(self, dot_store: DotStore, make_config: MakeConfig) -> None:
        self.open_calls(dot_store, "exec")
        decision = decide_tool_call(call("exec", {"command": "ls"}, "c1"), make_config({"computer.exec": "ask"}), dot_store)
        assert isinstance(decision, Park)

        (closed,) = self.close(dot_store)

        assert closed["content"] == park_message(decision.approval_id)
        assert closed[METADATA_KEY] == {CLOSED: "not_run"}
        assert [kind for kind, _ in self.events(dot_store)] == ["approval.requested"]

    def test_a_denied_call_is_closed_as_denied_and_reported(self, dot_store: DotStore) -> None:
        self.open_calls(dot_store, "write_file")
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "c1", "deny"))

        (closed,) = self.close(dot_store)

        assert closed["content"] == "The Dot's policy denied this call."
        assert METADATA_KEY not in closed
        assert self.events(dot_store) == [
            (
                "tool.called",
                {"tool": "write_file", "permission": "files.write", "decision": "deny", "ok": False, "duration_ms": 0},
            )
        ]

    def test_a_skipped_call_says_that_an_earlier_one_is_waiting(self, dot_store: DotStore) -> None:
        self.open_calls(dot_store, "exec")
        record_skipped(dot_store, CHAT, "c1")

        (closed,) = self.close(dot_store)

        assert closed["content"] == SKIPPED_MESSAGE
        assert closed[METADATA_KEY] == {CLOSED: "not_run"}
        assert self.events(dot_store) == []

    def test_only_the_calls_without_a_result_are_closed_and_closing_twice_adds_nothing(self, dot_store: DotStore) -> None:
        self.open_calls(dot_store, "exec", "read_file", "grep")
        dot_store.write(
            lambda c: s.append_messages(
                c, CHAT, [{"role": "tool", "tool_call_id": "c2", "name": "read_file", "content": "done"}], final_index=None
            )
        )

        closed = self.close(dot_store)

        assert [message["tool_call_id"] for message in closed] == ["c1", "c3"]
        assert self.close(dot_store) == []

    def test_a_call_with_no_name_is_called_unknown(self, dot_store: DotStore) -> None:
        dot_store.write(
            lambda c: s.append_messages(
                c, CHAT, [{"role": "assistant", "content": None, "tool_calls": [{"id": "x", "type": "function"}]}], final_index=None
            )
        )

        (closed,) = self.close(dot_store)

        assert closed["name"] == "unknown"

    def test_an_approved_call_the_gate_let_through_and_that_never_started_gives_its_approval_back(
        self, dot_store: DotStore
    ) -> None:
        self.open_calls(dot_store, "exec")
        approval, _ = dot_store.write(
            lambda c: s.request_approval(
                c, session_key=CHAT, task_id=None, tool_call_id="c0", tool="exec", permission="computer.exec", arguments={}
            )
        )
        for before, after in (("pending", "approved"), ("approved", "granted")):
            dot_store.write(lambda c, b=before, a=after: s.advance_approval(c, approval.approval_id, b, a))
        dot_store.write(lambda c: s.advance_approval(c, approval.approval_id, "granted", "running", run_tool_call_id="c1"))
        dot_store.write(lambda c: s.record_tool_decision(c, CHAT, "c1", "ask"))

        (closed,) = self.close(dot_store)

        # It did not run, and says so; the approval is not used up, so the session is told again.
        assert closed["content"] == "Not executed: the unit ended before this call ran."
        assert closed[METADATA_KEY] == {CLOSED: "not_run"}
        assert self.events(dot_store) == []
        assert dot_store.read(lambda c: s.get_approval(c, approval.approval_id)).status == "approved"
