"""The browser identities of the Dot and the invisible-playwright-mcp process of each open one.

Architecture section 6: an identity is a directory under `/home/dot/browsers/<id>` (a Firefox profile
and the MCP server's own home) plus one row of the Dot's database. An identity is OPEN while a
`invisible-playwright-mcp` process serves it, and at most `max_open` are at once. A browser action
runs as a tool call of that process, so the model sees our tool names and an `identity_id`, never the
MCP server's.

Three rules shape this module:

* Nothing model-driven runs as the engine's user. The MCP server is started through
  `dot-agentd relay` (the Computer's `relay_argv`), which runs it as `dot`, so its Firefox reads
  dot's home and the engine's secrets are not in its environment. The directories are made and
  removed through the Computer for the same reason: `/home/dot/browsers` is `dot` 0700.
* nanobot's MCP client stays in use. Each open identity has its own `MCPProvider` on a private
  registry, so spawning, initialize, per-call timeout and the one retry of a transient error are the
  client's. What is the manager's is when a process ends: it gets `on_terminated` instead of a silent
  reconnect, because a restarted process has lost its browser.
* One lock orders launch, close and delete (so the open count and the LRU order stay true when the
  model and the host act at once); calls on one identity are serialized by that identity's own lock.

An action on a closed identity does not launch it: it fails with `not_open`, so `browser.identity.launch`
decides alone whether a browser starts. An identity whose process ended (`crashed`) is closed, the
`closed` event is emitted once, and the next action says `not_open` like any other.
"""

from __future__ import annotations

import asyncio
import base64
import posixpath
import re
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from loguru import logger

from nanobot.agent.tools.base import ToolResult
from nanobot.agent.tools.mcp import MCPProvider, MCPServerConfig
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.dots import store as dots_store
from nanobot.dots.computer import Computer
from nanobot.dots.identity_rules import (
    IdentityRequestError,
    check_identity_request,
    is_valid_identity_id,
    new_identity_id,
    redact_proxy,
)
from nanobot.dots.protocol import BROWSER_ENV, BROWSERS_DIR, GUEST_DISPLAY
from nanobot.dots.store import BrowserIdentityRow, DotStore

# The MCP server's own browser, the one carrying the identity. The server also has a `support` browser;
# the manager never uses it, and adds this to every call so a caller cannot choose another.
MAIN_BROWSER = "main"
# The name the private registry of one identity knows its one MCP server by.
SERVER_NAME = "browser"

# What `browser_open` answers when the browser started. Anything else that is not an error is the
# engine's download progress, and it is asked again.
_OPENED = re.compile(r"\bbrowser is open\b", re.IGNORECASE)
# What the server answers when its browser closed under it while the process lives on (Firefox crashed).
_BROWSER_LOST = re.compile(r"\bbrowser is (?:gone|not open)\b", re.IGNORECASE)

_DATA_URL = "data:"

CLOSE_TIMEOUT_S = 30.0
# How long a frame waits for the identity's call in flight before it gives up with `busy`.
FRAME_WAIT_S = 5.0

ErrorCode = Literal["not_found", "invalid", "limit", "not_open", "busy", "launch_failed", "crashed", "frame_failed"]


class BrowserIdentityError(Exception):
    """A failure whose message is meant to be shown as it is, to the model or in an API answer.

    `not_found`, `invalid` (a bad name or proxy, or an archived identity) and `limit` are the caller's;
    `not_open` is an action on an identity that is not open; `busy` is a frame that found the identity
    in the middle of a call; `launch_failed`, `crashed` and `frame_failed` are the browser's.
    """

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class BrowserIdentity:
    """An identity as callers see it. The proxy is the redacted form: the password never leaves the manager."""

    id: str
    name: str
    status: Literal["available", "open", "archived"]
    created_at: int
    last_used_at: int | None
    profile_path: str
    proxy: str | None


