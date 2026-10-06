"""A stand-in for `invisible-playwright-mcp` over stdio, run by the tests as the MCP program.

It speaks real MCP through the SDK, answers with the sentences the real server uses, and writes what
it was started with and every call it receives to `$INVISIBLE_MCP_HOME/record.jsonl`, so a test can
assert on the process's environment, working directory and calls. Its behavior is steered by
`$INVISIBLE_MCP_HOME/control.json`, because the engine hands the process an environment of its own
and a test cannot add a variable to it.

Its `tools/list` is the real server's (`tests/fixtures/mcp-tools-0.70.2.json`) and the SDK checks every
call against those input schemas. The server also refuses an argument the real tool does not have,
so a parameter renamed in a call fails here and not only inside a Dot.

`install_fake_mcp` writes the executable the manager runs as the MCP command, the way
`local_computer.install_fake_relay` does for the relay.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "mcp-tools-0.70.2.json"
SCRIPT = Path(__file__).resolve()

# A 1x1 transparent PNG, and a JPEG of one pixel.
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="


def install_fake_mcp(directory: Path) -> Path:
    """Write an executable that runs this file with the interpreter of the tests; returns its path."""
    script = directory / f"fake-mcp-{uuid.uuid4().hex}"
    script.write_bytes(f"#!/bin/sh\nexec '{sys.executable}' '{SCRIPT}' \"$@\"\n".encode("utf-8"))
    script.chmod(0o755)
    return script


def read_record(mcp_home: Path) -> list[dict[str, Any]]:
    """What the fake wrote under `mcp_home`: one entry per start, call and exit, oldest first."""
    path = mcp_home / "record.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_control(mcp_home: Path, **control: Any) -> None:
    """Steer the next fake started with this `mcp_home`.

    download_answers: `browser_open` answers with the engine's download progress this many times first.
    fail_open: `browser_open` fails the way the real server does when Firefox does not start.
    echo_proxy: the failure of `browser_open` names the proxy it was started with, as a server may.
    lose_browser_once: the first page action after opening reports the browser gone, as after a Firefox crash.
    lose_browser_always: every page action does.
    refuse_close: `browser_close` fails.
    fail_watch: `browser_watch` fails the way the real server does when the browser has no page.

A `browser_navigate` to `https://crash.test/now` ends the process without an answer, like a server killed in the
middle of a call; to `slow://...` it answers after 0.3 s. Each call is recorded when it arrives
(`call`) and when it is answered (`done`).
    """
    mcp_home.mkdir(parents=True, exist_ok=True)
    (mcp_home / "control.json").write_bytes(json.dumps(control).encode("utf-8"))


def _tools() -> list[dict[str, Any]]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["tools"]


async def _serve() -> None:
    import mcp.types as types
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server

    home = Path(os.environ.get("INVISIBLE_MCP_HOME") or os.getcwd())
    record_file = home / "record.jsonl"
    control_file = home / "control.json"
    control: dict[str, Any] = json.loads(control_file.read_text(encoding="utf-8")) if control_file.exists() else {}

    def record(entry: dict[str, Any]) -> None:
        with record_file.open("a", encoding="utf-8") as out:
            out.write(json.dumps(entry) + "\n")

    record({"kind": "start", "pid": os.getpid(), "argv": sys.argv[1:], "env": dict(os.environ), "cwd": os.getcwd()})

    tools = {tool["name"]: tool for tool in _tools()}
    state: dict[str, Any] = {
        "download_left": int(control.get("download_answers", 0)),
        "lose_browser": bool(control.get("lose_browser_once", False) or control.get("lose_browser_always", False)),
        "open": False,
        "url": "about:blank",
    }

    def text(value: str, *, error: bool = False) -> types.CallToolResult:
        return types.CallToolResult(content=[types.TextContent(type="text", text=value)], isError=error)

    def image(data: str, mime: str) -> types.CallToolResult:
        return types.CallToolResult(content=[types.ImageContent(type="image", data=data, mimeType=mime)])

    def call(name: str, args: dict[str, Any]) -> types.CallToolResult:
        unknown = sorted(set(args) - set(tools[name]["inputSchema"].get("properties", {})))
        if unknown:
            return text(f"invalid arguments for {name}: it has no argument {', '.join(unknown)}", error=True)
        role = args.get("browser") or "main"

        if name == "browser_open":
            if control.get("fail_open"):
                proxy = f" ({os.environ.get('STEALTHFOX_PROXY')})" if control.get("echo_proxy") else ""
                return text(f"the {role} browser did NOT start: proxy refused the connection{proxy}", error=True)
            if state["download_left"] > 0:
                state["download_left"] -= 1
                return text(
                    "the engine is not on this machine yet and is downloading now: 40% of 90 MB. "
                    "Call browser_open again in a minute; nothing else needs doing."
                )
            state["open"] = True
            return text(f"the {role} browser is open. seed: remembered by the profile")
        if name == "browser_close":
            if control.get("refuse_close"):
                return text(f"the {role} browser could not be closed", error=True)
            was_open, state["open"] = state["open"], False
            return text(f"the {role} browser is closed." if was_open else f"the {role} browser is not open.")
        if name == "browser_list":
            return text(json.dumps({"focus": "main", "browsers": []}))
        if not state["open"]:
            return text(f"the {role} browser is not open. Call browser_open to open it.", error=True)
        if state["lose_browser"]:
            state["lose_browser"] = bool(control.get("lose_browser_always", False))
            state["open"] = False
            return text(f"the {role} browser is gone: it closed or crashed. Call browser_open to open it again.", error=True)

        if name == "browser_status":
            return text(f"the {role} browser is open on {state['url']}")
        if name == "browser_navigate":
            if args.get("url") == "https://crash.test/now":
                # Exit without answering, like a server killed in the middle of a call.
                record({"kind": "exit", "code": 3})
                os._exit(3)
            state["url"] = str(args["url"])
            return text(f"200 {state['url']}")
        if name == "browser_snapshot":
            return text(f"title: Fake\nurl: {state['url']}\n- button \"Go\" selector: #go at: [10, 20]")
        if name == "browser_read_text":
            return text(f"text of {args.get('selector', 'body')}")
        if name == "browser_take_screenshot" or name == "browser_click_at":
            return image(PNG, "image/png")
        if name == "browser_watch":
            if control.get("fail_watch"):
                return text(f"the {role} browser has no page to watch", error=True)
            return image(JPEG, "image/jpeg")
        if name == "browser_click":
            return text(f"clicked {args['selector']}")
        if name == "browser_type":
            return text(f"typed into {args['selector']}")
        if name == "browser_select_option":
            return text(f"selected {args['value']} in {args['selector']}")
        if name == "browser_press_key":
            return text(f"pressed {args['key']}")
        if name == "browser_read_html":
            return text("<form></form>")
        if name == "browser_evaluate":
            return text("null")
        return text(f"unknown tool {name}", error=True)

    server: Server[Any] = Server("fake-stealth")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [types.Tool(name=tool["name"], inputSchema=tool["inputSchema"]) for tool in tools.values()]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        record({"kind": "call", "name": name, "args": arguments})
        if str(arguments.get("url", "")).startswith("slow://"):
            await asyncio.sleep(0.3)
        result = call(name, arguments)
        record({"kind": "done", "name": name})
        return result

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())
    record({"kind": "exit", "code": 0})


if __name__ == "__main__":
    asyncio.run(_serve())
