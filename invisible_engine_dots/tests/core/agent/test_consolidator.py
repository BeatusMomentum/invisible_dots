"""Tests for the transcript summary (Consolidator) and its mechanical fallback."""

from dataclasses import replace
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.memory import (
    _ARCHIVE_TOOL_RESULT,
    _RAW_CHECKPOINT_MAX_CHARS,
    _SUMMARY_HARD_CAP,
    Consolidator,
    _build_raw_checkpoint,
    _format_messages,
)
from nanobot.providers.base import (
    GenerationSettings,
    LLMResponse,
    ProviderConversationState,
    ToolCallRequest,
)
from nanobot.utils.llm_runtime import LLMRuntime
from nanobot.utils.prompt_templates import render_template

_ARCHIVE_PROMPT = render_template("agent/consolidator_archive.md", strip=True)


@pytest.fixture
def mock_provider():
    p = MagicMock()
    p.chat_stream_with_retry = AsyncMock()
    p.generation = GenerationSettings(max_tokens=100)
    return p


@pytest.fixture
def runtime(mock_provider):
    return LLMRuntime.capture(
        mock_provider,
        "test-model",
        context_window_tokens=1000,
    )


@pytest.fixture
def consolidator():
    return Consolidator()


def _provider_state() -> ProviderConversationState:
    return ProviderConversationState(
        kind="openai_responses",
        provider="openai:test",
        model="test-model",
        version=1,
        payload={"items": []},
    )


async def _archive(
    consolidator,
    messages,
    runtime,
    *,
    session_key="test:session",
    previous_summary=None,
):
    return await consolidator.summarize(
        messages,
        runtime=runtime,
        session_key=session_key,
        history=[
            {"role": "system", "content": "system prompt"},
            *messages,
        ],
        request_tools=[],
        previous_summary=previous_summary,
    )


class TestTurnTranscriptSummary:
    @pytest.mark.parametrize("summary", ["replacement checkpoint", "(nothing)"])
    async def test_uses_exact_accepted_prefix(
        self,
        consolidator,
        mock_provider,
        runtime,
        summary,
    ):
        runtime = replace(runtime, context_window_tokens=4096)
        accepted = [
            {"role": "system", "content": "stable system"},
            {"role": "user", "content": "accepted history"},
        ]
        tools = [{"type": "function", "function": {"name": "inspect"}}]
        mock_provider.chat_stream_with_retry.return_value = LLMResponse(
            content=summary,
        )

        result = await consolidator.summarize_transcript(
            accepted,
            "previous checkpoint",
            runtime=runtime,
            session_key="test:turn",
            tools=tools,
        )

        assert result == summary
        call = mock_provider.chat_stream_with_retry.await_args.kwargs
        assert call["messages"][:-1] == accepted
        assert call["messages"][-1]["role"] == "user"
        assert "SNIP" in call["messages"][-1]["content"]
        assert call["tools"] == tools

    async def test_failure_returns_raw_checkpoint(
        self,
        consolidator,
        mock_provider,
        runtime,
    ):
        accepted = [
            {"role": "system", "content": "stable system"},
            {"role": "user", "content": "accepted history"},
        ]
        mock_provider.chat_stream_with_retry.return_value = LLMResponse(content="")
        consolidator._SAFETY_BUFFER = 0

        result = await consolidator.summarize_transcript(
            accepted,
            None,
            runtime=runtime,
            session_key="test:ephemeral-turn",
            tools=[],
        )

        assert result is not None
        assert "[RAW]" in result
        assert "accepted history" in result

    async def test_native_compaction_appends_only_archive_prompt(
        self,
        consolidator,
        mock_provider,
        runtime,
    ):
        accepted = [
            {"role": "system", "content": "stable system"},
            {"role": "user", "content": "raw history must not be replayed"},
        ]
        state = _provider_state()
        mock_provider.can_resume_conversation_state.return_value = True
        mock_provider.chat_stream_with_retry.return_value = LLMResponse(
            content="replacement checkpoint",
        )

        result = await consolidator.summarize_provider_compaction(
            state,
            accepted,
            "previous checkpoint",
            runtime=runtime,
            session_key="test:turn",
            tools=[{"type": "function", "function": {"name": "inspect"}}],
        )

        assert result == "replacement checkpoint"
        call = mock_provider.chat_stream_with_retry.await_args.kwargs
        assert call["messages"][0] == accepted[0]
        assert call["messages"][-1]["content"] == _ARCHIVE_PROMPT
        assert accepted[1] not in call["messages"]
        assert call["tools"] == []
        provider_context = call["provider_context"]
        assert provider_context.conversation_state is not None
        assert provider_context.conversation_state.payload == state.payload
        assert provider_context.conversation_state.pending_messages == [
            call["messages"][-1],
        ]

    async def test_native_compaction_recovers_tool_call_from_response_state(
        self,
        consolidator,
        mock_provider,
        runtime,
    ):
        accepted = [
            {"role": "system", "content": "stable system"},
            {"role": "user", "content": "raw history must not be replayed"},
        ]
        incoming_state = _provider_state()
        response_state = ProviderConversationState(
            kind="openai_responses",
            provider="openai:test",
            model="test-model",
            version=1,
            payload={"items": [{"type": "function_call", "call_id": "call-1"}]},
        )
        mock_provider.can_resume_conversation_state.return_value = True
        mock_provider.chat_stream_with_retry.side_effect = [
            LLMResponse(
                content=None,
                tool_calls=[ToolCallRequest(id="call-1", name="inspect", arguments={})],
                finish_reason="tool_calls",
                provider_state=response_state,
            ),
            LLMResponse(content="replacement checkpoint", finish_reason="stop"),
        ]

        result = await consolidator.summarize_provider_compaction(
            incoming_state,
            accepted,
            "previous checkpoint",
            runtime=runtime,
            session_key="test:turn",
            tools=[{"type": "function", "function": {"name": "inspect"}}],
        )

        assert result == "replacement checkpoint"
        first_call, recovery_call = mock_provider.chat_stream_with_retry.await_args_list
        assert first_call.kwargs["tools"] == recovery_call.kwargs["tools"] == []
        recovery_context = recovery_call.kwargs["provider_context"]
        assert recovery_context.conversation_state is not None
        assert recovery_context.conversation_state.payload == response_state.payload
        assert recovery_context.conversation_state.pending_messages == [{
            "role": "tool",
            "tool_call_id": "call-1",
            "name": "inspect",
            "content": _ARCHIVE_TOOL_RESULT,
        }]