class _Session:
    """The MCP process of one open identity, on a registry of its own."""

    def __init__(self, identity_id: str, proxy: str | None, config: MCPServerConfig) -> None:
        self.identity_id = identity_id
        self.proxy = proxy
        self.registry = ToolRegistry()
        self.provider = MCPProvider({SERVER_NAME: config}, self.registry, on_terminated=self._ended)
        # Taken by a call for its whole time, so calls on one identity run one at a time, and by a close.
        self.calls = asyncio.Lock()
        # Set when the MCP client reports the process gone.
        self.terminated = False

    def _ended(self, _server: str) -> None:
        self.terminated = True


def result_text(result: Any) -> str:
    """The text of a tool result: a string as it is, a list of content blocks by its text parts."""
    if isinstance(result, str):
        return result
    return "\n".join(
        part.get("text", "") for part in result if isinstance(part, Mapping) and part.get("type") == "text"
    )


def result_is_error(result: Any) -> bool:
    return isinstance(result, ToolResult) and result.is_error


def split_result(result: Any) -> tuple[str, list[tuple[str, str]]]:
    """A tool result of the MCP client as its text and its images, each as (media type, base64 data)."""
    if isinstance(result, str):
        return str(result), []
    images: list[tuple[str, str]] = []
    for block in result:
        if not isinstance(block, Mapping) or block.get("type") != "image_url":
            continue
        url = (block.get("image_url") or {}).get("url", "")
        header, _, data = url.partition(",")
        if url.startswith(_DATA_URL) and data:
            images.append((header[len(_DATA_URL) :].split(";")[0], data))
    return result_text(result), images


def _check_limits(max_open: int, max_identities: int) -> None:
    for name, value in (("max_open", max_open), ("max_identities", max_identities)):
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f"{name} must be an integer of at least 1")


