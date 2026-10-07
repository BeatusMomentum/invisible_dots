"""Transcript summaries: the LLM checkpoint of older messages, with a mechanical fallback.

Context governance replaces an accepted prefix of the transcript with one
checkpoint when the next request would not fit. ``Consolidator`` writes that
checkpoint. It owns no files: the summary is returned to its caller, which
stores it with the session.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from loguru import logger

from nanobot.providers.base import LLMResponse, ProviderConversationState
from nanobot.providers.conversation_state import ProviderConversationStateController
from nanobot.utils.helpers import (
    build_assistant_message,
    content_with_media_breadcrumbs,
    estimate_prompt_tokens_chain,
    strip_think,
    truncate_text,
    truncate_text_to_tokens,
)
from nanobot.utils.prompt_templates import render_template

if TYPE_CHECKING:
    from nanobot.utils.llm_runtime import LLMRuntime

# The mechanical fallback (the model could not summarize) uses a tighter cap than
# a completed model summary, which scales with the generation budget. The hard cap
# is the emergency bound on pathological provider output.
_RAW_CHECKPOINT_MAX_CHARS = 16_000
_SUMMARY_HARD_CAP = 64_000
_ARCHIVE_TOOL_RESULT = (
    "Session archival does not execute tools. Use only the supplied conversation and "
    "return the requested compact checkpoint now; do not call another tool."
)


def _normalize_summary(entry: str, *, max_chars: int | None = None) -> str:
    """Return the bounded, model-safe text of a checkpoint."""
    limit = max_chars if max_chars is not None else _SUMMARY_HARD_CAP
    content = strip_think(entry.rstrip())
    if len(content) > limit:
        logger.warning("checkpoint exceeds {} chars ({}); truncating", limit, len(content))
        content = truncate_text(content, limit)
    return content


def _format_messages(messages: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for message in messages:
        content = content_with_media_breadcrumbs(
            message.get("role"),
            message.get("content", ""),
            message.get("media"),
        )
        if not content:
            continue
        tools_used = message.get("tools_used")
        tools = (
            f" [tools: {', '.join(cast(list[str], tools_used))}]"
            if tools_used
            else ""
        )
        raw_timestamp = message.get("timestamp")
        timestamp = str(raw_timestamp) if raw_timestamp is not None else "?"
        role = str(message.get("role") or "unknown")
        lines.append(f"[{timestamp[:16]}] {role.upper()}{tools}: {content}")
    return "\n".join(lines)


def _build_raw_checkpoint(messages: list[dict[str, Any]]) -> str:
    """The mechanical checkpoint: the messages themselves, formatted and bounded."""
    checkpoint = (
        f"[RAW] {len(messages)} messages\n"
        f"{_format_messages(messages)}"
    )
    return _normalize_summary(checkpoint, max_chars=_RAW_CHECKPOINT_MAX_CHARS)


def _combine_raw_checkpoint(
    raw: str,
    *,
    previous_summary: str | None,
    max_tokens: int,
) -> str:
    """Return a bounded checkpoint that preserves prior and newly archived context."""
    token_limit = max(1, max_tokens)
    if not previous_summary:
        return truncate_text_to_tokens(raw, token_limit)

    combined = (
        "[Previous archived context]\n"
        f"{previous_summary}\n\n"
        "[Newly archived raw context]\n"
        f"{raw}"
    )
    bounded = truncate_text_to_tokens(combined, token_limit)
    if bounded == combined:
        return combined

    # Keep evidence from both sides when their full concatenation cannot fit.
    section_limit = max(1, (token_limit - 32) // 2)
    return truncate_text_to_tokens(
        "[Previous archived context]\n"
        f"{truncate_text_to_tokens(previous_summary, section_limit)}\n\n"
        "[Newly archived raw context]\n"
        f"{truncate_text_to_tokens(raw, section_limit)}",
        token_limit,
    )


class Consolidator:
    """Summarize a transcript prefix into one replacement checkpoint."""

    _SAFETY_BUFFER = 1024  # extra headroom for tokenizer estimation drift

    async def summarize(
        self,
        source_messages: list[dict[str, Any]],
        *,
        runtime: LLMRuntime,
        session_key: str,
        history: list[dict[str, Any]],
        request_tools: list[dict[str, Any]],
        previous_summary: str | None = None,
        input_token_budget: int | None = None,
        fallback_max_tokens: int | None = None,
        provider_state: ProviderConversationState | None = None,
    ) -> str | None:
        """Generate a replacement checkpoint; fall back to a mechanical one."""
        if not source_messages:
            return None

        def raw_fallback() -> str:
            return _combine_raw_checkpoint(
                _build_raw_checkpoint(source_messages),
                previous_summary=previous_summary,
                max_tokens=(
                    fallback_max_tokens
                    if fallback_max_tokens is not None
                    else runtime.generation.max_tokens
                ),
            )

        prompt = render_template(
            "agent/consolidator_archive.md",
            strip=True,
            archive_count=len(source_messages),
        )
        prompt_message = {"role": "user", "content": prompt}
        provider_context = None
        state_controller: ProviderConversationStateController | None = None
        state_messages: list[dict[str, Any]] = []
        call_tools = request_tools
        if provider_state is not None:
            instruction_messages: list[dict[str, Any]] = []
            for message in history:
                if message.get("role") not in {"system", "developer"}:
                    break
                instruction_messages.append(dict(message))
            request_messages = [*instruction_messages, prompt_message]
            state_controller = ProviderConversationStateController(
                provider=runtime.provider,
                model=runtime.model,
                messages=state_messages,
                state=provider_state,
                session_id=session_key,
            )
            state_messages.append(dict(prompt_message))
            provider_context = state_controller.prepare_request(
                state_messages,
                context_window_tokens=runtime.context_window_tokens,
            )
            if provider_context is None or provider_context.conversation_state is None:
                return raw_fallback()
            call_tools = []
        else:
            request_messages = [
                *[dict(message) for message in history],
                prompt_message,
            ]
        if input_token_budget is not None and provider_context is None:
            estimated, source = estimate_prompt_tokens_chain(
                runtime.provider,
                runtime.model,
                request_messages,
                call_tools,
            )
            if input_token_budget <= 0 or estimated > input_token_budget:
                logger.debug(
                    "Summary input does not fit for {}: {}/{} via {}; "
                    "using raw checkpoint",
                    session_key,
                    estimated,
                    input_token_budget,
                    source,
                )
                return raw_fallback()

        response: LLMResponse | None = None
        for attempt in range(2):
            try:
                response = await runtime.provider.chat_stream_with_retry(
                    model=runtime.model,
                    messages=request_messages,
                    tools=call_tools,
                    temperature=runtime.generation.temperature,
                    max_tokens=runtime.generation.max_tokens,
                    reasoning_effort=runtime.generation.reasoning_effort,
                    provider_context=provider_context,
                )
            except Exception:
                phase = "provider call" if attempt == 0 else "tool-call recovery"
                logger.warning(
                    "Summary {} failed; using raw checkpoint",
                    phase,
                )
                return raw_fallback()
            if response.should_execute_tools is not True or attempt == 1:
                break

            logger.info(
                "Summary provider returned {} tool call(s); requesting checkpoint",
                len(response.tool_calls),
            )
            assistant_message = build_assistant_message(
                response.content,
                tool_calls=[call.to_openai_tool_call() for call in response.tool_calls],
                reasoning_content=response.reasoning_content,
                thinking_blocks=response.thinking_blocks,
            )
            tool_messages = [
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "name": call.name,
                    "content": _ARCHIVE_TOOL_RESULT,
                }
                for call in response.tool_calls
            ]
            request_messages = [
                *request_messages,
                assistant_message,
                *tool_messages,
            ]
            if state_controller is not None:
                state_controller.observe_response(
                    response,
                    state_messages,
                )
                state_messages.extend([
                    state_controller.project_response_message(
                        dict(assistant_message),
                        response,
                    ),
                    *[dict(message) for message in tool_messages],
                ])
                provider_context = state_controller.prepare_request(
                    state_messages,
                    context_window_tokens=runtime.context_window_tokens,
                )
                if provider_context is None or provider_context.conversation_state is None:
                    return raw_fallback()
        assert response is not None
        if response.finish_reason in {"error", "length"}:
            logger.warning(
                "Summary provider did not complete ({}); using raw checkpoint",
                response.finish_reason,
            )
            return raw_fallback()
        if response.has_tool_calls is True:
            logger.warning("Summary provider returned tool calls; using raw checkpoint")
            return raw_fallback()
        summary = response.content
        if not summary or not summary.strip():
            logger.warning("Summary provider returned no summary; using raw checkpoint")
            return raw_fallback()
        summary = _normalize_summary(summary)
        if not summary:
            logger.warning(
                "Summary provider output was not safe to replay; using raw checkpoint"
            )
            return raw_fallback()
        return summary

    async def summarize_transcript(
        self,
        accepted_messages: list[dict[str, Any]],
        previous_summary: str | None,
        *,
        runtime: LLMRuntime,
        session_key: str,
        tools: list[dict[str, Any]],
        provider_state: ProviderConversationState | None = None,
    ) -> str | None:
        """Summarize the exact transcript prefix already accepted by the model."""
        source_messages = [
            dict(message)
            for message in accepted_messages
            if message.get("role") != "system"
        ]
        if not source_messages:
            return None

        max_output_tokens = max(0, runtime.generation.max_tokens)
        input_token_budget = runtime.context_window_tokens - max_output_tokens
        checkpoint_tokens = min(
            max_output_tokens,
            max(1, (input_token_budget - self._SAFETY_BUFFER) // 2),
        )

        summary = await self.summarize(
            source_messages,
            runtime=runtime,
            session_key=session_key,
            history=accepted_messages,
            request_tools=tools,
            previous_summary=previous_summary,
            input_token_budget=input_token_budget,
            fallback_max_tokens=max(1, checkpoint_tokens),
            provider_state=provider_state,
        )
        if summary is None:
            return None
        return truncate_text_to_tokens(summary, max(1, max_output_tokens))

    async def summarize_provider_compaction(
        self,
        state: ProviderConversationState,
        fallback_messages: list[dict[str, Any]],
        previous_summary: str | None,
        *,
        runtime: LLMRuntime,
        session_key: str,
        tools: list[dict[str, Any]],
    ) -> str | None:
        """Prompt a native compacted state without replaying its raw history."""
        return await self.summarize_transcript(
            fallback_messages,
            previous_summary,
            runtime=runtime,
            session_key=session_key,
            tools=tools,
            provider_state=state,
        )
