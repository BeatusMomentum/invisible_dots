"""Tests for memory_search and memory_get tools."""

from __future__ import annotations

from functools import partial
from pathlib import Path
from typing import Any

import pytest
from fakes.local_computer import LocalComputer

from nanobot.agent.tools.base import ToolResult
from nanobot.dots.computer import resolve_path
from nanobot.dots.memory_tools import MemoryGetTool, MemorySearchTool, memory_keys_written


@pytest.mark.asyncio
async def test_memory_get_tool(tmp_path: Path) -> None:
    comp = LocalComputer(tmp_path)
    get_tool = MemoryGetTool(comp)

    # 1. Invalid names: empty, slash, dot-dot
    res_empty = await get_tool.execute(name="")
    assert isinstance(res_empty, ToolResult) and res_empty.is_error
    assert "cannot be empty" in res_empty

    res_slash = await get_tool.execute(name="sub/note")
    assert isinstance(res_slash, ToolResult) and res_slash.is_error
    assert "must not contain '/'" in res_slash

    res_dotdot = await get_tool.execute(name="../secret")
    assert isinstance(res_dotdot, ToolResult) and res_dotdot.is_error

    # 2. Non-existent note
    res_missing = await get_tool.execute(name="nonexistent")
    assert res_missing == "No note named nonexistent."

    # 3. Existing note (reads .md automatically)
    await comp.write_bytes("/home/dot/memory/project.md", b"# Project Ideas\nBuild a Dot.")
    res_found = await get_tool.execute(name="project")
    assert res_found == "# Project Ideas\nBuild a Dot."

    # 4. Explicit .md extension works
    res_found_ext = await get_tool.execute(name="project.md")
    assert res_found_ext == "# Project Ideas\nBuild a Dot."

    # 5. Binary note reports binary
    await comp.write_bytes("/home/dot/memory/binary.md", b"\xff\xfe\x00\x00\xff")
    res_bin = await get_tool.execute(name="binary")
    assert "Cannot read binary note" in res_bin


@pytest.mark.asyncio
async def test_memory_search_tool(tmp_path: Path) -> None:
    comp = LocalComputer(tmp_path)
    search_tool = MemorySearchTool(comp)

    # 1. Empty query
    res_empty = await search_tool.execute(query="")
    assert res_empty == "No note mentions empty query."

    # 2. Query not found
    res_none = await search_tool.execute(query="banana")
    assert res_none == "No note mentions banana."

    # 3. Query found
    await comp.write_bytes(
        "/home/dot/memory/recipes.md",
        b"Apple pie recipe\nBanana split recipe\nOrange juice\n",
    )
    res_found = await search_tool.execute(query="banana")
    assert "Banana split recipe" in res_found
    assert "/home/dot/memory/recipes.md" in res_found

    # 4. Truncation test (> 100 lines)
    many_lines = b"".join(f"item {i} keyword\n".encode() for i in range(150))
    await comp.write_bytes("/home/dot/memory/big.md", many_lines)
    res_many = await search_tool.execute(query="keyword")
    assert "truncated: 150 total lines" in res_many


resolve = partial(resolve_path, "/home/dot/workspace")


def patch(*paths: object, **extra: Any) -> dict[str, Any]:
    return {"edits": [{"path": path, "action": "add", "new_text": "x"} for path in paths], **extra}


class TestMemoryKeysWritten:
    @pytest.mark.parametrize("tool", ["write_file", "edit_file"])
    def test_a_file_tool_names_the_note_it_writes_by_its_path_inside_the_memory_directory(self, tool: str) -> None:
        assert memory_keys_written(tool, {"path": "/home/dot/memory/a.md"}, resolve) == ("a.md",)

    @pytest.mark.parametrize("tool", ["write_file", "edit_file"])
    def test_a_nested_note_keeps_its_directories(self, tool: str) -> None:
        assert memory_keys_written(tool, {"path": "/home/dot/memory/trips/rome/plan.md"}, resolve) == (
            "trips/rome/plan.md",
        )

    def test_a_relative_path_is_resolved_against_the_workspace_like_the_tool_does(self) -> None:
        assert memory_keys_written("write_file", {"path": "../memory/a.md"}, resolve) == ("a.md",)
        assert memory_keys_written("write_file", {"path": "memory/a.md"}, resolve) == ()

    @pytest.mark.parametrize(
        "path",
        [
            "/home/dot/workspace/a.md",
            "/home/dot/memory",
            "/home/dot/memory/",
            "/home/dot/memory/..",
            "/home/dot/memory/../workspace/a.md",
            "/home/dot/memory/../secrets.md",
            "/home/dot/memory-old/a.md",
            "/home/dot/memoryfile",
            "/etc/memory/a.md",
            "",
        ],
    )
    def test_a_path_outside_the_memory_directory_or_the_directory_itself_is_no_note(self, path: str) -> None:
        assert memory_keys_written("write_file", {"path": path}, resolve) == ()

    def test_a_dot_dot_that_leaves_and_comes_back_names_the_note_it_reaches(self) -> None:
        assert memory_keys_written("write_file", {"path": "/home/dot/memory/x/../a.md"}, resolve) == ("a.md",)

    @pytest.mark.parametrize("arguments", [{}, {"path": None}, {"path": 5}, {"path": ["/home/dot/memory/a.md"]}])
    def test_arguments_without_a_text_path_name_nothing(self, arguments: dict[str, Any]) -> None:
        assert memory_keys_written("write_file", arguments, resolve) == ()

    def test_apply_patch_names_every_distinct_note_in_the_order_of_its_edits(self) -> None:
        arguments = patch(
            "/home/dot/memory/b.md", "/home/dot/workspace/code.py", "/home/dot/memory/a.md", "/home/dot/memory/b.md"
        )
        assert memory_keys_written("apply_patch", arguments, resolve) == ("b.md", "a.md")

    def test_apply_patch_reads_the_path_as_the_tool_does_stripped(self) -> None:
        assert memory_keys_written("apply_patch", patch("  /home/dot/memory/a.md\n"), resolve) == ("a.md",)

    def test_a_dry_run_writes_nothing(self) -> None:
        assert memory_keys_written("apply_patch", patch("/home/dot/memory/a.md", dry_run=True), resolve) == ()
        assert memory_keys_written("apply_patch", patch("/home/dot/memory/a.md", dry_run=False), resolve) == ("a.md",)

    @pytest.mark.parametrize("edits", [None, "x", 5, [], [None, "x", {"action": "add"}, {"path": 3}]])
    def test_malformed_edits_name_nothing(self, edits: object) -> None:
        assert memory_keys_written("apply_patch", {"edits": edits}, resolve) == ()

    @pytest.mark.parametrize(
        "tool", ["read_file", "list_dir", "grep", "exec", "memory_get", "memory_search", "cron", "browser_navigate", "x"]
    )
    def test_a_tool_that_writes_no_file_names_nothing(self, tool: str) -> None:
        arguments = {"path": "/home/dot/memory/a.md", "name": "a", "command": "echo x > /home/dot/memory/a.md"}
        assert memory_keys_written(tool, arguments, resolve) == ()

