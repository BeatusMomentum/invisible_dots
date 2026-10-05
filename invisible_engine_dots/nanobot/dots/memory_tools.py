"""Memory search and note access tools through the Computer abstraction."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from nanobot.agent.tools.base import Tool, ToolResult
from nanobot.dots.computer import Computer

# The Dot's long-term notes: one file per note, kept on its own computer.
MEMORY_DIR = "/home/dot/memory"


def memory_keys_written(tool: str, arguments: Mapping[str, Any], resolve: Callable[[str], str]) -> tuple[str, ...]:
    """The notes a call of a file tool writes: each path under MEMORY_DIR, relative to it, once, in order.

    `resolve` is the computer's own, so a path is read the way the tool reads it (`../` and a path
    relative to the workspace included). Only `write_file`, `edit_file` and `apply_patch` (not its
    dry run) write files; a note written through `exec` is not seen. The directory itself is no note.
    """
    if tool in ("write_file", "edit_file"):
        paths = [arguments.get("path")]
    elif tool == "apply_patch" and not arguments.get("dry_run"):
        edits = arguments.get("edits")
        # apply_patch strips the path it is given; write_file and edit_file take it as it is.
        paths = [
            edit["path"].strip() if isinstance(edit.get("path"), str) else None
            for edit in (edits if isinstance(edits, list) else [])
            if isinstance(edit, Mapping)
        ]
    else:
        return ()
    prefix = MEMORY_DIR + "/"
    keys: dict[str, None] = {}
    for path in paths:
        if not isinstance(path, str) or not path:
            continue
        resolved = resolve(path)
        if resolved.startswith(prefix):
            keys[resolved[len(prefix):]] = None
    return tuple(keys)


class MemorySearchTool(Tool):
    """Search notes in the Dot's long-term memory."""

    def __init__(self, computer: Computer) -> None:
        self.computer = computer

    @property
    def name(self) -> str:
        return "memory_search"

    @property
    def description(self) -> str:
        return "Search long-term memory notes by keyword or phrase."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Keyword or literal phrase to find in memory notes.",
                    "minLength": 1,
                },
            },
            "required": ["query"],
        }

    async def execute(self, query: str = "", **kwargs: Any) -> str:
        query = query.strip()
        if not query:
            return "No note mentions empty query."

        res = await self.computer.run(
            ["grep", "-rniF", "-e", query, "--", MEMORY_DIR],
            timeout_s=20.0,
        )
        if res.timed_out:
            return ToolResult.error("Error: memory_search timed out after 20 seconds")
        if res.exit_code == 1 or not res.stdout.strip():
            return f"No note mentions {query}."
        if res.exit_code != 0:
            err = res.stderr.decode("utf-8", errors="replace").strip()
            return ToolResult.error(err or f"grep failed with exit code {res.exit_code}")

        text = res.stdout.decode("utf-8", errors="replace")
        lines = text.splitlines()
        capped_lines = lines[:100]
        result = "\n".join(capped_lines)
        if len(lines) > 100 or len(result) > 12000:
            if len(result) > 12000:
                result = result[:12000]
            result += f"\n\n... (truncated: {len(lines)} total lines) ..."
        return result


class MemoryGetTool(Tool):
    """Read a note from the Dot's long-term memory."""

    def __init__(self, computer: Computer) -> None:
        self.computer = computer

    @property
    def name(self) -> str:
        return "memory_get"

    @property
    def description(self) -> str:
        return "Read the complete text of a note from long-term memory."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name of the memory note to read (with or without .md).",
                    "minLength": 1,
                },
            },
            "required": ["name"],
        }

    async def execute(self, name: str = "", **kwargs: Any) -> str:
        name = name.strip()
        if not name:
            return ToolResult.error("Invalid note name: name cannot be empty")
        if "/" in name or "\\" in name or ".." in name:
            return ToolResult.error("Invalid note name: must not contain '/' or '..'")

        note_name = name if name.endswith(".md") else f"{name}.md"
        path = f"{MEMORY_DIR}/{note_name}"
        raw = await self.computer.read_bytes(path)
        if raw is None:
            return f"No note named {name}."
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return f"Cannot read binary note ({len(raw)} bytes)"

