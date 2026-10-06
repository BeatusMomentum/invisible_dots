"""The Dot's API (invisible_dots architecture section 5.3), served on its unix socket.

The host reaches it as `/v1/agent/...` through dot-agentd, which checked the
Dot's token already. The socket's directory admits only the engine's user and
dot-agentd's, so this server does no authentication of its own.

The server logs a request's method, path and status, never a body: the body of
`POST /secrets` is the OpenRouter key.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import unquote

from aiohttp import web
from loguru import logger

from nanobot.cron.service import CronService
from nanobot.dots.automations import automation_json
from nanobot.dots.checks import GuestCheckRunner
from nanobot.dots.engine import Engine, EngineStopped
from nanobot.dots.protocol import AGENT_ROUTES, DotsConfigError, InvalidEvent, parse_inbound_event
from nanobot.dots.secrets import KeyHolder

MAX_BODY_BYTES = 1024 * 1024
HEARTBEAT_S = 15.0
SOCKET_MODE = 0o660
# Events sent per read of the outbox while a stream catches up.
_STREAM_BATCH = 500


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _error_body(code: str, message: str) -> dict[str, str]:
    return {"error": code, "message": message}


def _allow(method: str, *allowed: str) -> None:
    if method not in allowed:
        raise HttpError(405, "method_not_allowed", f"{method} is not allowed here; use {' or '.join(allowed)}")


def _not_implemented_browser() -> HttpError:
    return HttpError(
        501,
        "not_implemented",
        "browser identities are not available in this version of the Dot's runtime",
    )


async def _read_json(request: web.Request, max_bytes: int) -> object:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.content.iter_chunked(64 * 1024):
        size += len(chunk)
        if size > max_bytes:
            raise HttpError(413, "payload_too_large", f"the body is larger than {max_bytes} bytes")
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw.strip():
        raise HttpError(400, "invalid_json", "the body is empty; expected JSON")
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        # Not the parser's message: it can quote the body, and the body of /secrets is a key.
        raise HttpError(400, "invalid_json", "the body is not valid JSON") from None


def _compact(value: object) -> str:
    """JSON with no spaces, as the host's JSON.stringify writes it: what every reader of the API sees."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _json_response(status: int, body: object) -> web.Response:
    return web.Response(
        status=status, text=_compact(body), content_type="application/json", charset="utf-8"
    )


class _Stream:
    """One open event stream: the wake-up it waits on and the end the server can ask for."""

    def __init__(self) -> None:
        self.wake = asyncio.Event()
        self.closing = False

    def close(self) -> None:
        self.closing = True
        self.wake.set()


