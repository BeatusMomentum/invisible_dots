"""Tests for token-bounded session history replay."""

from __future__ import annotations

from nanobot.session.manager import Session


def _populated_session(turns: int) -> Session:
    session = Session(key="test:populated")
    for index in range(turns):
        session.messages.append({"role": "user", "content": f"msg-{index}"})
        session.messages.append({"role": "assistant", "content": f"reply-{index}"})
    return session


def _tool_round(call_id: str) -> list[dict]:
    return [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": call_id, "type": "function", "function": {"name": "x", "arguments": "{}"}}
            ],
        },
        {"role": "tool", "tool_call_id": call_id, "name": "x", "content": "ok"},
    ]


def test_default_history_has_no_message_count_limit() -> None:
    session = _populated_session(1_001)

    history = session.get_history()

    assert len(history) == 2_002
    assert history[0]["content"] == "msg-0"
    assert history[-1]["content"] == "reply-1000"


def test_explicit_message_limit_still_starts_at_user_turn() -> None:
    history = _populated_session(30).get_history(max_messages=25)

    assert len(history) <= 25
    assert history[0]["role"] == "user"