class TestConsolidatorSummarize:
    def test_format_messages_keeps_media_only_user_turn(self):
        path = "/workspace/clip.mp4"

        formatted = _format_messages([
            {
                "role": "user",
                "content": "",
                "media": [path],
                "timestamp": "2026-07-27",
            }
        ])

        assert formatted == f"[2026-07-27] USER: [image: {path}]"

    async def test_archive_uses_captured_generation(
        self, consolidator, mock_provider, runtime
    ):
        admitted = replace(
            runtime,
            generation=GenerationSettings(
                temperature=0.25,
                max_tokens=321,
                reasoning_effort="medium",
            ),
        )
        mock_provider.generation = GenerationSettings(
            temperature=0.9,
            max_tokens=999,
            reasoning_effort="high",
        )
        mock_provider.chat_stream_with_retry.return_value = MagicMock(
            content="Summary.",
            finish_reason="stop",
        )

        await _archive(consolidator, [{"role": "user", "content": "hello"}], admitted)

        call = mock_provider.chat_stream_with_retry.call_args.kwargs
        assert call["model"] == admitted.model
        assert call["temperature"] == 0.25
        assert call["max_tokens"] == 321
        assert call["reasoning_effort"] == "medium"

    async def test_summarize_returns_the_model_summary(
        self, consolidator, mock_provider, runtime
    ):
        mock_provider.chat_stream_with_retry.return_value = MagicMock(
            content="User fixed a bug in the auth module."
        )
        messages = [
            {"role": "user", "content": "fix the auth bug"},
            {"role": "assistant", "content": "Done, fixed the race condition."},
        ]
        result = await _archive(consolidator, messages, runtime)
        assert result == "User fixed a bug in the auth module."

    async def test_summarize_raw_dumps_on_llm_failure(
        self, consolidator, mock_provider, runtime
    ):
        """On LLM failure the messages themselves become the checkpoint."""
        mock_provider.chat_stream_with_retry.side_effect = Exception("API error")
        messages = [{"role": "user", "content": "hello"}]
        result = await _archive(consolidator, messages, runtime)
        assert result is not None
        assert "[RAW]" in result
        assert "hello" in result

    async def test_raw_fallback_represents_previous_checkpoint_and_new_chunk(
        self,
        consolidator,
        mock_provider,
        runtime,
    ):
        runtime = replace(runtime, generation=GenerationSettings(max_tokens=256))
        mock_provider.chat_stream_with_retry.side_effect = RuntimeError("API error")

        result = await _archive(
            consolidator,
            [{"role": "user", "content": "NEW_MARKER " + "new " * 200}],
            runtime,
            previous_summary="OLD_MARKER " + "old " * 200,
        )

        assert result is not None
        assert "[Previous archived context]" in result
        assert "OLD_MARKER" in result
        assert "[Newly archived raw context]" in result
        assert "NEW_MARKER" in result
        assert "... (truncated)" in result

    async def test_summarize_skips_empty_messages(self, consolidator, runtime):
        result = await _archive(consolidator, [], runtime)
        assert result is None


class TestConsolidatorPromptContract:
    def test_archive_prompt_requests_a_cumulative_replacement_checkpoint(self):
        prompt = _ARCHIVE_PROMPT

        for section in ("## Merge rules", "## What to retain", "## Output"):
            assert section in prompt
        assert "replacement checkpoint" in prompt
        assert "[Archived Context Summary]" in prompt
        assert "current conversation state" in prompt
        assert "SNIP" in prompt
        for mark in ("[permanent]", "[durable]", "[ephemeral]", "[correction]"):
            assert mark in prompt
        assert "working-state handoff" in prompt
        assert "- [mark] fact" in prompt
        assert "[skip]" not in prompt
        assert "(nothing)" in prompt
        assert "history.jsonl" not in prompt


