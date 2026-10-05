"""What the engine runs with, projected from the Dot config the host pushed (`PUT /config`).

Pure: the same config gives the same settings, and nothing is written. The
engine builds the settings when a config arrives and at start, and reads them
at the start of a turn; the gate reads the config itself at call time.
"""

from __future__ import annotations

from dataclasses import dataclass

from nanobot.dots.permissions import TOOL_PERMISSIONS, offered_tools
from nanobot.dots.protocol import DotRuntimeConfig

# Longest result of one tool call that goes back to the model, in characters.
MAX_TOOL_RESULT_CHARS = 12000


@dataclass(frozen=True)
class EngineSettings:
    model_id: str
    # The OpenRouter API base URL for tests against a stand-in; None means the provider's own.
    openrouter_base_url: str | None
    # The tools the model is offered: those whose permission is not denied.
    offered_tools: tuple[str, ...]
    max_iterations: int
    context_window_tokens: int
    max_tool_result_chars: int
    # Whether the model is offered the tools that read the memory notes.
    memory_read: bool
    workspace: str
    # The system prompt section that says whose Dot this is and what it is for.
    dot_prompt: str


def project(config: DotRuntimeConfig, *, workspace: str, openrouter_base_url: str | None) -> EngineSettings:
    offered = offered_tools(config.permissions, memory_enabled=config.memory.enabled)
    return EngineSettings(
        model_id=config.model.id,
        openrouter_base_url=(openrouter_base_url or "").strip() or None,
        offered_tools=tuple(offered),
        max_iterations=config.limits.max_steps_per_task,
        context_window_tokens=config.limits.context_tokens,
        max_tool_result_chars=MAX_TOOL_RESULT_CHARS,
        memory_read=any(TOOL_PERMISSIONS[name].needs_memory for name in offered),
        workspace=workspace,
        dot_prompt=dot_prompt_section(config),
    )


def dot_prompt_section(config: DotRuntimeConfig) -> str:
    """The system prompt section that tells the model whose Dot it is and what it is for."""
    lines = [f'You are the Dot "{config.name}". Your goal:', config.goal.strip()]
    instructions = (config.instructions or "").strip()
    if instructions:
        lines += ["", "Instructions from the person who owns you:", instructions]
    return "\n".join(lines)
