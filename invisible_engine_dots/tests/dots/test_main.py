"""The entry point: what it refuses, and the whole engine served on a socket."""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import shutil
import socket
import subprocess
import sys
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiohttp
import pytest
from aiohttp import web
from fakes.dot_config import runtime_config_body

import nanobot
from nanobot.dots import main as entry_point
from nanobot.dots.engine import Engine
from nanobot.dots.main import (
    DEFAULT_AGENT_SOCKET,
    DEFAULT_STATE_DIR,
    LOCK_FILE,
    LOCK_MISMATCH,
    REFUSAL,
    UPSTREAM_COMMIT,
    Environment,
    GoldenLockError,
    check_golden_lock,
    main,
    read_environment,
    serve,
)
from nanobot.dots.store import DotStore

ENGINE_ROOT = Path(__file__).resolve().parents[2]
TS = "2026-10-04T10:00:00.000Z"


def short_dir() -> Path:
    """A directory with a short path: a unix socket's path has a small limit."""
    return Path(tempfile.mkdtemp(prefix="dots-main-"))


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class TestTheCommandLine:
    def test_version_names_the_engine_and_the_commit_it_forked_from(self, capsys: pytest.CaptureFixture[str]) -> None:
        assert main(["--version"], {}) == 0

        out = capsys.readouterr().out
        assert out == f"invisible_dots engine {nanobot.__version__} (nanobot fork, f75470e7)\n"
        assert re.fullmatch(r"invisible_dots engine \d+\.\d+\.\d+ \(nanobot fork, [0-9a-f]{8}\)\n", out)

    def test_the_commit_it_names_is_the_one_upstream_md_records(self) -> None:
        recorded = re.search(r"commit ([0-9a-f]{40})", (ENGINE_ROOT / "UPSTREAM.md").read_text(encoding="utf-8"))
        assert recorded is not None
        assert recorded.group(1).startswith(UPSTREAM_COMMIT)

    @pytest.mark.parametrize("argv", [["status"], ["--version", "x"], ["gateway", "--port", "1"], ["--help"]])
    def test_any_other_argument_is_refused(self, argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
        assert main(argv, {}) == 2

        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == REFUSAL + "\n"
        assert "runs only" in captured.err

    def test_the_module_runs_as_python_dash_m_nanobot(self) -> None:
        version = subprocess.run(
            [sys.executable, "-I", "-B", "-m", "nanobot", "--version"],
            capture_output=True, text=True, cwd=ENGINE_ROOT, check=False,
        )
        refused = subprocess.run(
            [sys.executable, "-I", "-B", "-m", "nanobot", "status"],
            capture_output=True, text=True, cwd=ENGINE_ROOT, check=False,
        )

        assert (version.returncode, version.stdout.startswith("invisible_dots engine ")) == (0, True)
        assert (refused.returncode, "runs only" in refused.stderr) == (2, True)


class TestTheEnvironment:
    def test_every_name_has_a_default(self) -> None:
        env = read_environment({})

        assert env.agent_socket == DEFAULT_AGENT_SOCKET == "/run/invisible-dots-agent/agent.sock"
        assert env.agentd_socket == "/run/invisible-dots/agentd.sock"
        assert env.agentd_bin == "/opt/invisible-dots/bin/dot-agentd"
        assert env.workspace == "/home/dot/workspace"
        assert env.state_dir == DEFAULT_STATE_DIR == "/home/dotengine/state"
        assert env.openrouter_url is None
        assert env.network_check == "openrouter.ai:443"
        assert env.mcp_command == "invisible-playwright-mcp"

    def test_the_names_the_unit_and_the_smoke_set(self) -> None:
        env = read_environment(
            {
                "INVISIBLE_DOTS_AGENT_SOCKET": "/s/agent.sock",
                "INVISIBLE_DOTS_AGENTD_SOCKET": "/s/agentd.sock",
                "INVISIBLE_DOTS_AGENTD_BIN": "/b/dot-agentd",
                "INVISIBLE_DOTS_WORKSPACE": "/w",
                "INVISIBLE_DOTS_ENGINE_STATE": "/state",
                "INVISIBLE_DOTS_OPENROUTER_URL": " http://127.0.0.1:9999/api/v1 ",
                "INVISIBLE_DOTS_NETWORK_CHECK": "127.0.0.1:9999",
                "INVISIBLE_DOTS_MCP_COMMAND": "/opt/mcp",
                "PATH": "/a:/b",
                "HOME": "/home/dotengine",
            }
        )

        assert env == Environment(
            agent_socket="/s/agent.sock",
            agentd_socket="/s/agentd.sock",
            agentd_bin="/b/dot-agentd",
            workspace="/w",
            state_dir="/state",
            openrouter_url="http://127.0.0.1:9999/api/v1",
            network_check="127.0.0.1:9999",
            mcp_command="/opt/mcp",
            path="/a:/b",
            home="/home/dotengine",
        )

    def test_a_blank_value_is_the_default(self) -> None:
        env = read_environment({"INVISIBLE_DOTS_WORKSPACE": "  ", "INVISIBLE_DOTS_OPENROUTER_URL": " "})

        assert env.workspace == "/home/dot/workspace"
        assert env.openrouter_url is None


class RunBound:
    """How long `a_run_that_ends` lets main() run, in seconds."""

    seconds = 10.0


@pytest.fixture
def a_run_that_ends(monkeypatch: pytest.MonkeyPatch) -> RunBound:
    """Bound the engine's run inside main(): a test of a refusal then fails, where it would stall.

    main() serves until a signal arrives. A refusal that stopped refusing would start the engine
    and the test would never return, so CI would hang until its own timeout. The refusals all
    come before the engine has anything to wait for, so a run that is still going after the
    bound is a refusal that did not happen.
    """
    bound = RunBound()
    run = entry_point._run

    async def bounded(environment: Environment) -> None:
        try:
            await asyncio.wait_for(run(environment), bound.seconds)
        except TimeoutError:
            pytest.fail(f"the engine was still serving after {bound.seconds} s: it should have refused to start")

    monkeypatch.setattr(entry_point, "_run", bounded)
    return bound


@pytest.mark.usefixtures("a_run_that_ends")
class TestWhatItRefusesToStartOn:
    def environ(self, state: Path, **extra: str) -> dict[str, str]:
        return {
            "INVISIBLE_DOTS_ENGINE_STATE": str(state),
            "INVISIBLE_DOTS_AGENT_SOCKET": str(state.parent / "agent.sock"),
            "HOME": str(state.parent / "home"),
            **extra,
        }

    def test_a_credential_in_a_file_is_named_by_where_never_by_what(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        state = tmp_path / "state"
        state.mkdir()
        (state / ".env").write_bytes(b"OPENROUTER_API_KEY=sk-or-leaked-value\n")

        assert main([], self.environ(state)) == 1

        err = capsys.readouterr().err
        assert "refusing to start" in err
        assert str(state / ".env") in err
        assert "sk-or-leaked-value" not in err
        assert not (state / "engine.sqlite").exists()

    def test_a_credential_in_the_environment_is_named_by_its_variable(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        state = tmp_path / "state"

        assert main([], self.environ(state, OPENROUTER_API_KEY="sk-or-in-env")) == 1

        err = capsys.readouterr().err
        assert "environment variable OPENROUTER_API_KEY" in err
        assert "sk-or-in-env" not in err

    def test_a_second_engine_on_the_same_state_does_not_start(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        state = tmp_path / "state"
        owner = DotStore.open(state / "engine.sqlite")
        try:
            assert main([], self.environ(state)) == 1
        finally:
            owner.close()

        assert "another engine owns" in capsys.readouterr().err

    def test_a_database_of_another_engine_version_does_not_start(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        state = tmp_path / "state"
        state.mkdir()
        raw = sqlite3.connect(state / "engine.sqlite")
        raw.execute("CREATE TABLE dots_kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
        raw.commit()
        raw.close()

        assert main([], self.environ(state)) == 1

        err = capsys.readouterr().err
        assert "refusing to start: the engine database was made by another engine version" in err
        assert str(state / "engine.sqlite") in err
        # Refused untouched: the journal mode is still the one the file had.
        raw = sqlite3.connect(state / "engine.sqlite")
        try:
            assert raw.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        finally:
            raw.close()

    def test_the_bound_fails_an_engine_that_starts_instead_of_stalling(self, a_run_that_ends: RunBound) -> None:
        a_run_that_ends.seconds = 1.0
        directory = short_dir()
        try:
            environ = {
                "INVISIBLE_DOTS_ENGINE_STATE": str(directory / "state"),
                "INVISIBLE_DOTS_AGENT_SOCKET": str(directory / "agent.sock"),
                "INVISIBLE_DOTS_AGENTD_BIN": str(directory / "no-dot-agentd"),
                "HOME": str(directory),
            }

            with pytest.raises(pytest.fail.Exception, match="still serving after 1.0 s"):
                main([], environ)
        finally:
            shutil.rmtree(directory, ignore_errors=True)


class TestTheGoldenLock:
    """The runtime disk's source and the golden image's venv must come from the same lock (architecture 3.3)."""

    def trees(self, tmp_path: Path) -> tuple[Path, Path]:
        source, prefix = tmp_path / "engine", tmp_path / "venv"
        source.mkdir()
        prefix.mkdir()
        return source, prefix

    def test_the_same_lock_on_both_sides_starts(self, tmp_path: Path) -> None:
        source, prefix = self.trees(tmp_path)
        (source / LOCK_FILE).write_bytes(b"idna==3.20 \\\n    --hash=sha256:aa\n")
        (prefix / LOCK_FILE).write_bytes(b"idna==3.20 \\\n    --hash=sha256:aa\n")

        check_golden_lock(source, prefix)

    def test_a_development_checkout_has_neither_and_is_not_checked(self, tmp_path: Path) -> None:
        source, prefix = self.trees(tmp_path)

        check_golden_lock(source, prefix)

    def test_a_different_lock_is_refused_and_says_what_to_do(self, tmp_path: Path) -> None:
        source, prefix = self.trees(tmp_path)
        (source / LOCK_FILE).write_bytes(b"idna==3.21\n")
        (prefix / LOCK_FILE).write_bytes(b"idna==3.20\n")

        with pytest.raises(GoldenLockError, match="another requirements lock: build a new golden image"):
            check_golden_lock(source, prefix)

    @pytest.mark.parametrize("present", ["source", "venv"])
    def test_a_lock_on_one_side_only_is_refused(self, tmp_path: Path, present: str) -> None:
        source, prefix = self.trees(tmp_path)
        ((source if present == "source" else prefix) / LOCK_FILE).write_bytes(b"idna==3.20\n")

        with pytest.raises(GoldenLockError):
            check_golden_lock(source, prefix)

    def test_a_directory_in_the_place_of_a_lock_is_a_mismatch_not_a_crash(self, tmp_path: Path) -> None:
        source, prefix = self.trees(tmp_path)
        (source / LOCK_FILE).mkdir()
        (prefix / LOCK_FILE).write_bytes(b"idna==3.20\n")

        with pytest.raises(GoldenLockError):
            check_golden_lock(source, prefix)

    @pytest.mark.usefixtures("a_run_that_ends")
    def test_main_refuses_to_start_before_it_opens_the_state(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # A venv and a source tree whose locks differ: the module's own location and the
        # interpreter's prefix are where the engine looks for them.
        source, prefix = self.trees(tmp_path)
        (source / LOCK_FILE).write_bytes(b"idna==3.21\n")
        (prefix / LOCK_FILE).write_bytes(b"idna==3.20\n")
        package = source / "nanobot"
        package.mkdir()
        (package / "__init__.py").write_bytes(b"")
        monkeypatch.setattr(nanobot, "__file__", str(package / "__init__.py"))
        monkeypatch.setattr(sys, "prefix", str(prefix))
        state = tmp_path / "state"

        code = main([], {"INVISIBLE_DOTS_ENGINE_STATE": str(state), "HOME": str(tmp_path / "home")})

        assert code == 1
        assert capsys.readouterr().err == f"refusing to start: {LOCK_MISMATCH}\n"
        assert not state.exists()


class FakeOpenRouter:
    """What the engine's provider talks to in these tests: it answers "pong" and keeps what it was sent."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.runner: web.AppRunner | None = None
        self.port = free_port()

    async def _completions(self, request: web.Request) -> web.StreamResponse:
        body = await request.json()
        self.requests.append({"headers": dict(request.headers), "body": body})
        usage = {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}
        # The provider always streams: the model's answer comes back as server-sent events.
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)

        def chunk(delta: dict[str, Any], finish: str | None, extra: dict[str, Any] | None = None) -> bytes:
            frame = {
                "id": "chatcmpl-1",
                "object": "chat.completion.chunk",
                "model": body["model"],
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}] if delta or finish else [],
                **(extra or {}),
            }
            return f"data: {json.dumps(frame)}\n\n".encode()

        await response.write(chunk({"role": "assistant", "content": "pong"}, None))
        await response.write(chunk({}, "stop"))
        await response.write(chunk({}, None, {"usage": usage}))
        await response.write(b"data: [DONE]\n\n")
        return response

    async def start(self) -> None:
        app = web.Application()
        app.router.add_post("/api/v1/chat/completions", self._completions)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        await web.TCPSite(self.runner, "127.0.0.1", self.port).start()

    async def stop(self) -> None:
        if self.runner is not None:
            await self.runner.cleanup()


class Served:
    def __init__(self, environment: Environment, session: aiohttp.ClientSession, task: asyncio.Task[None], stop: asyncio.Event, fake: FakeOpenRouter) -> None:
        self.environment = environment
        self.session = session
        self.task = task
        self.stop = stop
        self.fake = fake

    async def call(self, method: str, path: str, body: Any = None) -> tuple[int, str]:
        async with self.session.request(
            method, "http://agent" + path, data=None if body is None else json.dumps(body)
        ) as response:
            return response.status, await response.text()


@pytest.fixture
async def served() -> AsyncIterator[Served]:
    directory = short_dir()
    fake = FakeOpenRouter()
    await fake.start()
    environment = Environment(
        agent_socket=str(directory / "agent.sock"),
        agentd_socket=str(directory / "agentd.sock"),
        agentd_bin=str(directory / "no-dot-agentd"),
        workspace="/home/dot/workspace",
        state_dir=str(directory / "state"),
        openrouter_url=f"http://127.0.0.1:{fake.port}/api/v1",
        network_check=f"127.0.0.1:{fake.port}",
        mcp_command="invisible-playwright-mcp",
        path="",
        home=str(directory),
    )
    stop = asyncio.Event()
    task = asyncio.get_running_loop().create_task(serve(environment, stop))
    for _ in range(500):
        if Path(environment.agent_socket).exists() or task.done():
            break
        await asyncio.sleep(0.01)
    session = aiohttp.ClientSession(connector=aiohttp.UnixConnector(path=environment.agent_socket))
    api = Served(environment, session, task, stop, fake)
    yield api
    await session.close()
    stop.set()
    await asyncio.wait_for(task, 30)
    await fake.stop()
    shutil.rmtree(directory, ignore_errors=True)


async def next_events(api: Served, after: int, count: int) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async with api.session.get(f"http://agent/events/stream?after={after}") as response:
        async for raw in response.content:
            line = raw.decode("utf-8")
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
                if len(events) >= count:
                    break
    return events


class TestTheEngineServed:
    async def test_a_message_goes_through_the_api_the_provider_and_back_into_the_stream(self, served: Served) -> None:
        status, health = await served.call("GET", "/health")
        assert status == 200
        assert json.loads(health)["status"] == "ok"
        assert json.loads(health)["checks"]["network_reachable"] is True

        assert (await served.call("PUT", "/config", runtime_config_body(permissions={"files.read": "allow"})))[0] == 204
        assert (await served.call("POST", "/secrets", {"openrouter_api_key": "sk-or-served"}))[0] == 204
        event = {"id": "m1", "type": "user.message", "ts": TS, "data": {"text": "ping"}}
        assert (await served.call("POST", "/events", event))[0] == 202
        events = await asyncio.wait_for(next_events(served, 0, 6), 30)

        assert [e["type"] for e in events] == [
            "agent.started", "agent.state", "agent.state", "message.assistant", "agent.state", "agent.state",
        ]
        assert events[3]["data"] == {"text": "pong", "in_reply_to": "m1"}
        (request,) = served.fake.requests
        # The key reached the provider from memory, the model is the Dot's, and nothing of the Dot's
        # attribution goes to a stand-in.
        assert request["headers"]["Authorization"] == "Bearer sk-or-served"
        assert request["body"]["model"] == "z-ai/glm-5.3-flash"
        assert "HTTP-Referer" not in request["headers"]
        assert "ping" in json.dumps(request["body"]["messages"])
        # The state is in the one database file, the key in none.
        state = Path(served.environment.state_dir)
        assert (state / "engine.sqlite").exists()
        assert "sk-or-served" not in b"".join(p.read_bytes() for p in state.rglob("*") if p.is_file()).decode("latin-1")

    async def test_the_cron_service_keeps_its_jobs_in_the_state_directory(self, served: Served) -> None:
        jobs = Path(served.environment.state_dir) / "cron" / "jobs.json"
        for _ in range(100):
            if jobs.exists():
                break
            await asyncio.sleep(0.02)

        assert jobs.exists()

    async def test_stopping_closes_the_socket_and_the_database(self, served: Served) -> None:
        socket_path = Path(served.environment.agent_socket)
        assert socket_path.exists()
        stream = asyncio.create_task(next_events(served, 10_000, 1))
        await asyncio.sleep(0.05)

        served.stop.set()
        await asyncio.wait_for(served.task, 30)

        assert not socket_path.exists()
        stream.cancel()
        # The database is free again: another engine can take it.
        DotStore.open(Path(served.environment.state_dir) / "engine.sqlite").close()

    async def test_shutdown_stops_accepting_and_closes_the_streams_before_the_engine_stops(
        self, served: Served, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The order of the contract's index.ts: nothing new is taken while the turns in flight end.
        seen: dict[str, Any] = {}
        real_stop = Engine.stop
        stream = asyncio.create_task(next_events(served, 10_000, 1))
        await asyncio.sleep(0.05)

        async def stop(engine: Engine) -> None:
            try:
                async with aiohttp.ClientSession(
                    connector=aiohttp.UnixConnector(path=served.environment.agent_socket)
                ) as late:
                    await late.get("http://agent/health")
                seen["connected"] = True
            except aiohttp.ClientConnectorError:
                seen["connected"] = False
            # The stream of before is ended by now.
            seen["stream_ended"] = await asyncio.wait_for(stream, 10) == []
            await real_stop(engine)

        monkeypatch.setattr(Engine, "stop", stop)
        served.stop.set()
        await asyncio.wait_for(served.task, 30)

        assert seen == {"connected": False, "stream_ended": True}
