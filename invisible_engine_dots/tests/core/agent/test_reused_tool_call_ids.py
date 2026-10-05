"""A tool call id names a call only until its result: models behind OpenRouter reuse "call_0" in every response.

The history sent back to the model pairs each result with the assistant message that made the call,
by position. A result is not an orphan or a duplicate because an earlier response used the same id.
"""

from __future__ import annotations

from typing import Any

from nanobot.agent.context_governance import BACKFILL_CONTENT, ContextGovernor


def calls(*pairs: tuple[str, str]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {"id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}} for call_id, name in pairs
        ],
    }


def result(call_id: str, content: str, name: str = "exec") -> dict[str, Any]:
    return {"role": "tool", "tool_call_id": call_id, "name": name, "content": content}


def two_turns() -> list[dict[str, Any]]:
    return [
        {"role": "user", "content": "one"},
        calls(("call_0", "exec")),
        result("call_0", "first output"),
        {"role": "assistant", "content": "done one"},
        {"role": "user", "content": "two"},
        calls(("call_0", "read_file")),
        result("call_0", "second output", "read_file"),
        {"role": "assistant", "content": "done two"},
    ]


def test_the_result_of_a_later_call_that_reuses_an_id_is_kept() -> None:
    messages = two_turns()

    assert ContextGovernor.drop_orphan_tool_results(messages) is messages
    assert ContextGovernor.backfill_missing_tool_results(messages) is messages


def test_a_second_result_for_the_same_call_is_dropped_as_a_duplicate() -> None:
    messages = [calls(("call_0", "exec")), result("call_0", "first"), result("call_0", "duplicate")]

    kept = ContextGovernor.drop_orphan_tool_results(messages)

    assert [m["content"] for m in kept if m["role"] == "tool"] == ["first"]


def test_a_result_before_any_call_with_its_id_is_still_an_orphan_when_the_id_is_used_later() -> None:
    messages = [result("call_0", "stale"), calls(("call_0", "exec")), result("call_0", "ok")]

    kept = ContextGovernor.drop_orphan_tool_results(messages)

    assert [m["content"] for m in kept if m["role"] == "tool"] == ["ok"]


def test_a_later_call_with_a_reused_id_and_no_result_is_given_one() -> None:
    messages = two_turns()[:-2]  # the second call_0 has no result

    repaired = ContextGovernor.backfill_missing_tool_results(messages)

    tools = [m for m in repaired if m["role"] == "tool"]
    assert [m["content"] for m in tools] == ["first output", BACKFILL_CONTENT]
    assert tools[1]["name"] == "read_file"
    assert repaired[-1] is tools[1] and repaired[-2]["role"] == "assistant"


def test_an_earlier_call_without_a_result_is_given_one_even_when_a_later_call_reuses_its_id() -> None:
    messages = [
        {"role": "user", "content": "one"},
        calls(("call_0", "exec")),  # its result was lost
        {"role": "user", "content": "two"},
        calls(("call_0", "read_file")),
        result("call_0", "second output", "read_file"),
    ]

    repaired = ContextGovernor.backfill_missing_tool_results(messages)

    assert [m["role"] for m in repaired] == ["user", "assistant", "tool", "user", "assistant", "tool"]
    assert (repaired[2]["tool_call_id"], repaired[2]["name"], repaired[2]["content"]) == ("call_0", "exec", BACKFILL_CONTENT)
    assert repaired[5]["content"] == "second output"
