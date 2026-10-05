"""What `OpenAICompatProvider.chat_stream` makes of a model's stream: the usage on its response, and a stall.

The stream is a fake of the SDK's: the client's `create` answers with an async iterator of chunks, as the
real one does with `stream=True`, so the whole of `chat_stream` runs (the `include_usage` request, the
idle bound, the parser) with nothing on the network.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from openai.types.chat import ChatCompletionChunk

from nanobot.providers import openai_compat_provider
from nanobot.providers.base import LLMResponse
from nanobot.providers.openai_compat_provider import OpenAICompatProvider
from nanobot.providers.registry import OPENROUTER

MESSAGES: list[dict[str, Any]] = [{"role": "user", "content": "hi"}]
USAGE = {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}


def chunk(delta: dict[str, Any] | None = None, finish: str | None = None, usage: dict[str, Any] | None = None) -> dict[str, Any]:
    """One chat.completion.chunk as JSON; `delta=None` is the usage-only chunk `include_usage` ends the stream with."""
    body: dict[str, Any] = {
        "id": "gen-1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "m",
        "choices": [] if delta is None else [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if usage is not None:
        body["usage"] = usage
    return body


def as_sdk_object(body: dict[str, Any]) -> ChatCompletionChunk:
    return ChatCompletionChunk.model_validate(body)


def as_bare_object(body: dict[str, Any]) -> SimpleNamespace:
    """A chunk with attributes and no `model_dump`: what the parser's attribute branch is for."""
    choices = [
        SimpleNamespace(
            finish_reason=c["finish_reason"],
            delta=SimpleNamespace(content=c["delta"].get("content"), tool_calls=None),
        )
        for c in body["choices"]
    ]
    usage = body.get("usage")
    return SimpleNamespace(choices=choices, usage=SimpleNamespace(**usage) if usage else None)


class FakeStream:
    """The async iterator `create(stream=True)` returns: the chunks, then the end of the stream or silence."""

    def __init__(self, chunks: list[Any], then_silence: bool = False) -> None:
        self._chunks = list(chunks)
        self._then_silence = then_silence

    def __aiter__(self) -> FakeStream:
        return self

    async def __anext__(self) -> Any:
        if self._chunks:
            return self._chunks.pop(0)
        if self._then_silence:
            await asyncio.sleep(3600)
        raise StopAsyncIteration


def provider_streaming(stream: FakeStream) -> tuple[OpenAICompatProvider, AsyncMock]:
    provider = OpenAICompatProvider(
        api_key="sk-or-v1-0123456789abcdef", api_base="https://example.com/v1",
        default_model="m", spec=OPENROUTER, provider_name=OPENROUTER.name,
    )
    create = AsyncMock(return_value=stream)
    provider._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))  # type: ignore[assignment]
    return provider, create


# chat_stream reads `chunk.choices`, so a chunk is an object: the SDK's, which the parser reads through
# `model_dump`, or one with attributes only, which it reads by attribute.
FORMS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "the SDK's chunk objects": as_sdk_object,
    "plain objects": as_bare_object,
}


class TestTheUsageOfAStream:
    @pytest.mark.parametrize("form", FORMS)
    async def test_the_usage_only_chunk_that_ends_a_stream_is_the_responses_usage(self, form: str) -> None:
        make = FORMS[form]
        stream = FakeStream([
            make(chunk({"role": "assistant", "content": "po"})),
            make(chunk({"content": "ng"}, finish="stop")),
            make(chunk(usage=USAGE)),
        ])
        provider, create = provider_streaming(stream)

        response = await provider.chat_stream(MESSAGES, max_tokens=10)

        assert (response.finish_reason, response.content) == ("stop", "pong")
        assert response.usage is not None
        assert (response.usage.input_tokens, response.usage.output_tokens, response.usage.total_tokens) == (11, 7, 18)
        # The usage is there because the request asked the server for it.
        assert create.await_args.kwargs["stream_options"] == {"include_usage": True}

    async def test_usage_on_the_chunk_that_finishes_is_kept(self) -> None:
        stream = FakeStream([
            as_sdk_object(chunk({"role": "assistant", "content": "pong"})),
            as_sdk_object(chunk({}, finish="stop", usage=USAGE)),
        ])
        provider, _ = provider_streaming(stream)

        response = await provider.chat_stream(MESSAGES, max_tokens=10)

        assert response.usage is not None
        assert (response.usage.input_tokens, response.usage.output_tokens) == (11, 7)

    async def test_a_stream_that_reports_no_usage_has_none(self) -> None:
        stream = FakeStream([as_sdk_object(chunk({"content": "pong"}, finish="stop"))])
        provider, _ = provider_streaming(stream)

        response = await provider.chat_stream(MESSAGES, max_tokens=10)

        assert (response.content, response.usage) == ("pong", None)


class TestAStreamThatGoesSilent:
    async def test_it_ends_as_a_timeout_whose_text_is_the_one_owners(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(openai_compat_provider, "STREAM_IDLE_TIMEOUT_S", 0.2)
        stream = FakeStream([as_sdk_object(chunk({"content": "po"}))], then_silence=True)
        provider, _ = provider_streaming(stream)
        # The text of a provider failure comes from `failure_text` and from nowhere else.
        seen: list[BaseException] = []

        def owner(exc: BaseException) -> str:
            seen.append(exc)
            return "the owner's text"

        monkeypatch.setattr(provider, "failure_text", owner)

        response = await provider.chat_stream(MESSAGES, max_tokens=10)

        assert response.content == "the owner's text"
        assert [str(e) for e in seen] == ["stream stalled for more than 0.2 seconds"]
        assert (response.finish_reason, response.error_kind) == ("error", "timeout")

    async def test_the_text_says_what_stalled_and_for_how_long(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(openai_compat_provider, "STREAM_IDLE_TIMEOUT_S", 0.2)
        provider, _ = provider_streaming(FakeStream([], then_silence=True))

        response: LLMResponse = await provider.chat_stream(MESSAGES, max_tokens=10)

        assert response.content == "Error calling LLM: stream stalled for more than 0.2 seconds"
