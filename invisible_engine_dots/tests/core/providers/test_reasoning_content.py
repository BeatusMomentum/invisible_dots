"""Tests for reasoning_content extraction in OpenAICompatProvider.

Covers the streaming path (_parse_chunks) for providers that return a
reasoning_content field (e.g. MiMo, DeepSeek-R1), and the replay of an empty one.
"""

from types import SimpleNamespace
from unittest.mock import patch

from nanobot.providers.base import LLMResponse, ToolCallRequest
from nanobot.providers.openai_compat_provider import OpenAICompatProvider
from nanobot.utils.helpers import build_assistant_message

def test_tool_call_history_preserves_empty_reasoning_content_after_sanitize() -> None:
    """Empty reasoning_content survives the tool-call history round trip."""
    with patch("nanobot.providers.openai_compat_provider.AsyncOpenAI"):
        provider = OpenAICompatProvider(api_key="test-key")

    result = LLMResponse(
        content="",
        reasoning_content="",
        tool_calls=[ToolCallRequest(id="call_1", name="lookup", arguments={})],
        finish_reason="tool_calls",
    )
    assistant_message = build_assistant_message(
        result.content or "",
        tool_calls=[tc.to_openai_tool_call() for tc in result.tool_calls],
        reasoning_content=result.reasoning_content,
    )
    sanitized = provider._sanitize_messages([
        {"role": "user", "content": "look something up"},
        assistant_message,
        {"role": "tool", "tool_call_id": "call_1", "content": "done"},
    ])

    assert sanitized[1]["reasoning_content"] == ""


# ── _parse_chunks: streaming dict branch ─────────────────────────────────


def test_parse_chunks_dict_accumulates_reasoning_content() -> None:
    """reasoning_content deltas in dict chunks are joined into one string."""
    chunks = [
        {
            "choices": [{
                "finish_reason": None,
                "delta": {"content": None, "reasoning_content": "Step 1. "},
            }],
        },
        {
            "choices": [{
                "finish_reason": None,
                "delta": {"content": None, "reasoning_content": "Step 2."},
            }],
        },
        {
            "choices": [{
                "finish_reason": "stop",
                "delta": {"content": "answer"},
            }],
        },
    ]

    result = OpenAICompatProvider._parse_chunks(chunks)

    assert result.content == "answer"
    assert result.reasoning_content == "Step 1. Step 2."


def test_parse_chunks_dict_reasoning_content_none_when_absent() -> None:
    """reasoning_content is None when no chunk contains it."""
    chunks = [
        {"choices": [{"finish_reason": "stop", "delta": {"content": "hi"}}]},
    ]

    result = OpenAICompatProvider._parse_chunks(chunks)

    assert result.content == "hi"
    assert result.reasoning_content is None


# ── _parse_chunks: streaming SDK-object branch ────────────────────────────


def _make_reasoning_chunk(reasoning: str | None, content: str | None, finish: str | None):
    delta = SimpleNamespace(content=content, reasoning_content=reasoning, tool_calls=None)
    choice = SimpleNamespace(finish_reason=finish, delta=delta)
    return SimpleNamespace(choices=[choice], usage=None)


def test_parse_chunks_sdk_accumulates_reasoning_content() -> None:
    """reasoning_content on SDK delta objects is joined across chunks."""
    chunks = [
        _make_reasoning_chunk("Think… ", None, None),
        _make_reasoning_chunk("Done.", None, None),
        _make_reasoning_chunk(None, "result", "stop"),
    ]

    result = OpenAICompatProvider._parse_chunks(chunks)

    assert result.content == "result"
    assert result.reasoning_content == "Think… Done."


def test_parse_chunks_sdk_reasoning_content_none_when_absent() -> None:
    """reasoning_content is None when SDK deltas carry no reasoning_content."""
    chunks = [_make_reasoning_chunk(None, "hello", "stop")]

    result = OpenAICompatProvider._parse_chunks(chunks)

    assert result.reasoning_content is None
