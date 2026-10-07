"""One conversation: its messages, summary checkpoint and replay."""

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, cast

from nanobot.session.history_visibility import HIDDEN_HISTORY_META
from nanobot.session.summary import SUMMARY_CONTINUATION_TEXT, is_summary_checkpoint
from nanobot.utils.helpers import (
    content_with_media_breadcrumbs,
    estimate_message_tokens,
    find_legal_message_start,
    recent_message_start_index,
)

_MESSAGE_TIME_PREFIX_RE = re.compile(r"^\[Message Time: [^\]]+\]\n?")
_LOCAL_IMAGE_BREADCRUMB_RE = re.compile(r"^\[image: (?:/|~)[^\]]+\]\s*$")


def _sanitize_assistant_replay_text(content: str) -> str:
    """Remove internal replay artifacts that the model may have copied before.

    These strings are useful as runtime/session metadata, but when they appear
    in assistant examples they become demonstrations for the model to repeat.
    """
    content = _MESSAGE_TIME_PREFIX_RE.sub("", content, count=1)
    lines = [
        line
        for line in content.splitlines()
        if not _LOCAL_IMAGE_BREADCRUMB_RE.match(line)
    ]
    return "\n".join(lines).strip()


@dataclass
class Session:
    """A conversation session."""

    key: str  # "chat" or "task:<task_id>"
    messages: list[dict[str, Any]] = field(default_factory=list)
    updated_at: datetime = field(default_factory=datetime.now)
    metadata: dict[str, Any] = field(default_factory=dict)
    # Messages before this offset are replaced, in replay, by the summary checkpoint.
    last_consolidated: int = 0

    def __post_init__(self) -> None:
        if not isinstance(cast(object, self.metadata), dict):
            self.metadata = {}
        # An out-of-range offset (corrupt metadata) would hide all history; reset it.
        last_consolidated = cast(object, self.last_consolidated)
        if (
            isinstance(last_consolidated, bool)
            or not isinstance(last_consolidated, int)
            or not 0 <= last_consolidated <= len(self.messages)
        ):
            self.last_consolidated = 0

    def commit_summary_checkpoint(
        self,
        summary: str,
        *,
        insert_at: int | None = None,
        last_active: datetime | None = None,
    ) -> None:
        """Replace replay before a hidden boundary while preserving the transcript."""
        boundary = len(self.messages) if insert_at is None else insert_at
        self.messages.insert(boundary, {
            "role": "user",
            "content": SUMMARY_CONTINUATION_TEXT,
            HIDDEN_HISTORY_META: True,
            "timestamp": datetime.now().isoformat(),
        })
        self.metadata["_last_summary"] = {
            "text": summary,
            "last_active": (last_active or self.updated_at).isoformat(),
        }
        self.last_consolidated = boundary

    def get_history(
        self,
        max_messages: int = 0,
        *,
        max_tokens: int = 0,
        extend_to_user: bool = False,
    ) -> list[dict[str, Any]]:
        """Return recent replayable messages for LLM input.

        A committed summary checkpoint replaces its old prefix with the stored
        summary and resumes replay after its hidden boundary marker. The marker
        is not a user request and must not resume an old task on the next turn.
        A positive ``max_messages`` applies an additional caller-owned count limit.
        """
        replayable = self.messages[self.last_consolidated:]
        if max_messages <= 0:
            start_idx = 0
        else:
            start_idx = recent_message_start_index(
                replayable,
                max_messages,
                extend_to_user=extend_to_user,
            )
        sliced = replayable[start_idx:]

        # Avoid starting mid-turn when possible.
        for i, message in enumerate(sliced):
            if message.get("role") == "user":
                sliced = sliced[i:]
                break

        # Drop orphan tool results at the front.
        start = find_legal_message_start(sliced)
        if start:
            sliced = sliced[start:]

        out: list[dict[str, Any]] = []
        for message in sliced:
            if is_summary_checkpoint(message):
                continue
            content = message.get("content", "")
            role = message.get("role")
            if role == "assistant" and isinstance(content, str):
                content = _sanitize_assistant_replay_text(content)
            # Synthesize an ``[image: path]`` breadcrumb from the persisted
            # ``media`` kwarg so LLM replay still sees *something* where the
            # image used to be. Without this, an image-only user turn
            # replays as an empty user message - the assistant's reply then
            # looks like it's responding to nothing.
            content = content_with_media_breadcrumbs(
                role,
                content,
                message.get("media"),
            )
            if role == "assistant" and isinstance(content, str) and not content.strip():
                if not any(key in message for key in ("tool_calls", "reasoning_content", "thinking_blocks")):
                    continue
            entry: dict[str, Any] = {"role": message["role"], "content": content}
            for key in ("tool_calls", "tool_call_id", "name", "reasoning_content", "thinking_blocks"):
                if key in message:
                    entry[key] = message[key]
            out.append(entry)

        if max_tokens > 0 and out:
            kept: list[dict[str, Any]] = []
            used = 0
            for message in reversed(out):
                tokens = estimate_message_tokens(message)
                if kept and used + tokens > max_tokens:
                    break
                kept.append(message)
                used += tokens
            kept.reverse()

            # Keep history aligned to the first visible user turn.
            first_user = next((i for i, m in enumerate(kept) if m.get("role") == "user"), None)
            if first_user is not None:
                kept = kept[first_user:]
            else:
                # Tight token budgets can otherwise leave assistant-only tails.
                # If a user turn exists in the unsliced output, recover the
                # nearest one even if it slightly exceeds the token budget.
                recovered_user = next(
                    (i for i in range(len(out) - 1, -1, -1) if out[i].get("role") == "user"),
                    None,
                )
                if recovered_user is not None:
                    kept = out[recovered_user:]

            # And keep a legal tool-call boundary at the front.
            start = find_legal_message_start(kept)
            if start:
                kept = kept[start:]
            out = kept
        return out