class TestConsolidatorArchiveErrorHandling:
    """summarize() must fall back when the LLM does not complete its overview.

    Error responses include overloaded / quota failures from #3244; length
    responses contain a partial overview that is likewise unsafe to replay.
    """

    @pytest.mark.parametrize("finish_reason", ["error", "length"])
    async def test_archive_falls_back_on_incomplete_finish_reason(
        self,
        consolidator,
        mock_provider,
        runtime,
        finish_reason: str,
    ):
        """Incomplete LLM output should trigger the raw checkpoint, not partial text."""
        invalid_output = f"INVALID_{finish_reason.upper()}_OUTPUT"
        mock_provider.chat_stream_with_retry.return_value = MagicMock(
            content=invalid_output,
            finish_reason=finish_reason,
        )
        messages = [
            {"role": "user", "content": "fix the auth bug"},
            {"role": "assistant", "content": "Done, fixed the race condition."},
        ]
        result = await _archive(consolidator, messages, runtime)
        assert result is not None
        assert "[RAW]" in result
        assert invalid_output not in result

    async def test_archive_preserves_summary_on_success(
        self, consolidator, mock_provider, runtime
    ):
        """Normal LLM response should still produce a proper summary."""
        mock_provider.chat_stream_with_retry.return_value = MagicMock(
            content="User fixed a bug in the auth module.",
            finish_reason="stop",
        )
        messages = [
            {"role": "user", "content": "fix the auth bug"},
            {"role": "assistant", "content": "Done."},
        ]
        result = await _archive(consolidator, messages, runtime)
        assert result == "User fixed a bug in the auth module."
        assert "[RAW]" not in result

    async def test_summarize_propagates_template_failure_without_fallback(
        self, consolidator, mock_provider, runtime, monkeypatch
    ):
        runtime = replace(runtime, context_window_tokens=128_000)
        monkeypatch.setattr(
            "nanobot.agent.memory.render_template",
            MagicMock(side_effect=RuntimeError("template failed")),
        )

        with pytest.raises(RuntimeError, match="template failed"):
            await consolidator.summarize_transcript(
                [{"role": "user", "content": "important"}],
                None,
                runtime=runtime,
                session_key="test:template",
                tools=[],
            )

        mock_provider.chat_stream_with_retry.assert_not_awaited()


class TestRawCheckpoint:
    """The mechanical checkpoint is the messages, formatted, sanitized and bounded."""

    def test_raw_checkpoint_strips_thinking_before_truncating(self):
        # A thinking block longer than the cap must not leave its head in the checkpoint.
        content = "<think>PRIVATE" + "x" * (2 * _RAW_CHECKPOINT_MAX_CHARS) + "</think>VISIBLE_TAIL"

        checkpoint = _build_raw_checkpoint([{"role": "assistant", "content": content}])

        assert "PRIVATE" not in checkpoint
        assert "VISIBLE_TAIL" in checkpoint

    def test_raw_checkpoint_truncates_large_content(self):
        checkpoint = _build_raw_checkpoint([{"role": "user", "content": "x" * 50_000}])

        assert len(checkpoint) < 50_000
        assert checkpoint.startswith("[RAW]")

    def test_raw_checkpoint_preserves_small_content(self):
        checkpoint = _build_raw_checkpoint([{"role": "user", "content": "hello"}])

        assert checkpoint == f"[RAW] 1 messages\n{_format_messages([{'role': 'user', 'content': 'hello'}])}"
        assert "hello" in checkpoint

    def test_raw_checkpoint_is_sanitized(self):
        checkpoint = _build_raw_checkpoint([
            {"role": "user", "content": "<think>PRIVATE_REASONING</think>visible result"}
        ])

        assert "PRIVATE_REASONING" not in checkpoint
        assert "visible result" in checkpoint


class TestSummaryBounds:
    async def test_summary_is_sanitized(self, consolidator, mock_provider, runtime):
        mock_provider.chat_stream_with_retry.return_value = MagicMock(
            content="<think>PRIVATE_REASONING</think>safe summary",
            finish_reason="stop",
            has_tool_calls=False,
        )

        summary = await _archive(
            consolidator,
            [{"role": "user", "content": "hi"}],
            runtime,
        )

        assert summary == "safe summary"

    async def test_oversized_summary_uses_the_emergency_cap(
        self, consolidator, mock_provider, runtime
    ):
        """A pathologically large LLM summary must not come back full-length."""
        mock_provider.chat_stream_with_retry.return_value = MagicMock(
            content="S" * (_SUMMARY_HARD_CAP * 2),
            finish_reason="stop",
        )

        summary = await _archive(
            consolidator,
            [{"role": "user", "content": "hi"}],
            runtime,
        )

        assert summary is not None
        assert len(summary) <= _SUMMARY_HARD_CAP + 50
