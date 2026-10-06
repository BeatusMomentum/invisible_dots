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
import base64
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "mcp-tools-0.70.2.json"
SCRIPT = Path(__file__).resolve()

# A 1x1 transparent PNG, and a JPEG of one pixel.
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="


def proxy_forms(proxy: str) -> dict[str, str]:
    """The forms in which the proxy URL's credentials can show up in what a server or Firefox says.

    The real wrapper splits the URL with `urlparse` and unquotes the user and the password
    (`invisible_playwright_mcp/mcp/proxy.py`), so what it hands on and what a proxy's answer or a log line
    repeats is the password as written, decoded or encoded again (`quote` with its `safe=""` and with its
    default `safe="/"`), with the user in front of it, or the Basic credentials of a `Proxy-Authorization`
    header. A traceback or a log line writes it escaped too: the `repr` of the URL or of the password
    (`ValueError(f"proxy URL {url!r} ...")` doubles a backslash) or the inside of a JSON string.
    """
    parsed = urlparse(proxy)
    written_user, written_password = parsed.username or "", parsed.password or ""
    user, password = unquote(written_user), unquote(written_password)
    return {
        "password_as_written": written_password,
        "password_decoded": password,
        "password_encoded_again": quote(password, safe=""),
        "password_encoded_keeping_slash": quote(password),
        "password_repr": repr(password)[1:-1],
        "password_json": json.dumps(password)[1:-1],
        "userinfo_as_written": f"{written_user}:{written_password}",
        "userinfo_decoded": f"{user}:{password}",
        "basic_credentials": base64.b64encode(f"{user}:{password}".encode()).decode(),
        "url_repr": repr(proxy),
        "url_json": json.dumps(proxy),
    }


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
    echo_proxy_on_pages: `browser_navigate` fails and `browser_read_text` answers naming that proxy too.
    echo_proxy_as: the name of one of `proxy_forms`: `browser_open` (with `fail_open`), `browser_navigate` and
        `browser_read_text` say that form of the proxy's credentials instead of the whole URL.
    stderr_proxy: the process writes the proxy URL and every form of `proxy_forms` to its stderr when it starts,
        one per line, and once more all of them in the middle of one very long line.
    lose_browser_once: the first page action after opening reports the browser gone, as after a Firefox crash.
    lose_browser_always: every page action does.
    overlay_says_gone: `browser_click` fails the way a blocked click does, with a diagnosis of the covering element
        whose text is the sentence of a lost browser: a page controls that text, and the browser is not lost.
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
    if control.get("stderr_proxy"):
        proxy_url = os.environ.get("STEALTHFOX_PROXY", "")
        forms = proxy_forms(proxy_url)
        for name, form in forms.items():
            sys.stderr.write(f"[{name}] {form}\n")
        sys.stderr.write(f"[url] {proxy_url}\n")
        sys.stderr.write("padding " * 20_000 + " ".join(forms.values()) + " padding" * 20_000 + "\n")
        sys.stderr.write("[stderr written]\n")
        sys.stderr.flush()

    tools = {tool["name"]: tool for tool in _tools()}
    state: dict[str, Any] = {
        "download_left": int(control.get("download_answers", 0)),
        "lose_browser": bool(control.get("lose_browser_once", False) or control.get("lose_browser_always", False)),
        "open": False,
        "url": "about:blank",
    }

    echoed_form = proxy_forms(os.environ.get("STEALTHFOX_PROXY", ""))[control["echo_proxy_as"]] if control.get("echo_proxy_as") else None

    def text(value: str, *, error: bool = False) -> types.CallToolResult:
        return types.CallToolResult(content=[types.TextContent(type="text", text=value)], isError=error)

    def tool_error(name: str, message: str) -> types.CallToolResult:
        # What the real server's FastMCP answers when a tool raises: the library's sentence behind this prefix.
        return text(f"Error executing tool {name}: {message}", error=True)

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
                if echoed_form is not None:
                    proxy = f" (credentials {echoed_form})"
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
            return tool_error(name, f"the {role} browser is not open. Call browser_open to open it.")
        if state["lose_browser"]:
            state["lose_browser"] = bool(control.get("lose_browser_always", False))
            state["open"] = False
            return tool_error(
                name,
                f"the {role} browser is gone: it closed or crashed. Call browser_open to open it again; "
                "it comes back as the same person.",
            )

        if name == "browser_status":
            return text(f"the {role} browser is open on {state['url']}")
        if name == "browser_navigate":
            if args.get("url") == "https://crash.test/now":
                # Exit without answering, like a server killed in the middle of a call.
                record({"kind": "exit", "code": 3})
                os._exit(3)
            if control.get("echo_proxy_on_pages"):
                return text(f"navigation failed through {os.environ.get('STEALTHFOX_PROXY')}", error=True)
            if echoed_form is not None:
                return text(f"navigation failed: the proxy refused the credentials {echoed_form}", error=True)
            state["url"] = str(args["url"])
            return text(f"200 {state['url']}")
        if name == "browser_snapshot":
            return text(f"title: Fake\nurl: {state['url']}\n- button \"Go\" selector: #go at: [10, 20]")
        if name == "browser_read_text":
            if control.get("echo_proxy_on_pages"):
                return text(f"page behind {os.environ.get('STEALTHFOX_PROXY')}")
            if echoed_form is not None:
                return text(f"page behind the credentials {echoed_form}")
            return text(f"text of {args.get('selector', 'body')}")
        if name == "browser_take_screenshot" or name == "browser_click_at":
            return image(PNG, "image/png")
        if name == "browser_watch":
            if control.get("fail_watch"):
                return text(f"the {role} browser has no page to watch", error=True)
            return image(JPEG, "image/jpeg")
        if name == "browser_click":
            if control.get("overlay_says_gone"):
                diagnosis = {"covered_by": {"text": f"the {role} browser is gone", "cls": "overlay"}}
                return tool_error(name, f"click on {args['selector']} failed: it is covered: {json.dumps(diagnosis)}")
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
        return [
            types.Tool(name=tool["name"], description=tool["description"], inputSchema=tool["inputSchema"])
            for tool in tools.values()
        ]

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
