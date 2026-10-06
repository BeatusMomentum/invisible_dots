"""Computer abstraction: model commands and files run as dot through dot-agentd."""

from __future__ import annotations

import asyncio
import os
import posixpath
import signal
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Protocol

import httpx

RELAY_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
DEFAULT_AGENTD_BIN = "/opt/invisible-dots/bin/dot-agentd"
DEFAULT_AGENTD_SOCKET = "/run/invisible-dots/agentd.sock"
DEFAULT_WORKSPACE = "/home/dot/workspace"

# dot-agentd answers 400 for a directory where a file was named, or the reverse,
# and for a device or a pipe where a regular file was.
WRONG_KIND = 400


@dataclass(frozen=True)
class Entry:
    """One entry in a directory listing or stat answer."""

    name: str
    type: str  # "file" | "dir" | "other"
    size: int
    mtime: str


@dataclass(frozen=True)
class RunResult:
    """The outcome of running a program on the computer."""

    exit_code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False


class ComputerError(Exception):
    """Error communicating with dot-agentd, carrying route and status only (0: dot-agentd did not answer)."""

    def __init__(self, route: str, status_code: int) -> None:
        super().__init__(f"{route} failed with status {status_code}")
        self.route = route
        self.status_code = status_code


class FileTooLargeError(Exception):
    """A file is larger than the caller is willing to load; none of it was read."""

    def __init__(self, size: int, max_bytes: int) -> None:
        super().__init__(f"file is {size} bytes, more than the {max_bytes} allowed")
        self.size = size
        self.max_bytes = max_bytes


class Computer(Protocol):
    """What the Dot runtime needs of its operating system."""

    workspace: str

    def resolve(self, path: str) -> str:
        """Resolve a relative or absolute path against workspace."""
        ...

    async def read_bytes(self, path: str, *, max_bytes: int | None = None) -> bytes | None:
        """Read file contents, or None if the file does not exist.

        A file larger than max_bytes raises FileTooLargeError before its content
        is loaded.
        """
        ...

    async def write_bytes(self, path: str, data: bytes) -> None:
        """Write file contents atomically, creating parent directories as needed."""
        ...

    async def list_dir(self, path: str) -> list[Entry] | None:
        """List directory entries, or None if the directory does not exist."""
        ...

    async def stat(self, path: str) -> Entry | None:
        """Describe a single path, or None if it does not exist."""
        ...

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        stdin: bytes = b"",
        timeout_s: float | None = None,
    ) -> RunResult:
        """Run a program with argv directly (no shell)."""
        ...

    async def screenshot(self) -> bytes:
        """The Dot's whole desktop as a PNG."""
        ...

    def relay_argv(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        tty: bool = False,
        env: dict[str, str] | None = None,
        secrets: Mapping[str, str] | None = None,
    ) -> list[str]:
        """Wrap argv in dot-agentd relay command.

        env is added to the program's environment inside the VM (dot-agentd's
        --env), in the order given. It is not the environment of the relay
        process itself, which spawn_env decides.

        secrets are added to it too, but their values never reach the command
        line, which every user of the VM can read in /proc: only the names do
        (--env-from), and the relay reads each value from its own environment,
        which only its owner can read. The caller hands the same mapping to
        spawn_env.
        """
        ...

    def spawn_env(self, *, tty: bool = False, secrets: Mapping[str, str] | None = None) -> dict[str, str]:
        """Environment passed to local subprocesses spawning the relay.

        secrets are the values the relay forwards by name (relay_argv's secrets).
        """
        ...


def resolve_path(workspace: str, path: str) -> str:
    """Absolute paths stay as they are, relative ones are joined to the workspace.

    Nothing else is checked: what the Dot may touch is decided by the operating
    system, as the user dot.
    """
    if posixpath.isabs(path):
        return posixpath.normpath(path)
    return posixpath.normpath(posixpath.join(workspace, path))


async def kill_process_group(process: asyncio.subprocess.Process) -> None:
    """Kill a process started with start_new_session=True and its group, then wait.

    For a relay this is what ends the remote command: dot-agentd kills the remote
    process group when the relay goes away. The group is signalled even when the
    process has already exited, because what it started may outlive it.
    """
    with suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, signal.SIGKILL)
    if process.returncode is None:
        with suppress(ProcessLookupError):
            process.kill()
    with suppress(asyncio.TimeoutError):
        await asyncio.wait_for(process.wait(), timeout=5.0)


@asynccontextmanager
async def _reaching(route: str) -> AsyncIterator[None]:
    """A request to dot-agentd that never got an answer (its socket is gone, it hung up) is a ComputerError
    of status 0, so a caller that handles a failed request handles this one too."""
    try:
        yield
    except httpx.TransportError as error:
        raise ComputerError(route, 0) from error


