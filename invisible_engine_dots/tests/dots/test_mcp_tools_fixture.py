"""The captured tool list of invisible-playwright-mcp, and the version it was captured at.

`tests/fixtures/mcp-tools-0.70.2.json` is `tools/list` of the real server (names and input schemas),
captured over stdio. The browser tools of the engine call these tools, and the fake MCP servers of
the tests serve this list, so the fixture has to describe the version the golden image installs:
`guest/image-builder/builder/mcp-requirements.lock` is the one place that version is written.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

ENGINE_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ENGINE_ROOT / "tests" / "fixtures" / "mcp-tools-0.70.2.json"
LOCK = ENGINE_ROOT.parent / "guest" / "image-builder" / "builder" / "mcp-requirements.lock"
PACKAGE = "invisible-playwright-mcp"

CAPTURE: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))


def locked_version(package: str) -> str:
    match = re.search(rf"^{re.escape(package)}==(\S+)", LOCK.read_text(encoding="utf-8"), re.MULTILINE)
    assert match is not None, f"{package} is not pinned in {LOCK.name}"
    return match.group(1)


def test_the_capture_is_of_the_version_the_image_installs() -> None:
    assert CAPTURE["package"] == PACKAGE
    assert CAPTURE["version"] == locked_version(PACKAGE), (
        "the lock moved to another invisible-playwright-mcp version: capture its tools/list again "
        "and replace the fixture, named for the new version"
    )


def test_the_fixture_is_named_for_its_version() -> None:
    assert FIXTURE.name == f"mcp-tools-{CAPTURE['version']}.json"


def test_the_capture_is_the_sixteen_tools_of_the_pinned_version() -> None:
    assert [tool["name"] for tool in CAPTURE["tools"]] == [
        "browser_open",
        "browser_close",
        "browser_list",
        "browser_status",
        "browser_navigate",
        "browser_read_text",
        "browser_snapshot",
        "browser_read_html",
        "browser_take_screenshot",
        "browser_watch",
        "browser_click",
        "browser_click_at",
        "browser_type",
        "browser_select_option",
        "browser_press_key",
        "browser_evaluate",
    ]


@pytest.mark.parametrize("tool", CAPTURE["tools"], ids=lambda tool: tool["name"])
def test_every_tool_takes_a_browser_argument_except_the_listing(tool: dict[str, Any]) -> None:
    assert tool["inputSchema"]["type"] == "object"
    assert ("browser" in tool["inputSchema"].get("properties", {})) == (tool["name"] != "browser_list")
