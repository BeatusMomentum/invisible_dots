"""The Dot's prompts: its system prompt around the transcript."""

from __future__ import annotations

from datetime import datetime, timezone

from nanobot.agent.context import ContextBuilder, TranscriptInput

NOW = datetime(2026, 10, 5, 14, 30, tzinfo=timezone.utc)
DOT = 'You are the Dot "fare-watch". Your goal:\nWatch fares.'


def builder(memory_notes: list[str] | None = None) -> ContextBuilder:
    return ContextBuilder(
        DOT,
        workspace="/home/dot/workspace",
        memory_dir="/home/dot/memory",
        memory_notes=memory_notes,
        now=NOW,
    )


def test_the_system_prompt_is_the_dot_the_tool_contract_and_its_computer() -> None:
    prompt = builder().build_system_prompt()

    sections = prompt.split("\n\n---\n\n")
    assert sections[0] == DOT
    assert sections[1].startswith("# Tool Usage Notes")
    assert "You run on your own Linux computer." in sections[2]
    assert "run as the user dot" in sections[2]
    assert "Your workspace is /home/dot/workspace." in sections[2]
    assert "The current time is 2026-10-05 14:30 UTC." in sections[2]
    assert "untrusted external data" in sections[2]
    assert len(sections) == 3


def test_nothing_of_the_upstream_assistants_identity_or_platform_is_left() -> None:
    prompt = builder().build_system_prompt()

    for leftover in ("nanobot", "Windows", "POSIX", "channel", "SOUL", "AGENTS", "HEARTBEAT", "skills"):
        assert leftover not in prompt


def test_memory_is_not_mentioned_while_it_is_not_offered() -> None:
    assert "memory" not in builder(None).build_system_prompt().lower()


def test_the_memory_section_says_how_notes_are_written_found_and_read() -> None:
    prompt = builder([]).build_system_prompt()

    assert "Long-term notes live in /home/dot/memory" in prompt
    for tool in ("write_file", "edit_file", "memory_search", "memory_get"):
        assert tool in prompt
    assert "Most recently changed notes" not in prompt


def test_the_memory_section_names_the_notes_it_was_given() -> None:
    prompt = builder(["b.md", "a.md"]).build_system_prompt()

    assert "Most recently changed notes: b.md, a.md." in prompt


def test_a_session_summary_is_added_and_a_nothing_summary_is_not() -> None:
    summary = {"text": "the fares were checked", "last_active": "2026-10-04T10:00:00+00:00"}

    prompt = builder().build_system_prompt(session_summary=summary)

    assert prompt.endswith(
        "[Archived Context Summary]\n\n"
        "Previous conversation summary (last active 2026-10-04T10:00:00+00:00):\n"
        "the fares were checked"
    )
    nothing = {"text": "(nothing)", "last_active": "2026-10-04T10:00:00+00:00"}
    assert "Archived Context Summary" not in builder().build_system_prompt(session_summary=nothing)


def test_the_transcript_is_the_system_prompt_the_history_and_the_current_message() -> None:
    history = [{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "answer"}]

    messages = builder().build_transcript(TranscriptInput(history=history, current_message="now"))

    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]
    assert messages[0]["content"] == builder().build_system_prompt()
    assert messages[1:3] == history
    assert messages[3] == {"role": "user", "content": "now"}


def test_with_no_current_message_the_transcript_ends_with_the_history() -> None:
    history = [{"role": "user", "content": "already in the transcript"}]

    messages = builder().build_transcript(TranscriptInput(history=history, current_message=None))

    assert messages[1:] == history
