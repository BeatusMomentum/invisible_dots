"""The key of a session: the chat, and a task's own conversation."""

from __future__ import annotations

from nanobot.dots.store import CHAT_SESSION_KEY, task_session_key


def test_the_keys_are_the_ones_the_design_names() -> None:
    assert CHAT_SESSION_KEY == "chat"
    assert task_session_key("t1") == "task:t1"


def test_a_task_id_survives_a_round_trip_through_its_key() -> None:
    task_id = "task_01J:with:colons"
    assert task_session_key(task_id).removeprefix("task:") == task_id