class BrowserManager:
    """Browser identities, their directories and their MCP processes. Everything asynchronous runs on one loop."""

    def __init__(
        self,
        *,
        store: DotStore,
        computer: Computer,
        mcp_command: str,
        max_open: int,
        max_identities: int,
        browsers_dir: str = BROWSERS_DIR,
        display: str = GUEST_DISPLAY,
        open_deadline_s: float = 900.0,
        open_retry_initial_s: float = 2.0,
        open_retry_max_s: float = 30.0,
        request_timeout_s: int = 120,
        close_timeout_s: float = CLOSE_TIMEOUT_S,
        frame_wait_s: float = FRAME_WAIT_S,
    ) -> None:
        _check_limits(max_open, max_identities)
        if not mcp_command.strip():
            raise ValueError("mcp_command must name a program")
        self._store = store
        self._computer = computer
        self._mcp_command = mcp_command
        self._max_open = max_open
        self._max_identities = max_identities
        self._browsers_dir = browsers_dir
        self._display = display
        self._open_deadline_s = open_deadline_s
        self._open_retry_initial_s = open_retry_initial_s
        self._open_retry_max_s = open_retry_max_s
        self._request_timeout_s = request_timeout_s
        self._close_timeout_s = close_timeout_s
        self._frame_wait_s = frame_wait_s
        # Open identities, least recently used first (a dict keeps insertion order).
        self._sessions: dict[str, _Session] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # What callers read
    # ------------------------------------------------------------------

    @property
    def limits(self) -> tuple[int, int]:
        """`(max_open, max_identities)`."""
        return self._max_open, self._max_identities

    @property
    def open_count(self) -> int:
        return len(self._sessions)

    def is_open(self, identity_id: str) -> bool:
        return identity_id in self._sessions

    def list_identities(self) -> list[BrowserIdentity]:
        """Every identity, oldest first."""
        return [self._view(row) for row in self._store.read(dots_store.list_identities)]

    def get(self, identity_id: str) -> BrowserIdentity | None:
        if not is_valid_identity_id(identity_id):
            return None
        row = self._store.read(lambda conn: dots_store.get_identity(conn, identity_id))
        return self._view(row) if row else None

    # ------------------------------------------------------------------
    # Records
    # ------------------------------------------------------------------

    async def create(self, name: str, proxy: str | None = None) -> BrowserIdentity:
        """Make an identity: its directories on the computer, its row and `browser.identity.created`."""
        async with self._lock:
            body: dict[str, object] = {"name": name}
            if proxy is not None:
                body["proxy"] = proxy
            count = self._store.read(dots_store.count_identities)
            try:
                request = check_identity_request(body, count, self._max_identities)
            except IdentityRequestError as error:
                raise BrowserIdentityError(error.code, error.message) from None
            identity_id = new_identity_id(request.name)
            while self._store.read(lambda conn: dots_store.get_identity(conn, identity_id)) is not None:
                identity_id = new_identity_id(request.name)
            await self._make_directories(identity_id)

            def record(conn: sqlite3.Connection) -> None:
                dots_store.insert_identity(conn, identity_id=identity_id, name=request.name, proxy=request.proxy)
                dots_store.append_outbox(
                    conn, "browser.identity.created", {"identity_id": identity_id, "name": request.name}
                )

            self._store.write(record)
            where = f" with proxy {redact_proxy(request.proxy)}" if request.proxy else ""
            logger.info("browser identity {} created ({}){}", identity_id, request.name, where)
            return self._view(self._require(identity_id))

    async def delete(self, identity_id: str) -> None:
        """Close the identity if open, remove its directory, then its row and emit `browser.identity.deleted`.

        The directory goes before the row: one a failed removal left behind would be invisible, while a
        row whose directory is gone can be deleted again.
        """
        async with self._lock:
            row = self._require(identity_id)
            await self._close_session(identity_id)
            await self._remove_directory(identity_id)

            def forget(conn: sqlite3.Connection) -> None:
                dots_store.delete_identity(conn, identity_id)
                dots_store.append_outbox(
                    conn, "browser.identity.deleted", {"identity_id": identity_id, "name": row.name}
                )

            self._store.write(forget)
            logger.info("browser identity {} deleted with its profile", identity_id)

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    async def launch(self, identity_id: str) -> BrowserIdentity:
        """Open the identity's browser; closes the least recently used identity first when `max_open` is reached."""
        async with self._lock:
            row = self._require(identity_id)
            if row.archived:
                raise BrowserIdentityError("invalid", f'browser identity "{identity_id}" is archived')
            if identity_id in self._sessions:
                self._touch(identity_id)
                return self._view(row)
            while len(self._sessions) >= self._max_open:
                oldest = next(iter(self._sessions))
                logger.info(
                    "closing browser identity {}, the least recently used, to stay within max_open {}",
                    oldest,
                    self._max_open,
                )
                await self._close_session(oldest)
            await self._start_session(row)
            return self._view(self._require(identity_id))

    async def close(self, identity_id: str) -> None:
        """Close the identity's browser (a no-op when it is closed); the profile is kept."""
        async with self._lock:
            self._require(identity_id)
            await self._close_session(identity_id)

    async def close_all(self) -> None:
        """Close every open identity: for suspend, prepare-sleep and shutdown."""
        async with self._lock:
            identities = list(self._sessions)
            outcomes = await asyncio.gather(
                *(self._close_session(identity_id) for identity_id in identities), return_exceptions=True
            )
        for identity_id, outcome in zip(identities, outcomes, strict=True):
            if isinstance(outcome, BaseException):
                logger.error("closing browser identity {} failed: {}: {}", identity_id, type(outcome).__name__, outcome)

    async def set_limits(self, max_open: int, max_identities: int) -> None:
        """Apply new limits from a config change.

        Identities beyond a lower `max_open` are closed, least recently used first, and the others stay
        open. A lower `max_identities` deletes nothing: it refuses new identities until enough are deleted.
        """
        _check_limits(max_open, max_identities)
        async with self._lock:
            self._max_open = max_open
            self._max_identities = max_identities
            while len(self._sessions) > self._max_open:
                oldest = next(iter(self._sessions))
                logger.info(
                    "closing browser identity {}, the least recently used, to stay within the new max_open {}",
                    oldest,
                    self._max_open,
                )
                await self._close_session(oldest)

    async def call_tool(self, identity_id: str, tool: str, arguments: Mapping[str, Any] | None = None) -> Any:
        """Call a tool of the identity's MCP server, with `browser: "main"` added to its arguments.

        Returns what nanobot's MCP client returns: text, or a list of content blocks when the result has
        an image, and an error as a `ToolResult` with `is_error`. When the server says its browser is gone
        while its process lives on, the browser is opened again and the call repeated once. Raises
        `not_open` for an identity that is not open and `crashed` when its process ended.
        """
        session = self._sessions.get(identity_id) if is_valid_identity_id(identity_id) else None
        if session is None:
            raise self._not_open(identity_id)
        async with session.calls:
            if self._sessions.get(identity_id) is not session:
                raise self._not_open(identity_id)
            self._touch(identity_id)
            result = await self._request(session, tool, arguments or {})
            if result_is_error(result) and _BROWSER_LOST.search(result_text(result)) and not session.terminated:
                # The process is alive but its browser closed under it (Firefox crashed, or its window was
                # closed): open it again and repeat once.
                logger.warning(
                    "browser identity {}: the MCP server reports its browser closed; reopening it and repeating {}",
                    identity_id,
                    tool,
                )
                await self._open_browser(session)
                result = await self._request(session, tool, arguments or {})
            if session.terminated:
                await self._process_ended(session)
                raise BrowserIdentityError(
                    "crashed",
                    f'the browser process of identity "{identity_id}" exited during {tool}; '
                    "the identity is closed, launch it again",
                )
            return result

    async def frame(self, identity_id: str) -> tuple[str, bytes]:
        """One frame of the open identity's window, as `(media type, bytes)`: what the UI shows of a browser.

        This only looks. It does not count as a use (the LRU order and `last_used_at` stay as they were, so
        a page that polls cannot keep a browser open), and it never opens a browser the server lost: that
        is `not_open`, because opening is the decision of `browser_identity_launch`. It waits at most
        `frame_wait_s` for the call in flight on the identity and then says `busy`.
        """
        self._require(identity_id)
        session = self._sessions.get(identity_id)
        if session is None:
            raise self._not_open(identity_id)
        try:
            await asyncio.wait_for(session.calls.acquire(), timeout=self._frame_wait_s)
        except asyncio.TimeoutError:
            raise BrowserIdentityError(
                "busy", f'browser identity "{identity_id}" is busy with a call; ask again in a moment'
            ) from None
        try:
            if self._sessions.get(identity_id) is not session:
                raise self._not_open(identity_id)
            result = await self._request(session, "browser_watch", {})
            if session.terminated:
                await self._process_ended(session)
                raise BrowserIdentityError(
                    "crashed",
                    f'the browser process of identity "{identity_id}" exited; the identity is closed, launch it again',
                )
        finally:
            session.calls.release()
        text = _scrub(result_text(result), session.proxy)
        if result_is_error(result):
            if _BROWSER_LOST.search(text):
                raise self._not_open(identity_id)
            raise BrowserIdentityError("frame_failed", f'no frame of identity "{identity_id}": {text}')
        _, images = split_result(result)
        if not images:
            raise BrowserIdentityError("frame_failed", f'no frame of identity "{identity_id}": the server sent no image')
        mime, data = images[0]
        try:
            return mime, base64.b64decode(data, validate=True)
        except ValueError:
            raise BrowserIdentityError(
                "frame_failed", f'no frame of identity "{identity_id}": the image is damaged'
            ) from None

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _view(self, row: BrowserIdentityRow) -> BrowserIdentity:
        status: Literal["available", "open", "archived"] = "archived" if row.archived else "available"
        if row.id in self._sessions:
            status = "open"
        return BrowserIdentity(
            id=row.id,
            name=row.name,
            status=status,
            created_at=row.created_at,
            last_used_at=row.last_used_at,
            profile_path=posixpath.join(self._browsers_dir, row.id, "profile"),
            proxy=redact_proxy(row.proxy) if row.proxy else None,
        )

    def _require(self, identity_id: str) -> BrowserIdentityRow:
        # An id becomes a directory name: one that could leave `browsers/` is "not found", never looked up.
        row = (
            self._store.read(lambda conn: dots_store.get_identity(conn, identity_id))
            if is_valid_identity_id(identity_id)
            else None
        )
        if row is None:
            raise BrowserIdentityError("not_found", f'no browser identity "{identity_id}"')
        return row

    @staticmethod
    def _not_open(identity_id: str) -> BrowserIdentityError:
        return BrowserIdentityError(
            "not_open", f"identity {identity_id} is not open; call browser_identity_launch first"
        )

    def _touch(self, identity_id: str) -> None:
        self._sessions[identity_id] = self._sessions.pop(identity_id)

    def _paths(self, identity_id: str) -> tuple[str, str, str]:
        root = posixpath.join(self._browsers_dir, identity_id)
        return root, posixpath.join(root, "profile"), posixpath.join(root, "mcp")

    async def _make_directories(self, identity_id: str) -> None:
        _, profile, mcp_home = self._paths(identity_id)
        result = await self._computer.run(["mkdir", "-p", "--", profile, mcp_home])
        if result.exit_code != 0:
            raise RuntimeError(
                f"could not make the directories of browser identity {identity_id}: "
                f"{result.stderr.decode('utf-8', 'replace').strip()}"
            )

    async def _remove_directory(self, identity_id: str) -> None:
        root, _, _ = self._paths(identity_id)
        result = await self._computer.run(["rm", "-rf", "--", root])
        if result.exit_code != 0:
            raise RuntimeError(
                f"could not remove the directory of browser identity {identity_id}: "
                f"{result.stderr.decode('utf-8', 'replace').strip()}"
            )

    def _server_config(self, identity_id: str, proxy: str | None) -> MCPServerConfig:
        root, profile, mcp_home = self._paths(identity_id)
        environment = {
            BROWSER_ENV["MCP_HOME"]: mcp_home,
            BROWSER_ENV["MCP_SESSION_ID"]: identity_id,
            BROWSER_ENV["PROFILE_DIR"]: profile,
            BROWSER_ENV["HEADLESS"]: "0",
            BROWSER_ENV["DISPLAY"]: self._display,
        }
        if proxy:
            environment[BROWSER_ENV["PROXY"]] = proxy
        argv = self._computer.relay_argv([self._mcp_command], cwd=root, env=environment)
        return MCPServerConfig(
            command=argv[0],
            args=argv[1:],
            env=self._computer.spawn_env(),
            tool_timeout=self._request_timeout_s,
            images=True,
        )

    async def _start_session(self, row: BrowserIdentityRow) -> None:
        identity_id = row.id
        await self._make_directories(identity_id)
        session = _Session(identity_id, row.proxy, self._server_config(identity_id, row.proxy))
        logger.info("launching browser identity {}: {}", identity_id, self._mcp_command)
        failed = await session.provider.connect()
        if failed or session.registry.get(self._tool_name("browser_open")) is None:
            await session.provider.aclose()
            raise BrowserIdentityError(
                "launch_failed", f'could not start "{self._mcp_command}" for identity "{identity_id}"'
            )
        self._sessions[identity_id] = session
        try:
            await self._open_browser(session)
        except BaseException:
            self._forget(session)
            await session.provider.aclose()
            raise

        def record(conn: sqlite3.Connection) -> None:
            dots_store.touch_identity(conn, identity_id)
            dots_store.append_outbox(conn, "browser.identity.launched", {"identity_id": identity_id, "name": row.name})

        self._store.write(record)
        logger.info("browser identity {} is open", identity_id)

    @staticmethod
    def _tool_name(tool: str) -> str:
        return f"mcp_{SERVER_NAME}_{tool}"

    async def _request(self, session: _Session, tool: str, arguments: Mapping[str, Any]) -> Any:
        wrapper = session.registry.get(self._tool_name(tool))
        if wrapper is None:
            raise ValueError(f"the browser server has no tool {tool}")
        return await wrapper.execute(**{**arguments, "browser": MAIN_BROWSER})

    async def _open_browser(self, session: _Session) -> None:
        """`browser_open` with nothing but the browser role: the environment is the one source of the profile
        and the proxy, and the profile owns the seed.

        While the engine is still downloading, the server answers with its progress instead of a browser,
        so this asks again, waiting 2 s doubling to 30 s, until the deadline.
        """
        identity_id = session.identity_id
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._open_deadline_s
        wait = self._open_retry_initial_s
        while True:
            result = await self._request(session, "browser_open", {})
            text = _scrub(result_text(result), session.proxy)
            if session.terminated:
                raise BrowserIdentityError(
                    "launch_failed", f'the browser process of identity "{identity_id}" exited while it was opening'
                )
            if result_is_error(result):
                raise BrowserIdentityError("launch_failed", f'browser_open failed for identity "{identity_id}": {text}')
            if _OPENED.search(text):
                return
            if loop.time() + wait > deadline:
                raise BrowserIdentityError(
                    "launch_failed",
                    f'the browser of identity "{identity_id}" was not ready within '
                    f"{round(self._open_deadline_s)} s; last answer: {text}",
                )
            logger.info("browser identity {}: not ready yet ({}); asking again in {} s", identity_id, text, wait)
            await asyncio.sleep(wait)
            wait = min(wait * 2, self._open_retry_max_s)

    def _forget(self, session: _Session) -> bool:
        """Drop the session when it is still the identity's; True for the one caller that did."""
        if self._sessions.get(session.identity_id) is not session:
            return False
        del self._sessions[session.identity_id]
        return True

    def _emit_closed(self, identity_id: str) -> None:
        row = self._store.read(lambda conn: dots_store.get_identity(conn, identity_id))
        name = row.name if row else ""

        def record(conn: sqlite3.Connection) -> None:
            dots_store.append_outbox(conn, "browser.identity.closed", {"identity_id": identity_id, "name": name})

        self._store.write(record)

    async def _process_ended(self, session: _Session) -> None:
        """The MCP process is gone: the identity is closed, `closed` is emitted once."""
        if not self._forget(session):
            return
        logger.warning("browser identity {}: the MCP server exited unexpectedly", session.identity_id)
        await session.provider.aclose()
        self._emit_closed(session.identity_id)

    async def _close_session(self, identity_id: str) -> None:
        """Close an open identity: `browser_close` first, so Firefox flushes its profile, then the process.

        The SDK waits only 2 s for a process to leave after its stdin closes, which is too short for
        that. A close that fails is logged and the process is ended anyway.
        """
        session = self._sessions.get(identity_id)
        if session is None:
            return
        async with session.calls:
            if self._sessions.get(identity_id) is not session:
                return
            try:
                result = await asyncio.wait_for(
                    self._request(session, "browser_close", {}), timeout=self._close_timeout_s
                )
                if result_is_error(result):
                    logger.warning(
                        "browser identity {}: browser_close failed ({}); stopping the process anyway",
                        identity_id,
                        result_text(result),
                    )
            except asyncio.TimeoutError:
                logger.warning(
                    "browser identity {}: browser_close timed out after {} s; stopping the process anyway",
                    identity_id,
                    self._close_timeout_s,
                )
            if not self._forget(session):
                return
            await session.provider.aclose()
            self._emit_closed(identity_id)
            logger.info("browser identity {} closed", identity_id)


def _scrub(text: str, proxy: str | None) -> str:
    """An answer of the server with the proxy it may echo in its redacted form."""
    if proxy and proxy in text:
        return text.replace(proxy, redact_proxy(proxy))
    return text
