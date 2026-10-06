"""A Computer over a local directory, for the tests of the tools.

Production has only AgentdComputer. This double answers the same protocol on the
machine running the tests: files are local files, run() runs argv locally, and
the relay is the fake relay (fake_relay.py), so exec and exec sessions take the
same relay path as in production.

Paths under /home/dot (the Dot's memory, its default workspace) live under the
double's root, so a test can name them as the engine does. Every other path is a
real local path, so a test can use pytest's tmp_path directly.
"""

from __future__ import annotations

import asyncio
import stat as stat_module
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from nanobot.dots.computer import (
    DEFAULT_AGENTD_SOCKET,
    AgentdComputer,
    ComputerError,
    Entry,
    FileTooLargeError,
    RunResult,
    kill_process_group,
)

FAKE_RELAY = Path(__file__).with_name("fake_relay.py")
VIRTUAL_HOME = "/home/dot"

# One scratch directory for every fake relay of the test process, removed when it
# exits: a computer the test no longer holds must not take its relay with it.
_RELAY_DIR = tempfile.TemporaryDirectory(prefix="fake-relay-")


def install_fake_relay(directory: Path, log: Path | None = None) -> Path:
    """Write an executable that runs fake_relay.py; it appends each call to `log`.

    A wrapper script, because the engine starts the relay with PATH as its only
    environment variable: the log's name cannot travel in the engine's env.
    """
    script = directory / f"dot-agentd-{uuid.uuid4().hex}"
    lines = ["#!/bin/sh"]
    if log is not None:
        lines.append(f"FAKE_RELAY_LOG='{log}'")
        lines.append("export FAKE_RELAY_LOG")
    lines.append(f"exec '{sys.executable}' '{FAKE_RELAY}' \"$@\"")
    script.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
    script.chmod(0o755)
    return script


def _entry(path: Path) -> Entry:
    """Describe a path as dot-agentd lists it: links followed, a dangling one is "other"."""
    try:
        info = path.stat()
    except OSError:
        return Entry(name=path.name, type="other", size=0, mtime=datetime.fromtimestamp(0, tz=timezone.utc).isoformat())
    if stat_module.S_ISDIR(info.st_mode):
        kind = "dir"
    elif stat_module.S_ISREG(info.st_mode):
        kind = "file"
    else:
        kind = "other"
    mtime = datetime.fromtimestamp(info.st_mtime, tz=timezone.utc).isoformat()
    return Entry(name=path.name, type=kind, size=info.st_size, mtime=mtime)


class LocalComputer:
    def __init__(
        self,
        root: Path | str,
        workspace: str | Path | None = None,
        *,
        relay_log: Path | None = None,
    ) -> None:
        self.root = Path(root)
        self.workspace = Path(workspace).as_posix() if workspace is not None else self.root.as_posix()
        self.relay_log = relay_log
        self._agentd = AgentdComputer(
            agentd_bin=str(install_fake_relay(Path(_RELAY_DIR.name), relay_log)),
            agentd_socket=DEFAULT_AGENTD_SOCKET,
            workspace=self.workspace,
        )

    def _local(self, path: str) -> Path:
        resolved = self.resolve(path)
        if resolved == VIRTUAL_HOME or resolved.startswith(VIRTUAL_HOME + "/"):
            return self.root / resolved.lstrip("/")
        return Path(resolved)

    def _virtual(self, text: bytes) -> bytes:
        """Name the double's own root as the Dot's /home/dot again."""
        return text.replace(str(self.root / VIRTUAL_HOME.lstrip("/")).encode(), VIRTUAL_HOME.encode())

    def resolve(self, path: str) -> str:
        return self._agentd.resolve(path)

    async def read_bytes(self, path: str, *, max_bytes: int | None = None) -> bytes | None:
        local = self._local(path)
        if not local.exists():
            return None
        if not local.is_file():
            # dot-agentd answers 400 for a directory and for a device or a pipe.
            raise ComputerError("GET /v1/files", 400)
        size = local.stat().st_size
        if max_bytes is not None and size > max_bytes:
            raise FileTooLargeError(size, max_bytes)
        return local.read_bytes()

    async def write_bytes(self, path: str, data: bytes) -> None:
        local = self._local(path)
        if local.is_dir():
            raise ComputerError("PUT /v1/files", 400)
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(data)

    async def list_dir(self, path: str) -> list[Entry] | None:
        local = self._local(path)
        if not local.exists():
            return None
        if not local.is_dir():
            raise ComputerError("GET /v1/files/list", 400)
        return [_entry(child) for child in sorted(local.iterdir())]

    async def stat(self, path: str) -> Entry | None:
        local = self._local(path)
        return _entry(local) if local.exists() else None

    def relay_argv(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        tty: bool = False,
        env: dict[str, str] | None = None,
    ) -> list[str]:
        return self._agentd.relay_argv(
            argv, cwd=str(self._local(cwd)) if cwd else None, tty=tty, env=env
        )

    def spawn_env(self, *, tty: bool = False) -> dict[str, str]:
        return self._agentd.spawn_env(tty=tty)

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        stdin: bytes = b"",
        timeout_s: float | None = None,
    ) -> RunResult:
        local_argv = [
            str(self._local(arg)) if arg == VIRTUAL_HOME or arg.startswith(VIRTUAL_HOME + "/") else arg
            for arg in argv
        ]
        process = await asyncio.create_subprocess_exec(
            *local_argv,
            cwd=str(self._local(cwd or self.workspace)),
            stdin=asyncio.subprocess.PIPE if stdin else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(stdin or None), timeout=timeout_s
            )
        except asyncio.TimeoutError:
            await kill_process_group(process)
            stdout, stderr = await process.communicate()
            return RunResult(124, self._virtual(stdout), self._virtual(stderr), timed_out=True)
        return RunResult(
            process.returncode if process.returncode is not None else 0,
            self._virtual(stdout),
            self._virtual(stderr),
        )
