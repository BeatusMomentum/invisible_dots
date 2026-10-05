"""The guest's own checks (invisible_dots architecture section 9.3).

The host calls a Dot READY only when they pass. They run at most once per TTL,
and never twice at the same time, because the host polls `/health` while it waits.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_NETWORK_TARGET = "openrouter.ai:443"
DEFAULT_BROWSER_COMMAND = "invisible-playwright-mcp"


@dataclass(frozen=True)
class GuestChecks:
    filesystem_writable: bool
    network_reachable: bool
    browser_installed: bool

    def to_json(self) -> dict[str, bool]:
        return asdict(self)


GuestCheckRunner = Callable[[], Awaitable[GuestChecks]]


def create_guest_checks(
    *,
    writable_dir: str | Path,
    browser_command: str = DEFAULT_BROWSER_COMMAND,
    network_target: str = DEFAULT_NETWORK_TARGET,
    path: str = "",
    timeout_s: float = 3.0,
    ttl_s: float = 30.0,
) -> GuestCheckRunner:
    """Build the check runner.

    writable_dir: a directory the engine must be able to write, its state directory.
    network_target: `host:port` reached with a plain TCP connect.
    browser_command: the program that starts the browser layer's MCP server, a path or a name looked up in `path`.
    """
    cached: tuple[float, GuestChecks] | None = None
    running: asyncio.Task[GuestChecks] | None = None

    async def run() -> GuestChecks:
        writable, reachable, installed = await asyncio.gather(
            asyncio.to_thread(_can_write, Path(writable_dir)),
            _can_connect(network_target, timeout_s),
            asyncio.to_thread(_is_installed, browser_command, path),
        )
        return GuestChecks(writable, reachable, installed)

    async def checks() -> GuestChecks:
        nonlocal cached, running
        if cached is not None and time.monotonic() - cached[0] < ttl_s:
            return cached[1]
        if running is None:
            running = asyncio.get_running_loop().create_task(run())
            running.add_done_callback(_forget)
        value = await asyncio.shield(running)
        cached = (time.monotonic(), value)
        return value

    def _forget(_: asyncio.Task[GuestChecks]) -> None:
        nonlocal running
        running = None

    return checks


def _can_write(directory: Path) -> bool:
    probe = directory / f".write-check-{os.getpid()}"
    try:
        probe.write_bytes(b"ok")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


async def _can_connect(target: str, timeout_s: float) -> bool:
    host, separator, port_text = target.rpartition(":")
    if not separator or not host:
        host, port_text = target, "443"
    try:
        port = int(port_text)
    except ValueError:
        return False
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout_s)
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return True


def _is_installed(command: str, path: str) -> bool:
    """Whether `command` names an executable file, directly or through `path`."""
    if os.path.isabs(command) or "/" in command:
        candidates = [command]
    else:
        candidates = [os.path.join(directory, command) for directory in path.split(os.pathsep) if directory]
    return any(os.path.isfile(candidate) and os.access(candidate, os.X_OK) for candidate in candidates)
