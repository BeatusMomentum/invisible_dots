"""Runtime-specific helper functions and constants."""

from __future__ import annotations

from typing import Any, cast

from nanobot.utils.helpers import stringify_text_blocks

_LENGTH_RECOVERY_TAIL_CHARS = 64

EMPTY_FINAL_RESPONSE_MESSAGE = (
    "I completed the tool steps but couldn't produce a final answer. "
    "Please try again or narrow the task."
)

FINALIZATION_RETRY_PROMPT = (
    "Please provide your response to the user based on the conversation above."
)

LENGTH_RECOVERY_PROMPT = (
    "The previous assistant response was cut off. Continue the same response from its "
    "exact endpoint. Output only new continuation text in the same language and style. "
    "Do not acknowledge this instruction, restart the response, repeat its title or any "
    "existing text, recap, or apologize."
)

def empty_tool_result_message(tool_name: str) -> str:
    """Short prompt-safe marker for tools that completed without visible output."""
    return f"({tool_name} completed with no output)"


def ensure_nonempty_tool_result(tool_name: str, content: Any) -> Any:
    """Replace semantically empty tool results with a short marker string."""
    if content is None:
        return empty_tool_result_message(tool_name)
    if isinstance(content, str) and not content.strip():
        return empty_tool_result_message(tool_name)
    if isinstance(content, list):
        if not content:
            return empty_tool_result_message(tool_name)
        text_payload = stringify_text_blocks(cast(list[Any], content))
        if text_payload is not None and not text_payload.strip():
            return empty_tool_result_message(tool_name)
    return cast(Any, content)


def is_blank_text(content: str | None) -> bool:
    """True when *content* is missing or only whitespace."""
    return content is None or not content.strip()


def build_finalization_retry_message() -> dict[str, str]:
    """A short no-tools-allowed prompt for final answer recovery."""
    return {"role": "user", "content": FINALIZATION_RETRY_PROMPT}


def build_length_recovery_message(content: str) -> dict[str, str]:
    """Prompt the model to continue after hitting output token limit."""
    tail = content[-_LENGTH_RECOVERY_TAIL_CHARS:]
    prompt = (
        f"{LENGTH_RECOVERY_PROMPT}\n\n"
        "The following tail was already delivered to the user. Treat it as immutable "
        "context and do not output it again:\n"
        "<already_delivered_tail>\n"
        f"{tail}\n"
        "</already_delivered_tail>\n"
        "Begin with the text that belongs immediately after this tail."
    )
    return {"role": "user", "content": prompt}