class AgentdComputer:
    """The Dot's computer reached through dot-agentd."""

    def __init__(
        self,
        agentd_bin: str = DEFAULT_AGENTD_BIN,
        agentd_socket: str = DEFAULT_AGENTD_SOCKET,
        workspace: str = DEFAULT_WORKSPACE,
    ) -> None:
        self.agentd_bin = agentd_bin
        self.agentd_socket = agentd_socket
        self.workspace = workspace
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            transport = httpx.AsyncHTTPTransport(uds=self.agentd_socket)
            self._client = httpx.AsyncClient(transport=transport, base_url="http://agentd")
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    def resolve(self, path: str) -> str:
        return resolve_path(self.workspace, path)

    def relay_argv(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        tty: bool = False,
        env: dict[str, str] | None = None,
        secrets: Mapping[str, str] | None = None,
    ) -> list[str]:
        cmd = [self.agentd_bin, "relay", "--socket", self.agentd_socket]
        if tty:
            cmd.append("--tty")
        if cwd:
            cmd.extend(["--cwd", cwd])
        for name, value in (env or {}).items():
            cmd.extend(["--env", f"{name}={value}"])
        for name in secrets or {}:
            cmd.extend(["--env-from", name])
        cmd.append("--")
        cmd.extend(argv)
        return cmd

    def spawn_env(self, *, tty: bool = False, secrets: Mapping[str, str] | None = None) -> dict[str, str]:
        env = {"PATH": RELAY_PATH}
        if tty:
            env["TERM"] = os.environ.get("TERM", "xterm-256color")
        env.update(secrets or {})
        return env

    async def read_bytes(self, path: str, *, max_bytes: int | None = None) -> bytes | None:
        resolved = self.resolve(path)
        client = self._get_client()
        async with _reaching("GET /v1/files"), client.stream("GET", "/v1/files", params={"path": resolved}) as resp:
            if resp.status_code == 404:
                return None
            if not 200 <= resp.status_code < 300:
                raise ComputerError("GET /v1/files", resp.status_code)
            if max_bytes is not None:
                declared = int(resp.headers.get("content-length", "0"))
                if declared > max_bytes:
                    raise FileTooLargeError(declared, max_bytes)
            chunks: list[bytes] = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if max_bytes is not None and total > max_bytes:
                    raise FileTooLargeError(total, max_bytes)
                chunks.append(chunk)
            return b"".join(chunks)

    async def write_bytes(self, path: str, data: bytes) -> None:
        resolved = self.resolve(path)
        client = self._get_client()
        async with _reaching("PUT /v1/files"):
            resp = await client.put(
                "/v1/files",
                params={"path": resolved},
                content=data,
                headers={"Content-Type": "application/octet-stream"},
            )
        if 200 <= resp.status_code < 300:
            return
        raise ComputerError("PUT /v1/files", resp.status_code)

    async def list_dir(self, path: str) -> list[Entry] | None:
        resolved = self.resolve(path)
        client = self._get_client()
        async with _reaching("GET /v1/files/list"):
            resp = await client.get("/v1/files/list", params={"path": resolved})
        if resp.status_code == 404:
            return None
        if 200 <= resp.status_code < 300:
            data = resp.json()
            return [
                Entry(
                    name=e["name"],
                    type=e.get("type", "other"),
                    size=e.get("size", 0),
                    mtime=e.get("mtime", ""),
                )
                for e in data.get("entries", [])
            ]
        raise ComputerError("GET /v1/files/list", resp.status_code)

    async def stat(self, path: str) -> Entry | None:
        resolved = self.resolve(path)
        if resolved == "/":
            return Entry(name="/", type="dir", size=0, mtime="")
        parent = posixpath.dirname(resolved)
        base = posixpath.basename(resolved)
        try:
            entries = await self.list_dir(parent)
        except ComputerError as exc:
            if exc.status_code == WRONG_KIND:
                return None  # the parent is a file, so nothing is under it
            raise
        if entries is None:
            return None
        for e in entries:
            if e.name == base:
                return e
        return None

    async def screenshot(self) -> bytes:
        async with _reaching("GET /v1/screenshot"):
            resp = await self._get_client().get("/v1/screenshot")
        if 200 <= resp.status_code < 300:
            return resp.content
        raise ComputerError("GET /v1/screenshot", resp.status_code)

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        stdin: bytes = b"",
        timeout_s: float | None = None,
    ) -> RunResult:
        relay_cmd = self.relay_argv(argv, cwd=cwd, tty=False)
        proc = await asyncio.create_subprocess_exec(
            *relay_cmd,
            env=self.spawn_env(tty=False),
            stdin=asyncio.subprocess.PIPE if stdin else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(stdin or None), timeout=timeout_s
            )
        except asyncio.TimeoutError:
            await kill_process_group(proc)
            stdout, stderr = await proc.communicate()
            return RunResult(exit_code=124, stdout=stdout, stderr=stderr, timed_out=True)
        except asyncio.CancelledError:
            await kill_process_group(proc)
            raise
        return RunResult(exit_code=proc.returncode or 0, stdout=stdout, stderr=stderr)
