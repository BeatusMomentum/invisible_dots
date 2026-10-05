"""Tests for memory_search and memory_get tools."""

from __future__ import annotations

from pathlib import Path

import pytest
from fakes.local_computer import LocalComputer

from nanobot.agent.tools.base import ToolResult
from nanobot.dots.memory_tools import MemoryGetTool, MemorySearchTool


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

