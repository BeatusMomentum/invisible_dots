"""A provider's tool_call id names a call only inside its own response.

OpenRouter routes to models that reuse ids ("call_0") in every response, in every
session. The gate, the intents and the approvals must keep such calls apart: by
session, and over time inside one session.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from nanobot.agent.tools.gate_types import Allow, GateCall, Park
from nanobot.dots import store as s
from nanobot.dots.gate import close_open_calls, decide_tool_call, record_skipped
from nanobot.dots.protocol import DotRuntimeConfig
from nanobot.dots.store import DotStore

CHAT = s.CHAT_SESSION_KEY
MakeConfig = Callable[[dict[str, str]], DotRuntimeConfig]
ID = "call_0"


def exec_call(command: str, session: str) -> GateCall:
    return GateCall("exec", {"command": command}, ID, session)


def calls_message(*names: str) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {"id": ID, "type": "function", "function": {"name": name, "arguments": "{}"}} for name in names
        ],
    }


def result(content: str, name: str = "exec") -> dict[str, Any]:
    return {"role": "tool", "tool_call_id": ID, "name": name, "content": content}


def append(store: DotStore, session: str, *messages: dict[str, Any]) -> None:
    store.write(lambda c: s.append_messages(c, session, list(messages), final_index=None))


def tool_called(store: DotStore) -> list[dict[str, Any]]:
    return [e["data"] for e in store.read(lambda c: s.read_outbox_after(c, 0, 200)) if e["type"] == "tool.called"]


def requested(store: DotStore) -> list[dict[str, Any]]:
    return [e["data"] for e in store.read(lambda c: s.read_outbox_after(c, 0, 200)) if e["type"] == "approval.requested"]


def approve_and_tell(store: DotStore, approval_id: str) -> None:
    for before, after in (("pending", "approved"), ("approved", "granted")):
        assert store.write(lambda c, b=before, a=after: s.advance_approval(c, approval_id, b, a))


def two_tasks(store: DotStore) -> tuple[str, str]:
    for task_id in ("t1", "t2"):
        store.write(lambda c, t=task_id: s.enqueue_task(c, task_id=t, description="d", priority=0))
    return s.task_session_key("t1"), s.task_session_key("t2")


def test_a_later_turn_of_a_session_that_reuses_an_id_is_asked_again(dot_store: DotStore, make_config: MakeConfig) -> None:
    config = make_config({"computer.exec": "ask"})
    # Turn 1: the call parks, is approved, is made again and runs.
    first = decide_tool_call(exec_call("ls", CHAT), config, dot_store)
    assert isinstance(first, Park)
    append(dot_store, CHAT, calls_message("exec"), result(first.message))
    approve_and_tell(dot_store, first.approval_id)
    assert decide_tool_call(exec_call("ls", CHAT), config, dot_store) == Allow("computer.exec", "ask")
    dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent(ID, "exec", CHAT, None, s.clock_ms())))
    append(dot_store, CHAT, calls_message("exec"), result("file"))
    assert dot_store.read(lambda c: s.get_approval(c, first.approval_id)).status == "done"

    # Turn 2 reuses the id for another call: it is its own call and is asked.
    second = decide_tool_call(exec_call("rm -r data", CHAT), config, dot_store)

    assert isinstance(second, Park)
    assert second.approval_id != first.approval_id
    assert [e["arguments"] for e in requested(dot_store)] == [{"command": "ls"}, {"command": "rm -r data"}]
    stored = dot_store.read(lambda c: s.get_approval(c, second.approval_id))
    assert stored is not None and stored.status == "pending" and stored.arguments == {"command": "rm -r data"}


def test_a_second_call_with_the_id_of_a_pending_approval_is_its_own_call_when_it_differs(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    config = make_config({"computer.exec": "ask"})
    first = decide_tool_call(exec_call("ls", CHAT), config, dot_store)
    assert isinstance(first, Park)
    append(dot_store, CHAT, calls_message("exec"), result(first.message))

    # The user wrote again before deciding, and the model reused the id.
    second = decide_tool_call(exec_call("rm -r data", CHAT), config, dot_store)

    assert isinstance(second, Park) and second.approval_id != first.approval_id
    assert len(requested(dot_store)) == 2


def test_the_same_call_asked_again_while_its_approval_is_pending_is_not_asked_twice(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    config = make_config({"computer.exec": "ask"})
    first = decide_tool_call(exec_call("ls", CHAT), config, dot_store)
    again = decide_tool_call(exec_call("ls", CHAT), config, dot_store)
    assert isinstance(first, Park) and isinstance(again, Park)
    assert again.approval_id == first.approval_id
    assert len(requested(dot_store)) == 1


def test_sessions_that_use_the_same_id_at_the_same_time_are_asked_apart(dot_store: DotStore, make_config: MakeConfig) -> None:
    x, y = two_tasks(dot_store)
    config = make_config({"computer.exec": "ask"})

    for_x = decide_tool_call(exec_call("ls", x), config, dot_store)
    for_y = decide_tool_call(exec_call("whoami", y), config, dot_store)

    assert isinstance(for_x, Park) and isinstance(for_y, Park)
    assert for_x.approval_id != for_y.approval_id
    by_task = {e["task_id"]: e["arguments"] for e in requested(dot_store)}
    assert by_task == {"t1": {"command": "ls"}, "t2": {"command": "whoami"}}
    # Each is closed with its own approval id.
    for session, parked in ((x, for_x), (y, for_y)):
        append(dot_store, session, calls_message("exec"))
        (closed,) = dot_store.write(lambda c, k=session: close_open_calls(c, k))
        assert parked.approval_id in closed["content"]


def test_an_approval_is_used_by_the_call_of_its_own_session_only(dot_store: DotStore, make_config: MakeConfig) -> None:
    x, y = two_tasks(dot_store)
    config = make_config({"computer.exec": "ask"})
    for_x = decide_tool_call(exec_call("ls", x), config, dot_store)
    for_y = decide_tool_call(exec_call("ls", y), config, dot_store)
    assert isinstance(for_x, Park) and isinstance(for_y, Park)
    approve_and_tell(dot_store, for_x.approval_id)
    approve_and_tell(dot_store, for_y.approval_id)

    assert decide_tool_call(exec_call("ls", x), config, dot_store) == Allow("computer.exec", "ask")
    assert decide_tool_call(exec_call("ls", y), config, dot_store) == Allow("computer.exec", "ask")
    for session in (x, y):
        dot_store.write(lambda c, k=session: s.record_tool_intent(c, s.ToolIntent(ID, "exec", k, None, s.clock_ms())))
    # X's result commits first: only X's approval is done.
    append(dot_store, x, calls_message("exec"), result("x done"))
    status = {a.session_key: a.status for a in (dot_store.read(lambda c, i=i: s.get_approval(c, i)) for i in (for_x.approval_id, for_y.approval_id))}
    assert status == {x: "done", y: "running"}
    append(dot_store, y, calls_message("exec"), result("y done"))
    assert dot_store.read(lambda c: s.get_approval(c, for_y.approval_id)).status == "done"


def test_the_decision_of_one_session_is_not_reported_for_the_same_id_in_another(
    dot_store: DotStore, make_config: MakeConfig
) -> None:
    x, y = two_tasks(dot_store)
    # X's call is denied by policy, Y's is allowed: same id, same time.
    deny = decide_tool_call(GateCall("write_file", {"path": "a", "content": "b"}, ID, x), make_config({"files.write": "deny"}), dot_store)
    assert not isinstance(deny, Allow)
    assert decide_tool_call(exec_call("ls", y), make_config({"computer.exec": "allow"}), dot_store) == Allow("computer.exec", "allow")

    append(dot_store, y, calls_message("exec"), result("file"))
    append(dot_store, x, calls_message("write_file"), result("The Dot's policy denied this call.", "write_file"))

    by_task = {e["task_id"]: e for e in tool_called(dot_store)}
    assert (by_task["t2"]["decision"], by_task["t2"]["ok"]) == ("allow", True)
    assert (by_task["t1"]["decision"], by_task["t1"]["ok"]) == ("deny", False)


def test_the_duration_of_a_call_is_measured_from_its_own_start_when_sessions_share_an_id(dot_store: DotStore) -> None:
    x, y = two_tasks(dot_store)
    now = s.clock_ms()
    dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent(ID, "exec", x, "t1", now - 1_000)))
    dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent(ID, "exec", y, "t2", now - 60_000)))

    append(dot_store, x, calls_message("exec"), result("x"))
    append(dot_store, y, calls_message("exec"), result("y"))

    by_task = {e["task_id"]: e["duration_ms"] for e in tool_called(dot_store)}
    assert 1_000 <= by_task["t1"] < 30_000
    assert by_task["t2"] >= 60_000


def test_an_open_call_is_closed_by_what_its_own_session_recorded(dot_store: DotStore, make_config: MakeConfig) -> None:
    x, y = two_tasks(dot_store)
    # X has an intent for the id; Y's call with the same id never started.
    dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent(ID, "exec", x, "t1", s.clock_ms())))
    append(dot_store, x, calls_message("exec"))
    append(dot_store, y, calls_message("exec"))

    (closed_y,) = dot_store.write(lambda c: close_open_calls(c, y))

    assert closed_y["content"] == "Not executed: the unit ended before this call ran."
    (closed_x,) = dot_store.write(lambda c: close_open_calls(c, x))
    assert "interrupted" in closed_x["content"]


def test_a_skip_is_recorded_against_the_session_of_the_call(dot_store: DotStore) -> None:
    x, y = two_tasks(dot_store)
    record_skipped(dot_store, x, ID)
    append(dot_store, y, calls_message("exec"))
    (closed_y,) = dot_store.write(lambda c: close_open_calls(c, y))
    assert closed_y["content"] == "Not executed: the unit ended before this call ran."

