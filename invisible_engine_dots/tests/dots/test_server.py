"""The Dot's API on its unix socket, spoken to by a real HTTP client."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import stat
import tempfile
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiohttp
import pytest
from fakes.dot_config import ALLOW_ALL, runtime_config_body
from fakes.engine_harness import EngineHarness, user_message
from fakes.fake_mcp_server import write_control
from fakes.scripted_provider import call, calls, says
from loguru import logger

from nanobot.dots import store as s
from nanobot.dots.checks import GuestChecks
from nanobot.dots.server import AgentServer

MakeEngine = Callable[..., EngineHarness]
TS = "2026-10-04T10:00:00.000Z"
BASE = "http://agent"


async def fixed_checks() -> GuestChecks:
    return GuestChecks(filesystem_writable=True, network_reachable=True, browser_installed=False)


@dataclass
class Answer:
    status: int
    body: bytes
    headers: Any

    @property
    def text(self) -> str:
        return self.body.decode("utf-8")

    @property
    def json(self) -> Any:
        return json.loads(self.text)


class Api:
    def __init__(self, h: EngineHarness, server: AgentServer, socket_path: Path) -> None:
        self.h = h
        self.server = server
        self.socket_path = socket_path
        self.session = aiohttp.ClientSession(connector=aiohttp.UnixConnector(path=str(socket_path)))

    async def call(self, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None) -> Answer:
        data = body if isinstance(body, (str, bytes)) or body is None else json.dumps(body)
        async with self.session.request(method, BASE + path, data=data, headers=headers) as response:
            return Answer(response.status, await response.read(), response.headers)

    async def read_stream(self, path: str, count: int, headers: dict[str, str] | None = None) -> list[dict[str, Any]]:
        """Read the event stream until `count` events arrived; every frame's id line must be its event's seq."""
        events: list[dict[str, Any]] = []
        async with self.session.get(BASE + path, headers=headers) as response:
            assert response.status == 200
            frame_id: str | None = None
            async for raw in response.content:
                line = raw.decode("utf-8").rstrip("\n")
                if line.startswith("id: "):
                    frame_id = line[4:]
                elif line.startswith("data: "):
                    event = json.loads(line[6:])
                    assert frame_id == str(event["seq"])
                    events.append(event)
                    if len(events) >= count:
                        break
        return events


@pytest.fixture
async def make_api(make_engine: MakeEngine) -> AsyncIterator[Callable[..., Any]]:
    cleanups: list[Callable[[], Any]] = []

    async def make(
        script: list[Any] | None = None,
        *,
        started: bool = True,
        key: bool = True,
        stop_grace_s: float = 0.05,
        browser: dict[str, Any] | None = None,
        **options: Any,
    ) -> Api:
        h = make_engine(script, key=key, stop_grace_s=stop_grace_s, browser=browser)
        if started:
            h.engine.start()
        # A short directory: a unix socket path has a small limit that pytest's tmp_path can exceed.
        directory = Path(tempfile.mkdtemp(prefix="dots-sock-"))
        socket_path = directory / "agent.sock"
        server = AgentServer(engine=h.engine, key_holder=h.keys, checks=fixed_checks, **options)
        await server.listen(socket_path)
        api = Api(h, server, socket_path)

        async def cleanup() -> None:
            await api.session.close()
            await server.close()
            shutil.rmtree(directory, ignore_errors=True)

        cleanups.append(cleanup)
        return api

    yield make
    for cleanup in reversed(cleanups):
        await cleanup()


class TestTheSocket:
    async def test_is_bound_for_its_group_and_removes_a_file_a_crash_left(
        self, make_engine: MakeEngine
    ) -> None:
        h = make_engine()
        directory = Path(tempfile.mkdtemp(prefix="dots-sock-"))
        socket_path = directory / "agent.sock"
        socket_path.write_bytes(b"left by a crash")
        server = AgentServer(engine=h.engine, key_holder=h.keys, checks=fixed_checks)
        try:
            await server.listen(socket_path)
            mode = stat.S_IMODE(os.stat(socket_path).st_mode)
            assert stat.S_ISSOCK(os.stat(socket_path).st_mode)
            assert mode == 0o660
        finally:
            await server.close()
            shutil.rmtree(directory, ignore_errors=True)
        assert not socket_path.exists()


class TestHealth:
    async def test_reports_the_state_the_key_and_the_checks(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api(key=False)

        answer = await api.call("GET", "/health")

        assert answer.status == 200
        assert answer.json == {
            "status": "ok",
            "state": "IDLE",
            "openrouter_configured": False,
            "browser": {"identities": 0, "open": 0},
            "checks": {"filesystem_writable": True, "network_reachable": True, "browser_installed": False},
        }
        assert answer.headers["Content-Type"] == "application/json; charset=utf-8"

    async def test_the_json_has_no_spaces_as_the_host_writes_it(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        health = await api.call("GET", "/health")
        assert health.text == json.dumps(health.json, separators=(",", ":"))
        assert '"status":"ok"' in health.text
        async with api.session.get(BASE + "/events/stream?after=0") as response:
            await response.content.readline()
            data = (await response.content.readline()).decode("utf-8")
        assert data.startswith('data: {"seq":1,')
        assert '"type":"agent.started"' in data

    async def test_says_starting_until_the_engine_has_started(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api(started=False)

        assert (await api.call("GET", "/health")).json["status"] == "starting"
        api.h.engine.start()
        assert (await api.call("GET", "/health")).json["status"] == "ok"

    async def test_a_trailing_slash_is_the_same_route(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        assert (await api.call("GET", "/health/")).status == 200

    async def test_only_get(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        answer = await api.call("POST", "/health")

        assert answer.status == 405
        assert answer.json == {"error": "method_not_allowed", "message": "POST is not allowed here; use GET"}


class TestSecrets:
    async def test_takes_the_key_into_memory_without_echoing_or_logging_it(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api(key=False)
        lines: list[str] = []
        sink = logger.add(lines.append, format="{message}", level="DEBUG")
        try:
            refused = await api.call("POST", "/secrets", {"openrouter_api_key": "  "})
            not_json = await api.call("POST", "/secrets", "{not json sk-or-secret")
            empty = await api.call("POST", "/secrets", "")
            wrong_type = await api.call("POST", "/secrets", {"openrouter_api_key": 5})
            accepted = await api.call("POST", "/secrets", {"openrouter_api_key": "sk-or-1"})
            again = await api.call("POST", "/secrets", {"openrouter_api_key": "sk-or-1"})
            replaced = await api.call("POST", "/secrets", {"openrouter_api_key": "sk-or-2"})
        finally:
            logger.remove(sink)

        assert (refused.status, refused.json["error"]) == (400, "invalid_secret")
        assert (wrong_type.status, wrong_type.json["error"]) == (400, "invalid_secret")
        assert (not_json.status, not_json.json["error"]) == (400, "invalid_json")
        assert "sk-or-secret" not in not_json.text
        assert (empty.status, empty.json["error"]) == (400, "invalid_json")
        assert (accepted.status, accepted.text) == (204, "")
        assert (again.status, replaced.status) == (204, 204)
        assert api.h.keys.require() == "sk-or-2"
        assert (await api.call("GET", "/health")).json["openrouter_configured"] is True
        logged = "".join(lines)
        assert "OpenRouter key received" in logged
        assert "OpenRouter key unchanged" in logged
        assert "OpenRouter key replaced" in logged
        assert "sk-or" not in logged

    async def test_a_key_that_cannot_travel_in_a_header_is_refused_and_never_echoed_or_logged(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api(key=False)
        lines: list[str] = []
        sink = logger.add(lines.append, format="{message}", level="DEBUG", backtrace=True, diagnose=False)
        try:
            # A newline inside the key survives the host's trim; httpx would refuse the request it is in.
            refused = await api.call("POST", "/secrets", {"openrouter_api_key": "sk-or-v1-SECRETHEAD\nSECRETTAIL"})
        finally:
            logger.remove(sink)

        assert (refused.status, refused.json["error"]) == (400, "invalid_secret")
        assert "SECRET" not in refused.text
        assert "SECRET" not in "".join(lines)
        assert (await api.call("GET", "/health")).json["openrouter_configured"] is False

    async def test_the_key_ends_a_prepare_sleep(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        await api.call("PUT", "/config", runtime_config_body(permissions={}))
        assert (await api.call("POST", "/prepare-sleep")).status == 204
        assert api.h.engine.is_suspending()

        await api.call("POST", "/secrets", {"openrouter_api_key": "sk-or-1"})

        assert not api.h.engine.is_suspending()


class TestConfig:
    async def test_validates_and_stores_the_config(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        assert (await api.call("PUT", "/config", runtime_config_body())).status == 204
        bad = await api.call("PUT", "/config", runtime_config_body(goal=""))
        post = await api.call("POST", "/config", runtime_config_body())

        assert (bad.status, bad.json["error"]) == (400, "invalid_config")
        assert "goal" in bad.json["message"]
        assert post.status == 405
        assert post.json["message"] == "POST is not allowed here; use PUT"
        assert api.h.engine.config is not None and api.h.engine.config.goal == "Watch fares."


class TestEvents:
    async def test_accepts_inbound_events_a_repeated_id_too_and_refuses_malformed_ones(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api(key=False)
        event = {"id": "m1", "type": "user.message", "ts": TS, "data": {"text": "hi"}}

        first = await api.call("POST", "/events", event)
        again = await api.call("POST", "/events", event)
        bad = await api.call("POST", "/events", {**event, "type": "user.shout"})

        assert (first.status, first.json) == (202, {"accepted": True})
        assert again.status == 202
        assert (bad.status, bad.json["error"]) == (400, "invalid_event")
        assert "user.shout" not in bad.text
        assert api.h.count("dots_inbound") == 1

    async def test_refuses_a_body_over_the_limit_without_reading_on(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api(max_body_bytes=64)

        answer = await api.call("POST", "/events", "x" * 1000)

        assert (answer.status, answer.json["error"]) == (413, "payload_too_large")
        assert answer.json["message"] == "the body is larger than 64 bytes"

    async def test_says_the_agent_is_shutting_down_once_it_is(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        await api.h.engine.stop()

        answer = await api.call("POST", "/events", {"id": "m1", "type": "user.message", "ts": TS, "data": {"text": "x"}})

        assert (answer.status, answer.json["error"]) == (503, "shutting_down")

    async def test_a_message_through_the_api_is_answered_in_the_stream(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api([says("hello yourself")])
        await api.call("PUT", "/config", runtime_config_body(permissions={}))

        await api.call("POST", "/events", {"id": "m1", "type": "user.message", "ts": TS, "data": {"text": "hello"}})
        events = await api.read_stream("/events/stream?after=0", 6)

        assert [e["type"] for e in events] == [
            "agent.started",
            "agent.state",
            "agent.state",
            "message.assistant",
            "agent.state",
            "agent.state",
        ]
        assert [e["data"].get("state") for e in events if e["type"] == "agent.state"] == [
            "IDLE",
            "THINKING",
            "DONE",
            "IDLE",
        ]
        assert events[3]["data"] == {"text": "hello yourself", "in_reply_to": "m1", "spent_usd": 0.0}


class TestTheStream:
    async def test_replays_from_after_a_seq_then_sends_what_is_appended_later_each_once_and_in_order(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()
        # agent.started (1) and agent.state IDLE (2) are there already.
        api.h.store.write(lambda c: s.append_outbox(c, "message.assistant", {"text": "three"}))
        reader = asyncio.create_task(api.read_stream("/events/stream?after=1", 4))
        await asyncio.sleep(0.05)

        api.h.store.write(lambda c: s.append_outbox(c, "message.assistant", {"text": "four"}))
        api.h.store.write(lambda c: s.append_outbox(c, "message.assistant", {"text": "five"}))
        events = await asyncio.wait_for(reader, 10)

        assert [e["seq"] for e in events] == [2, 3, 4, 5]
        assert len({e["id"] for e in events}) == 4

    async def test_resumes_from_the_last_event_id_header(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        events = await api.read_stream("/events/stream", 1, headers={"Last-Event-ID": "1"})

        assert [e["seq"] for e in events] == [2]

    async def test_after_must_be_a_non_negative_integer(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        for bad in ("-1", "x", "1.5", ""):
            answer = await api.call("GET", f"/events/stream?after={bad}")
            assert (answer.status, answer.json["error"]) == (400, "invalid_after")

    async def test_the_headers_of_an_event_stream(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        async with api.session.get(BASE + "/events/stream?after=0") as response:
            assert response.headers["Content-Type"] == "text/event-stream; charset=utf-8"
            assert response.headers["Cache-Control"] == "no-cache"
            assert response.headers["X-Accel-Buffering"] == "no"

    async def test_sends_a_comment_now_and_then_so_an_idle_proxy_keeps_the_stream(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api(heartbeat_s=0.05)
        last = api.h.engine.read_outbox_after(0, 100)[-1]["seq"]

        async with api.session.get(BASE + f"/events/stream?after={last}") as response:
            async with asyncio.timeout(10):
                async for raw in response.content:
                    if raw == b": keep-alive\n":
                        break

    async def test_closing_the_streams_ends_them_so_the_server_can_stop(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        last = api.h.engine.read_outbox_after(0, 100)[-1]["seq"]

        async with api.session.get(BASE + f"/events/stream?after={last}") as response:
            reader = asyncio.create_task(response.content.read())
            await asyncio.sleep(0.05)
            assert not reader.done()
            api.server.close_streams()
            assert await asyncio.wait_for(reader, 10) == b""

    async def test_after_it_stops_accepting_no_connection_is_taken_and_the_open_stream_goes_on(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()
        last = api.h.engine.read_outbox_after(0, 100)[-1]["seq"]

        async with api.session.get(BASE + f"/events/stream?after={last}") as response:
            reader = asyncio.create_task(response.content.readline())
            await asyncio.sleep(0.05)

            await api.server.stop_accepting()

            async with aiohttp.ClientSession(connector=aiohttp.UnixConnector(path=str(api.socket_path))) as late:
                with pytest.raises(aiohttp.ClientConnectorError):
                    await late.get(BASE + "/health")
            api.h.store.write(lambda c: s.append_outbox(c, "message.assistant", {"text": "still sent"}))
            assert (await asyncio.wait_for(reader, 10)).startswith(b"id: ")
            api.server.close_streams()

    async def test_a_read_that_fails_after_the_headers_ends_the_stream_without_a_second_response(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()
        listeners = len(api.h.store._listeners)
        real_read = api.h.engine.read_outbox_after
        reads = 0

        def read(after: int, limit: int) -> list[dict[str, Any]]:
            nonlocal reads
            reads += 1
            if reads > 1:
                raise RuntimeError("the database is gone")
            return real_read(after, limit)

        api.h.engine.read_outbox_after = read  # type: ignore[method-assign]
        messages: list[str] = []
        sink = logger.add(messages.append, level="WARNING", format="{message}")
        try:
            async with api.session.get(BASE + "/events/stream?after=0") as response:
                assert response.status == 200
                body = await asyncio.wait_for(response.text(), 10)
        finally:
            logger.remove(sink)

        # The events read before the failure arrived, and nothing else: no error body after them.
        assert body.startswith("id: 1\ndata: ") and body.endswith("\n\n")
        assert "internal" not in body and "the database is gone" not in body
        assert any("event stream read failed" in message for message in messages)
        assert len(api.h.store._listeners) == listeners

    async def test_a_client_that_goes_away_leaves_no_listener_behind(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        before = len(api.h.store._listeners)

        async with api.session.get(BASE + "/events/stream?after=0") as response:
            await response.content.readline()
            assert len(api.h.store._listeners) == before + 1

        for _ in range(100):
            if len(api.h.store._listeners) == before:
                break
            await asyncio.sleep(0.02)
        assert len(api.h.store._listeners) == before


class TestBrowserIdentities:
    async def test_makes_lists_gets_and_deletes_an_identity_the_way_the_host_reads_it(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()

        created = await api.call("POST", "/browser-identities", {"name": "Shopping Account"})

        assert created.status == 201
        identity = created.json
        assert identity["id"].startswith("shopping-account-") and len(identity["id"]) == len("shopping-account-") + 6
        assert identity["name"] == "Shopping Account"
        assert identity["status"] == "available"
        assert identity["lastUsedAt"] is None
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", identity["createdAt"])
        assert identity["profilePath"].endswith(f"/{identity['id']}/profile")
        assert "proxy" not in identity
        assert (await api.call("GET", "/browser-identities")).json == {"identities": [identity]}
        assert (await api.call("GET", f"/browser-identities/{identity['id']}")).json == identity
        assert (await api.call("DELETE", f"/browser-identities/{identity['id']}")).status == 204
        assert (await api.call("GET", f"/browser-identities/{identity['id']}")).status == 404
        assert api.h.types()[-2:] == ["browser.identity.created", "browser.identity.deleted"]

    async def test_a_second_delete_is_not_found_and_leaves_no_event(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        identity = (await api.call("POST", "/browser-identities", {"name": "once"})).json
        await api.call("DELETE", f"/browser-identities/{identity['id']}")

        again = await api.call("DELETE", f"/browser-identities/{identity['id']}")

        assert (again.status, again.json["error"]) == (404, "not_found")
        assert api.h.types().count("browser.identity.deleted") == 1

    async def test_refuses_what_the_rules_refuse_with_the_status_the_host_expects(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()
        api.h.configure(runtime_config_body(browser={"identities": {"managed_by_dot": True, "max_identities": 1, "max_open": 1}}))
        api.h.engine.apply_browser_limits()

        for body, message in (
            ({"name": 5}, "name must be a string"),
            ({}, "name must be a string"),
            (["name"], "name must be a string"),
            ({"name": "x", "proxy": 5}, "proxy must be a string"),
        ):
            answer = await api.call("POST", "/browser-identities", body)
            assert (answer.status, answer.json) == (400, {"error": "invalid", "message": message}), body
        blank = await api.call("POST", "/browser-identities", {"name": "   "})
        assert (blank.status, blank.json["error"]) == (400, "invalid")
        bad_proxy = await api.call("POST", "/browser-identities", {"name": "a", "proxy": "ftp://host"})
        assert (bad_proxy.status, bad_proxy.json["error"]) == (400, "invalid")
        assert (await api.call("POST", "/browser-identities", "{not json")).json["error"] == "invalid_json"
        assert (await api.call("POST", "/browser-identities", {"name": "one"})).status == 201
        over = await api.call("POST", "/browser-identities", {"name": "two"})
        assert (over.status, over.json["error"]) == (409, "limit")
        assert "max_identities 1" in over.json["message"]
        assert api.h.types().count("browser.identity.created") == 1

    async def test_the_proxy_password_is_in_no_answer_event_or_log(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        lines: list[str] = []
        sink = logger.add(lines.append, format="{message}", level="DEBUG")
        try:
            created = await api.call("POST", "/browser-identities", {"name": "p", "proxy": "http://user:hunter2@proxy.test:8080"})
            listed = await api.call("GET", "/browser-identities")
            fetched = await api.call("GET", f"/browser-identities/{created.json['id']}")
        finally:
            logger.remove(sink)

        assert created.json["proxy"] == "http://user:***@proxy.test:8080"
        assert listed.json["identities"][0]["proxy"] == fetched.json["proxy"] == created.json["proxy"]
        everything = created.text + listed.text + fetched.text + json.dumps(api.h.events()) + "\n".join(lines)
        assert "hunter2" not in everything

    async def test_the_health_counts_the_identities_and_the_open_ones(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        first = (await api.call("POST", "/browser-identities", {"name": "first"})).json
        await api.call("POST", "/browser-identities", {"name": "second"})
        assert (await api.call("GET", "/health")).json["browser"] == {"identities": 2, "open": 0}

        await api.h.browser.launch(first["id"])

        assert (await api.call("GET", "/health")).json["browser"] == {"identities": 2, "open": 1}
        assert (await api.call("GET", f"/browser-identities/{first['id']}")).json["status"] == "open"
        await api.h.browser.close_all()
        assert (await api.call("GET", "/health")).json["browser"] == {"identities": 2, "open": 0}

    async def test_a_config_with_a_lower_max_open_closes_the_excess_open_browsers(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()
        one = (await api.call("POST", "/browser-identities", {"name": "one"})).json
        two = (await api.call("POST", "/browser-identities", {"name": "two"})).json
        await api.h.browser.launch(one["id"])
        await api.h.browser.launch(two["id"])
        assert api.h.browser.open_count == 2

        put = await api.call(
            "PUT",
            "/config",
            runtime_config_body(browser={"identities": {"managed_by_dot": True, "max_identities": 20, "max_open": 1}}),
        )

        assert put.status == 204
        assert api.h.browser.limits == (1, 20)
        # The least recently used is the one closed; the other stays open. The close runs after the answer.
        assert [i["status"] for i in (await api.call("GET", "/browser-identities")).json["identities"]] == ["available", "open"]
        async with asyncio.timeout(10):
            while api.h.types().count("browser.identity.closed") < 1:
                await asyncio.sleep(0.02)
        assert api.h.types().count("browser.identity.closed") == 1

    async def test_a_config_a_close_a_delete_and_a_create_do_not_wait_for_a_launch_in_flight(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api(browser={"open_retry_initial_s": 0.05, "open_retry_max_s": 0.05})
        slow = (await api.call("POST", "/browser-identities", {"name": "slow"})).json
        other = (await api.call("POST", "/browser-identities", {"name": "other"})).json
        await api.h.browser.launch(other["id"])
        write_control(api.h.tmp_path / "browsers" / slow["id"] / "mcp", download_answers=100_000)
        launching = asyncio.create_task(api.h.browser.launch(slow["id"]))
        await asyncio.sleep(0.3)

        # The host gives a guest 30 s; a launch can take 15 minutes. None of these may wait for it.
        async with asyncio.timeout(10):
            put = await api.call(
                "PUT",
                "/config",
                runtime_config_body(browser={"identities": {"managed_by_dot": True, "max_identities": 20, "max_open": 1}}),
            )
            closed = await api.call("POST", f"/browser-identities/{other['id']}/close")
            created = await api.call("POST", "/browser-identities", {"name": "fresh"})
            deleted = await api.call("DELETE", f"/browser-identities/{created.json['id']}")

        assert (put.status, closed.status, created.status, deleted.status) == (204, 204, 201, 204)
        assert not launching.done()
        launching.cancel()
        with pytest.raises(asyncio.CancelledError):
            await launching

    async def test_preparing_to_sleep_closes_the_open_browsers(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        identity = (await api.call("POST", "/browser-identities", {"name": "open one"})).json
        await api.h.browser.launch(identity["id"])
        assert api.h.browser.open_count == 1

        assert (await api.call("POST", "/prepare-sleep")).status == 204

        assert api.h.browser.open_count == 0
        assert api.h.types().count("browser.identity.closed") == 1
        # The profile is kept: the identity is still there, closed.
        assert (await api.call("GET", f"/browser-identities/{identity['id']}")).json["status"] == "available"


class TestBrowserIdentityActions:
    async def test_a_frame_is_the_jpeg_of_an_open_identity_and_changes_nothing(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        identity = (await api.call("POST", "/browser-identities", {"name": "live"})).json
        await api.h.browser.launch(identity["id"])
        events = len(api.h.events())

        frame = await api.call("GET", f"/browser-identities/{identity['id']}/frame")

        assert frame.status == 200
        assert frame.headers["Content-Type"] == "image/jpeg"
        assert frame.headers["Cache-Control"] == "no-store"
        assert frame.body.startswith(b"\xff\xd8\xff") and frame.body.endswith(b"\xff\xd9")
        assert len(api.h.events()) == events
        assert (await api.call("GET", f"/browser-identities/{identity['id']}")).json["status"] == "open"

    async def test_a_frame_of_a_closed_identity_is_409_not_open_and_of_an_unknown_one_404(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()
        identity = (await api.call("POST", "/browser-identities", {"name": "shut"})).json

        closed = await api.call("GET", f"/browser-identities/{identity['id']}/frame")
        unknown = await api.call("GET", "/browser-identities/nobody-abc123/frame")

        assert (closed.status, closed.json["error"]) == (409, "not_open")
        assert closed.json["message"] == f"identity {identity['id']} is not open; call browser_identity_launch first"
        assert (unknown.status, unknown.json["error"]) == (404, "not_found")
        assert api.h.browser.open_count == 0

    async def test_a_frame_that_finds_the_identity_busy_is_503_busy_after_the_wait(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api(browser={"frame_wait_s": 0.05})
        identity = (await api.call("POST", "/browser-identities", {"name": "busy"})).json
        await api.h.browser.launch(identity["id"])

        call = asyncio.create_task(api.h.browser.call_tool(identity["id"], "browser_navigate", {"url": "slow://x"}))
        await asyncio.sleep(0.1)
        busy = await api.call("GET", f"/browser-identities/{identity['id']}/frame")
        await call

        assert (busy.status, busy.json["error"]) == (503, "busy")
        assert (await api.call("GET", f"/browser-identities/{identity['id']}/frame")).status == 200

    async def test_a_frame_the_server_cannot_give_is_502_frame_failed(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        identity = (await api.call("POST", "/browser-identities", {"name": "blank"})).json
        write_control(api.h.tmp_path / "browsers" / identity["id"] / "mcp", fail_watch=True)
        await api.h.browser.launch(identity["id"])

        failed = await api.call("GET", f"/browser-identities/{identity['id']}/frame")

        assert (failed.status, failed.json["error"]) == (502, "frame_failed")
        assert "no page to watch" in failed.json["message"]

    async def test_close_ends_the_browser_keeps_the_profile_and_is_idempotent(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        identity = (await api.call("POST", "/browser-identities", {"name": "closing"})).json
        await api.h.browser.launch(identity["id"])

        closed = await api.call("POST", f"/browser-identities/{identity['id']}/close")
        again = await api.call("POST", f"/browser-identities/{identity['id']}/close")

        assert (closed.status, again.status) == (204, 204)
        assert (await api.call("GET", f"/browser-identities/{identity['id']}")).json["status"] == "available"
        assert (api.h.tmp_path / "browsers" / identity["id"] / "profile").is_dir()
        assert api.h.types().count("browser.identity.closed") == 1
        assert (await api.call("POST", "/browser-identities/nobody-abc123/close")).status == 404

    async def test_an_action_names_the_one_method_it_takes_and_nothing_else_is_a_route(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()
        identity = (await api.call("POST", "/browser-identities", {"name": "routes"})).json
        base = f"/browser-identities/{identity['id']}"

        post = await api.call("POST", f"{base}/frame")
        get = await api.call("GET", f"{base}/close")

        assert (post.status, post.json["message"]) == (405, "POST is not allowed here; use GET")
        assert (get.status, get.json["message"]) == (405, "GET is not allowed here; use POST")
        for path in (f"{base}/launch", f"{base}/frame/x", "/browser-identities/a%2Fb/frame"):
            assert (await api.call("GET", path)).status == 404, path

    async def test_a_trailing_slash_on_an_action_is_the_same_route(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()
        identity = (await api.call("POST", "/browser-identities", {"name": "slash"})).json

        assert (await api.call("POST", f"/browser-identities/{identity['id']}/close/")).status == 204


class TestStateAndTheRest:
    async def test_answers_the_state(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        assert (await api.call("GET", "/state")).json == {
            "state": "IDLE",
            "current_task_id": None,
            "pending_approval": None,
        }

    async def test_the_identity_routes_name_what_they_cannot_find_and_the_methods_they_refuse(
        self, make_api: Callable[..., Any]
    ) -> None:
        api: Api = await make_api()

        assert (await api.call("GET", "/browser-identities")).json == {"identities": []}
        missing = await api.call("GET", "/browser-identities/with%20space")
        assert (missing.status, missing.json) == (
            404,
            {"error": "not_found", "message": 'no browser identity "with space"'},
        )
        # Decoded once: the percent sign of "a%2541" is the id's own.
        twice = await api.call("GET", "/browser-identities/a%2541")
        assert twice.json["message"] == 'no browser identity "a%41"'
        assert (await api.call("DELETE", "/browser-identities/x")).status == 404
        assert (await api.call("GET", "/browser-identities/a%2Fb")).status == 404
        put = await api.call("PUT", "/browser-identities")
        assert (put.status, put.json["message"]) == (405, "PUT is not allowed here; use GET or POST")
        post = await api.call("POST", "/browser-identities/x")
        assert (post.status, post.json["message"]) == (405, "POST is not allowed here; use GET or DELETE")

    async def test_prepares_to_sleep_and_answers_404_for_anything_else(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        assert (await api.call("POST", "/prepare-sleep")).status == 204
        missing = await api.call("GET", "/nope")
        assert (missing.status, missing.json) == (404, {"error": "not_found", "message": "no route GET /nope"})
        assert (await api.call("GET", "/prepare-sleep")).status == 405

    async def test_the_sleep_goes_on_when_the_host_hangs_up(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api(
            [calls(call("c1", "exec", command="sleep 0.3")), says("after the sleep")], stop_grace_s=20.0
        )
        api.h.configure(runtime_config_body(permissions=ALLOW_ALL))
        flushed = asyncio.Event()
        real_checkpoint = api.h.store.checkpoint

        def checkpoint() -> None:
            real_checkpoint()
            flushed.set()

        api.h.store.checkpoint = checkpoint  # type: ignore[method-assign]
        api.h.engine.accept(user_message("m1"))
        await api.h.wait_until(lambda: "EXECUTING" in api.h.states())
        request = asyncio.create_task(api.call("POST", "/prepare-sleep"))
        await asyncio.sleep(0.05)
        request.cancel()

        # The sleep ran to its end: the tool finished within the grace and the database was flushed.
        await asyncio.wait_for(flushed.wait(), 10)
        (called,) = api.h.events_of("tool.called")
        assert (called["ok"], "interrupted" in called) == (True, False)

    async def test_an_unexpected_error_is_a_500_that_names_it(self, make_api: Callable[..., Any]) -> None:
        api: Api = await make_api()

        def boom() -> Any:
            raise RuntimeError("the database is gone")

        api.h.engine.state_answer = boom  # type: ignore[method-assign]
        answer = await api.call("GET", "/state")

        assert (answer.status, answer.json) == (500, {"error": "internal", "message": "the database is gone"})
