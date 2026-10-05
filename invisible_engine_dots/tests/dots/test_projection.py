"""The projection of the pushed Dot config into what the engine runs with."""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from typing import Any

import pytest

from nanobot.dots.permissions import TOOL_PERMISSIONS
from nanobot.dots.projection import (
    MAX_TOOL_RESULT_CHARS,
    EngineSettings,
    dot_prompt_section,
    project,
)
from nanobot.dots.protocol import DotRuntimeConfig, parse_runtime_config

WORKSPACE = "/home/dot/workspace"


def settings(config: DotRuntimeConfig, base_url: str | None = None) -> EngineSettings:
    return project(config, workspace=WORKSPACE, openrouter_base_url=base_url)


def test_names_the_model_the_workspace_and_maps_the_limits(make_config: Callable[..., DotRuntimeConfig]) -> None:
    result = settings(make_config({}))
    assert result.model_id == "z-ai/glm-5.3-flash"
    assert result.workspace == WORKSPACE
    assert result.max_iterations == 60
    assert result.context_window_tokens == 32000
    assert result.max_tool_result_chars == MAX_TOOL_RESULT_CHARS == 12000


def test_the_limits_follow_the_config(config_body: Callable[..., dict[str, Any]]) -> None:
    body = config_body()
    body["limits"].update(max_steps_per_task=7, context_tokens=4000)
    result = settings(parse_runtime_config(body))
    assert (result.max_iterations, result.context_window_tokens) == (7, 4000)


def test_offers_the_model_only_the_tools_whose_permission_is_not_denied(make_config: Callable[..., DotRuntimeConfig]) -> None:
    result = settings(
        make_config({"computer.exec": "ask", "files.read": "allow", "files.write": "deny", "automations": "ask"})
    )
    assert result.offered_tools == (
        "cron",
        "exec",
        "exec_session",
        "find_files",
        "grep",
        "list_dir",
        "list_exec_sessions",
        "read_file",
    )
    assert settings(make_config({"files.write": "deny"})).offered_tools == ()
    assert settings(make_config({})).offered_tools == ()


def test_the_memory_tools_are_offered_only_while_memory_is_enabled(config_body: Callable[..., dict[str, Any]]) -> None:
    permissions = {"memory.read": "allow", "files.read": "allow"}
    enabled = settings(parse_runtime_config(config_body(permissions=permissions)))
    assert {"memory_search", "memory_get"} <= set(enabled.offered_tools)
    disabled = settings(parse_runtime_config(config_body(permissions=permissions, memory={"enabled": False})))
    assert not {"memory_search", "memory_get"} & set(disabled.offered_tools)
    assert "read_file" in disabled.offered_tools


def test_offers_nothing_outside_the_permission_table(make_config: Callable[..., DotRuntimeConfig]) -> None:
    everything = {permission: "allow" for permission in {e.permission for e in TOOL_PERMISSIONS.values()}}
    assert set(settings(make_config(everything)).offered_tools) == set(TOOL_PERMISSIONS)
    assert settings(make_config({"web.fetch": "allow", "subagents": "allow"})).offered_tools == ()


def test_points_openrouter_at_a_stand_in_only_when_told_to(make_config: Callable[..., DotRuntimeConfig]) -> None:
    config = make_config({})
    assert settings(config).openrouter_base_url is None
    assert settings(config, "").openrouter_base_url is None
    assert settings(config, "   ").openrouter_base_url is None
    assert settings(config, " http://127.0.0.1:9/api/v1 ").openrouter_base_url == "http://127.0.0.1:9/api/v1"


def test_the_projection_is_pure_and_the_settings_are_frozen(make_config: Callable[..., DotRuntimeConfig]) -> None:
    config = make_config({"files.read": "allow"})
    first, second = settings(config), settings(config)
    assert first == second
    assert hash(first) == hash(second)
    with pytest.raises(dataclasses.FrozenInstanceError):
        first.model_id = "other"  # type: ignore[misc]
    assert config.permissions == {"files.read": "allow"}


def test_the_prompt_section_names_the_dot_and_its_goal(make_config: Callable[..., DotRuntimeConfig]) -> None:
    assert dot_prompt_section(make_config({})) == 'You are the Dot "fare-watch". Your goal:\nWatch fares.'


def test_the_prompt_section_carries_the_instructions_when_there_are_some(
    config_body: Callable[..., dict[str, Any]],
) -> None:
    config = parse_runtime_config(config_body(goal="  Watch fares.\n", instructions="  Be brief.\nNo emoji.  "))
    assert dot_prompt_section(config) == (
        'You are the Dot "fare-watch". Your goal:\n'
        "Watch fares.\n"
        "\n"
        "Instructions from the person who owns you:\n"
        "Be brief.\nNo emoji."
    )


@pytest.mark.parametrize("instructions", [None, "", "  \n "])
def test_blank_instructions_add_nothing(config_body: Callable[..., dict[str, Any]], instructions: str | None) -> None:
    config = parse_runtime_config(config_body(instructions=instructions) if instructions is not None else config_body())
    assert "Instructions" not in dot_prompt_section(config)


def test_the_settings_carry_the_prompt_section_of_the_config(make_config: Callable[..., DotRuntimeConfig]) -> None:
    config = make_config({})
    assert settings(config).dot_prompt == dot_prompt_section(config)


def test_the_memory_notes_are_read_only_while_a_memory_tool_is_offered(
    config_body: Callable[..., dict[str, Any]],
) -> None:
    allowed = settings(parse_runtime_config(config_body(permissions={"memory.read": "allow"})))
    assert allowed.memory_read is True
    denied = settings(parse_runtime_config(config_body(permissions={"memory.read": "deny", "files.read": "allow"})))
    assert denied.memory_read is False
    disabled = settings(
        parse_runtime_config(config_body(permissions={"memory.read": "allow"}, memory={"enabled": False}))
    )
    assert disabled.memory_read is False
