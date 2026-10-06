"""Which permission of architecture section 7 each tool of the Dot exercises.

This is the one list of the Dot's tools. The policy gate decides a call by it
(gate.py), the projection offers the model only the tools in it whose
permission is not denied (projection.py), and `tool.called` reports the
permission and its target (what of the call may be shown, targets.py) from it.
A tool that is not in the table is neither offered nor allowed, and reports an
empty permission and no target.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING, Any

from nanobot.dots import targets
from nanobot.dots.protocol import TOOL_TARGET_MAX

if TYPE_CHECKING:
    from nanobot.agent.tools.base import Tool
    from nanobot.agent.tools.exec_session import ExecSessionManager
    from nanobot.agent.tools.registry import ToolRegistry
    from nanobot.cron.service import CronService
    from nanobot.dots.computer import Computer


@dataclass(frozen=True)
class ToolDeps:
    """Dependencies required to instantiate the Dot's tools."""

    computer: Computer
    exec_session_manager: ExecSessionManager
    cron_service: CronService


@dataclass(frozen=True)
class ToolEntry:
    """What the contract knows of one tool.

    permission: the key of the host's permission map the tool exercises.
    build: factory taking ToolDeps to instantiate the Tool.
    target: from the call's arguments, the one redacted line `tool.called` shows of it (None: nothing).
    needs_memory: the tool exists only while the Dot's memory is enabled.
    starts_terminal: from the call's arguments, whether it starts a terminal session.
    """

    permission: str
    build: Callable[[ToolDeps], Tool]
    target: Callable[[Mapping[str, Any]], str | None]
    needs_memory: bool = False
    # Whether the call starts a terminal session, which `tool.called` marks (`tty`); no other tool does.
    starts_terminal: Callable[[Mapping[str, Any]], bool] = targets.never_starts_terminal


def _build_exec(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.shell import ExecTool

    return ExecTool(computer=deps.computer, session_manager=deps.exec_session_manager)


def _build_exec_session(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.exec_session import ExecSessionTool

    return ExecSessionTool(manager=deps.exec_session_manager)


def _build_list_exec_sessions(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.exec_session import ListExecSessionsTool

    return ListExecSessionsTool(manager=deps.exec_session_manager)


def _build_read_file(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.filesystem import ReadFileTool

    return ReadFileTool(computer=deps.computer)


def _build_list_dir(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.filesystem import ListDirTool

    return ListDirTool(computer=deps.computer)


def _build_find_files(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.search import FindFilesTool

    return FindFilesTool(computer=deps.computer)


def _build_grep(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.search import GrepTool

    return GrepTool(computer=deps.computer)


def _build_write_file(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.filesystem import WriteFileTool

    return WriteFileTool(computer=deps.computer)


def _build_edit_file(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.filesystem import EditFileTool

    return EditFileTool(computer=deps.computer)


def _build_apply_patch(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.apply_patch import ApplyPatchTool

    return ApplyPatchTool(computer=deps.computer)


def _build_memory_search(deps: ToolDeps) -> Tool:
    from nanobot.dots.memory_tools import MemorySearchTool

    return MemorySearchTool(computer=deps.computer)


def _build_memory_get(deps: ToolDeps) -> Tool:
    from nanobot.dots.memory_tools import MemoryGetTool

    return MemoryGetTool(computer=deps.computer)


def _build_cron(deps: ToolDeps) -> Tool:
    from nanobot.agent.tools.cron import CronTool

    return CronTool(cron_service=deps.cron_service)


TOOL_PERMISSIONS: Mapping[str, ToolEntry] = MappingProxyType(
    {
        "exec": ToolEntry("computer.exec", _build_exec, targets.exec_target, starts_terminal=targets.exec_starts_terminal),
        "exec_session": ToolEntry("computer.exec", _build_exec_session, targets.exec_session_target),
        "list_exec_sessions": ToolEntry("computer.exec", _build_list_exec_sessions, targets.no_target),
        "read_file": ToolEntry("files.read", _build_read_file, targets.path_target),
        "list_dir": ToolEntry("files.read", _build_list_dir, targets.path_target),
        "find_files": ToolEntry("files.read", _build_find_files, targets.find_files_target),
        "grep": ToolEntry("files.read", _build_grep, targets.grep_target),
        "write_file": ToolEntry("files.write", _build_write_file, targets.path_target),
        "edit_file": ToolEntry("files.write", _build_edit_file, targets.path_target),
        "apply_patch": ToolEntry("files.write", _build_apply_patch, targets.apply_patch_target),
        "memory_search": ToolEntry("memory.read", _build_memory_search, targets.memory_search_target, needs_memory=True),
        "memory_get": ToolEntry("memory.read", _build_memory_get, targets.memory_get_target, needs_memory=True),
        "cron": ToolEntry("automations", _build_cron, targets.cron_target),
    }
)


def tool_permission(tool_name: str) -> str:
    """The permission a tool exercises, or "" for a tool that is not the Dot's."""
    entry = TOOL_PERMISSIONS.get(tool_name)
    return entry.permission if entry else ""


def tool_target(tool_name: str, params: Any) -> str | None:
    """The line `tool.called` shows of a call: at most TOOL_TARGET_MAX characters, or None.

    None for a tool that is not the Dot's, for arguments that are not an object and for a call with
    nothing to name.
    """
    entry = TOOL_PERMISSIONS.get(tool_name)
    if entry is None or not isinstance(params, Mapping):
        return None
    target = entry.target(params)
    return targets.clip(target, TOOL_TARGET_MAX) if target else None


def tool_starts_terminal(tool_name: str, params: Any) -> bool:
    """Whether the call starts a terminal session (false for a tool that is not the Dot's, or odd arguments)."""
    entry = TOOL_PERMISSIONS.get(tool_name)
    if entry is None or not isinstance(params, Mapping):
        return False
    return entry.starts_terminal(params)


def offered_tools(permissions: Mapping[str, str], *, memory_enabled: bool = True) -> list[str]:
    """The tools the model is offered, sorted.

    A tool is offered when its permission is allow or ask (a permission missing
    from the map is deny), and, for a memory tool, when memory is enabled.
    """
    return sorted(
        name
        for name, entry in TOOL_PERMISSIONS.items()
        if permissions.get(entry.permission) in ("allow", "ask")
        and (memory_enabled or not entry.needs_memory)
    )


def build_registry(deps: ToolDeps) -> ToolRegistry:
    """Register exactly the tools of the permission table on a new registry."""
    from nanobot.agent.tools.registry import ToolRegistry

    registry = ToolRegistry()
    for entry in TOOL_PERMISSIONS.values():
        registry.register(entry.build(deps))
    return registry