class AgentServer:
    def __init__(
        self,
        *,
        engine: Engine,
        key_holder: KeyHolder,
        checks: GuestCheckRunner,
        automations: CronService,
        max_body_bytes: int = MAX_BODY_BYTES,
        heartbeat_s: float = HEARTBEAT_S,
    ) -> None:
        self._engine = engine
        self._key_holder = key_holder
        self._checks = checks
        self._automations = automations
        self._max_body = max_body_bytes
        self._heartbeat_s = heartbeat_s
        self._streams: set[_Stream] = set()
        self._runner: web.AppRunner | None = None
        self._socket_path: Path | None = None
        self._app = web.Application(middlewares=[self._errors])
        self._app.router.add_route("*", "/{tail:.*}", self._handle)

    # --- the socket ---------------------------------------------------------

    async def listen(self, socket_path: str | Path) -> None:
        """Bind the socket (a file left by a crash is removed first) and serve."""
        path = Path(socket_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        runner = web.AppRunner(self._app, access_log=None, handler_cancellation=True)
        await runner.setup()
        await web.UnixSite(runner, str(path)).start()
        # The directory decides who may connect: the engine's user and dot-agentd's.
        os.chmod(path, SOCKET_MODE)
        self._runner = runner
        self._socket_path = path
        logger.info("Dot API listening socket={}", path)

    async def stop_accepting(self) -> None:
        """Stop listening: no new connection is taken. Requests and streams already open go on."""
        if self._runner is not None:
            for site in list(self._runner.sites):
                await site.stop()

    def close_streams(self) -> None:
        """End every open event stream, so `close` can finish."""
        for stream in list(self._streams):
            stream.close()

    async def close(self) -> None:
        self.close_streams()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._socket_path is not None:
            self._socket_path.unlink(missing_ok=True)
            self._socket_path = None
        logger.info("Dot API stopped")

    # --- requests -----------------------------------------------------------

    @web.middleware
    async def _errors(
        self, request: web.Request, handler: Callable[[web.Request], Awaitable[web.StreamResponse]]
    ) -> web.StreamResponse:
        try:
            response = await handler(request)
        except HttpError as error:
            response = _json_response(error.status, _error_body(error.code, error.message))
        except web.HTTPException:
            raise
        except Exception as error:
            logger.opt(exception=True).error("request failed method={} path={}", request.method, request.path)
            response = _json_response(500, _error_body("internal", str(error)))
        if request.path != AGENT_ROUTES["events_stream"]:
            logger.debug("request method={} path={} status={}", request.method, request.path, response.status)
        return response

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        # The path as sent: a route is matched on it and an identity id is decoded from it, once.
        path = re.sub(r"/+$", "", request.rel_url.raw_path) or "/"
        method = request.method
        engine = self._engine

        if path == AGENT_ROUTES["health"]:
            _allow(method, "GET")
            checks = await self._checks()
            return _json_response(
                200,
                {
                    "status": "ok" if engine.started else "starting",
                    "state": engine.state,
                    "openrouter_configured": self._key_holder.configured,
                    "browser": {"identities": 0, "open": 0},
                    "checks": checks.to_json(),
                },
            )

        if path == AGENT_ROUTES["secrets"]:
            _allow(method, "POST")
            body = await _read_json(request, self._max_body)
            key = body.get("openrouter_api_key") if isinstance(body, dict) else None
            if not isinstance(key, str):
                raise HttpError(400, "invalid_secret", "openrouter_api_key must be a non-empty string")
            try:
                change = self._key_holder.set(key)
            except ValueError as error:
                # The holder's reasons never name the key; `from None` keeps the chain out of any log too.
                raise HttpError(400, "invalid_secret", f"openrouter_api_key: {error}") from None
            # Never the value, not even a prefix of it.
            logger.info("OpenRouter key {}", change)
            engine.key_received()
            return web.Response(status=204)

        if path == AGENT_ROUTES["config"]:
            _allow(method, "PUT")
            body = await _read_json(request, self._max_body)
            try:
                engine.set_config(body)
            except DotsConfigError as error:
                raise HttpError(400, "invalid_config", str(error)) from None
            return web.Response(status=204)

        if path == AGENT_ROUTES["events"]:
            _allow(method, "POST")
            body = await _read_json(request, self._max_body)
            try:
                event = parse_inbound_event(body)
            except InvalidEvent as error:
                raise HttpError(400, "invalid_event", str(error)) from None
            try:
                engine.accept(event)
            except EngineStopped as error:
                raise HttpError(503, "shutting_down", str(error)) from None
            return _json_response(202, {"accepted": True})

        if path == AGENT_ROUTES["events_stream"]:
            _allow(method, "GET")
            return await self._stream(request)

        if path == AGENT_ROUTES["state"]:
            _allow(method, "GET")
            answer = engine.state_answer()
            return _json_response(
                200,
                {
                    "state": answer.state,
                    "current_task_id": answer.current_task_id,
                    "pending_approval": answer.pending_approval,
                },
            )

        browser = AGENT_ROUTES["browser_identities"]
        if path == browser:
            # The engine has no browser yet: none exists, and none can be made.
            if method == "GET":
                return _json_response(200, {"identities": []})
            _allow(method, "GET", "POST")
            raise _not_implemented_browser()

        if path.startswith(f"{browser}/"):
            if method == "GET":
                identity = unquote(path[len(browser) + 1 :])
                raise HttpError(404, "not_found", f'no browser identity "{identity}"')
            _allow(method, "GET", "DELETE")
            raise _not_implemented_browser()

        automations = AGENT_ROUTES["automations"]
        if path == automations:
            _allow(method, "GET")
            jobs = self._automations.list_jobs(include_disabled=True)
            return _json_response(200, {"automations": [automation_json(job) for job in jobs]})

        if path.startswith(f"{automations}/"):
            _allow(method, "PATCH", "DELETE")
            return await self._automation(request, unquote(path[len(automations) + 1 :]))

        if path == AGENT_ROUTES["tools"]:
            _allow(method, "GET")
            return _json_response(200, {"tools": engine.tool_table()})

        if path == AGENT_ROUTES["prepare_sleep"]:
            _allow(method, "POST")
            logger.info("preparing to sleep")
            await engine.suspend()
            logger.info("ready to sleep: work paused, state flushed")
            return web.Response(status=204)

        raise HttpError(404, "not_found", f"no route {method} {path}")

    async def _automation(self, request: web.Request, job_id: str) -> web.StreamResponse:
        """`PATCH /automations/:id {"enabled": bool}` pauses or resumes one; `DELETE` removes it."""
        cron = self._automations
        if request.method == "DELETE":
            outcome = cron.remove_job(job_id)
            if outcome == "not_found":
                raise HttpError(404, "not_found", f'no automation "{job_id}"')
            if outcome == "protected":
                raise HttpError(409, "protected", f'automation "{job_id}" is a system job and cannot be removed')
            logger.info("automation removed id={}", job_id)
            return web.Response(status=204)
        body = await _read_json(request, self._max_body)
        if not isinstance(body, dict) or set(body) != {"enabled"} or not isinstance(body["enabled"], bool):
            raise HttpError(400, "invalid_automation", 'the body must be {"enabled": true} or {"enabled": false}')
        job = cron.get_job(job_id)
        if job is None:
            raise HttpError(404, "not_found", f'no automation "{job_id}"')
        if job.enabled != body["enabled"]:
            # Enabling a job that is on already would move its next run a whole interval on.
            job = cron.enable_job(job_id, body["enabled"]) or job
            logger.info("automation {} id={}", "resumed" if job.enabled else "paused", job_id)
        return _json_response(200, automation_json(job))

    async def _stream(self, request: web.Request) -> web.StreamResponse:
        """Replay every event after `after`, then keep sending new ones.

        Events are read from the outbox only, in seq order, each at most once per stream. Every
        outbox row is written by this process, and the store wakes the stream after the commit.
        """
        raw = request.query.get("after")
        if raw is None:
            raw = request.headers.get("Last-Event-ID", "0")
        if not re.fullmatch(r"[0-9]+", raw):
            raise HttpError(400, "invalid_after", f'after must be a non-negative integer, got "{raw}"')
        last = int(raw)
        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)
        stream = _Stream()
        self._streams.add(stream)
        remove_listener = self._engine.on_append(stream.wake.set)
        logger.info("event stream opened after={}", last)
        try:
            while not stream.closing:
                # Clear before reading: a commit after the read sets the event again.
                stream.wake.clear()
                batch = self._engine.read_outbox_after(last, _STREAM_BATCH)
                if batch:
                    frames = [f"id: {event['seq']}\ndata: {_compact(event)}\n\n" for event in batch]
                    await response.write("".join(frames).encode("utf-8"))
                    last = batch[-1]["seq"]
                    continue
                try:
                    await asyncio.wait_for(stream.wake.wait(), self._heartbeat_s)
                except asyncio.TimeoutError:
                    await response.write(b": keep-alive\n\n")
        except ConnectionError:
            pass
        except Exception as error:
            # The headers are sent: there is no second response to give. The host reconnects with the
            # last id it saw.
            logger.warning("event stream read failed after={} error={!r}", last, error)
        finally:
            remove_listener()
            self._streams.discard(stream)
            logger.info("event stream closed last_sent={}", last)
        return response
