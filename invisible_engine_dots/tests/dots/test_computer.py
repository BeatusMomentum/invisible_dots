"""Tests for AgentdComputer and relay execution."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.parse
from contextlib import suppress
from pathlib import Path

import pytest
from fakes.local_computer import install_fake_relay

from nanobot.dots.computer import (
    DEFAULT_AGENTD_BIN,
    DEFAULT_AGENTD_SOCKET,
    RELAY_PATH,
    WRONG_KIND,
    AgentdComputer,
    ComputerError,
    FileTooLargeError,
)


def test_relay_argv_defaults() -> None:
    comp = AgentdComputer()
    argv = comp.relay_argv(["echo", "hi"])
    assert argv == [
        DEFAULT_AGENTD_BIN,
        "relay",
        "--socket",
        DEFAULT_AGENTD_SOCKET,
        "--",
        "echo",
        "hi",
    ]


def test_relay_argv_with_options() -> None:
    comp = AgentdComputer(
        agentd_bin="/x/agentd",
        agentd_socket="/s.sock",
        workspace="/home/dot/workspace",
    )
    argv = comp.relay_argv(["ls", "-la"], cwd="/home/dot/workspace", tty=True)
    assert argv == [
        "/x/agentd",
        "relay",
        "--socket",
        "/s.sock",
        "--tty",
        "--cwd",
        "/home/dot/workspace",
        "--",
        "ls",
        "-la",
    ]


def test_spawn_env_isolation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_SECRET", "super_secret_token")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-secret")
    comp = AgentdComputer()

    env_non_tty = comp.spawn_env(tty=False)
    assert env_non_tty == {"PATH": RELAY_PATH}
    assert "FAKE_SECRET" not in env_non_tty
    assert "OPENROUTER_API_KEY" not in env_non_tty

    monkeypatch.setenv("TERM", "vt100")
    env_tty = comp.spawn_env(tty=True)
    assert env_tty == {"PATH": RELAY_PATH, "TERM": "vt100"}
    assert "FAKE_SECRET" not in env_tty


def _relay_records(log: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]


def _computer_with_fake_relay(tmp_path: Path) -> tuple[AgentdComputer, Path]:
    log = tmp_path / "relay.log"
    relay = install_fake_relay(tmp_path, log)
    computer = AgentdComputer(
        agentd_bin=str(relay),
        agentd_socket=str(tmp_path / "agentd.sock"),
        workspace=str(tmp_path),
    )
    return computer, log


async def _assert_process_gone(pid: int) -> None:
    async with asyncio.timeout(5):
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            await asyncio.sleep(0.02)


def _writes_its_pid_then_sleeps(pid_file: Path) -> str:
    return (
        "import os, pathlib, time; "
        f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )


@pytest.mark.asyncio
async def test_run_goes_through_the_relay_and_no_engine_variable_reaches_the_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_SECRET", "super_secret_token")
    computer, log = _computer_with_fake_relay(tmp_path)

    res = await computer.run(
        [
            sys.executable,
            "-c",
            "import os; print('SECRET=' + os.environ.get('FAKE_SECRET', 'NOT_FOUND'))",
        ],
        cwd=str(tmp_path),
    )

    assert res.exit_code == 0
    assert res.stdout.decode().strip() == "SECRET=NOT_FOUND"
    (record,) = _relay_records(log)
    assert record["socket"] == str(tmp_path / "agentd.sock")
    assert record["cwd"] == str(tmp_path)
    assert record["tty"] is False
    assert record["env"] == []
    assert record["program"][0] == sys.executable  # type: ignore[index]


@pytest.mark.asyncio
async def test_every_run_is_one_relay_invocation(tmp_path: Path) -> None:
    computer, log = _computer_with_fake_relay(tmp_path)

    await computer.run(["echo", "one"])
    await computer.run(["echo", "two"], cwd=str(tmp_path))

    programs = [record["program"] for record in _relay_records(log)]
    assert programs == [["echo", "one"], ["echo", "two"]]


@pytest.mark.asyncio
async def test_run_reports_exit_code_stdout_and_stderr(tmp_path: Path) -> None:
    computer, _ = _computer_with_fake_relay(tmp_path)

    res = await computer.run(
        [sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr); sys.exit(3)"]
    )

    assert res.exit_code == 3
    assert res.stdout == b"out\n"
    assert res.stderr == b"err\n"
    assert res.timed_out is False


@pytest.mark.asyncio
async def test_run_feeds_stdin(tmp_path: Path) -> None:
    computer, _ = _computer_with_fake_relay(tmp_path)

    res = await computer.run(["cat"], stdin=b"through stdin")

    assert res.stdout == b"through stdin"


@pytest.mark.asyncio
async def test_run_timeout_kills_the_relay_and_its_process_group(tmp_path: Path) -> None:
    computer, _ = _computer_with_fake_relay(tmp_path)
    pid_file = tmp_path / "pid"

    res = await computer.run(
        [sys.executable, "-c", _writes_its_pid_then_sleeps(pid_file)], timeout_s=1.0
    )

    assert res.timed_out is True
    assert res.exit_code == 124
    await _assert_process_gone(int(pid_file.read_text()))


@pytest.mark.asyncio
async def test_run_cancellation_kills_the_relay_and_its_process_group(tmp_path: Path) -> None:
    computer, _ = _computer_with_fake_relay(tmp_path)
    pid_file = tmp_path / "pid"

    task = asyncio.create_task(
        computer.run([sys.executable, "-c", _writes_its_pid_then_sleeps(pid_file)])
    )
    async with asyncio.timeout(10):
        while not pid_file.exists():
            await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    await _assert_process_gone(int(pid_file.read_text()))


def test_resolve_joins_relative_paths_to_the_workspace_and_leaves_absolute_ones() -> None:
    computer = AgentdComputer(workspace="/home/dot/workspace")

    assert computer.resolve("notes/a.txt") == "/home/dot/workspace/notes/a.txt"
    assert computer.resolve(".") == "/home/dot/workspace"
    assert computer.resolve("../memory/a.md") == "/home/dot/memory/a.md"
    assert computer.resolve("/etc/hostname") == "/etc/hostname"
    assert computer.resolve("/home/dot//x/../y") == "/home/dot/y"


@pytest.mark.asyncio
async def test_http_files_routes_against_fake_agentd(tmp_path: Path) -> None:
    sock_path = str(tmp_path / "agentd_test.sock")
    storage_dir = tmp_path / "storage"
    storage_dir.mkdir()

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            req_line = await reader.readline()
            if not req_line:
                writer.close()
                return
            parts = req_line.decode("latin1").strip().split(" ")
            method = parts[0]
            url = parts[1] if len(parts) > 1 else "/"

            headers: dict[str, str] = {}
            while True:
                line = await reader.readline()
                if not line or line == b"\r\n":
                    break
                header_line = line.decode("latin1").strip()
                if ":" in header_line:
                    k, v = header_line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            content_length = int(headers.get("content-length", 0))
            body = await reader.readexactly(content_length) if content_length > 0 else b""

            parsed_url = urllib.parse.urlparse(url)
            query = urllib.parse.parse_qs(parsed_url.query)
            path_param = query.get("path", [""])[0]

            if parsed_url.path == "/v1/files":
                if method == "GET":
                    if "error_500" in path_param:
                        writer.write(
                            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 14\r\n\r\nServer on fire"
                        )
                    else:
                        target = storage_dir / path_param.lstrip("/")
                        if target.is_file():
                            data = target.read_bytes()
                            writer.write(
                                f"HTTP/1.1 200 OK\r\nContent-Length: {len(data)}\r\n\r\n".encode("latin1")
                                + data
                            )
                        elif target.is_dir():
                            writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                        else:
                            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                elif method == "PUT":
                    target = storage_dir / path_param.lstrip("/")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(body)
                    writer.write(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
            elif parsed_url.path == "/v1/files/list":
                target = storage_dir / path_param.lstrip("/")
                if target.is_dir():
                    entries = []
                    for child in target.iterdir():
                        entries.append({
                            "name": child.name,
                            "type": "dir" if child.is_dir() else "file",
                            "size": child.stat().st_size if child.is_file() else 0,
                            "mtime": "2026-10-05T00:00:00Z",
                        })
                    resp_body = json.dumps({"entries": entries}).encode("utf-8")
                    writer.write(
                        f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(resp_body)}\r\n\r\n".encode("latin1")
                        + resp_body
                    )
                elif target.is_file():
                    writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                else:
                    writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
        finally:
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()

    server = await asyncio.start_unix_server(handle_client, path=sock_path)
    comp = AgentdComputer(agentd_socket=sock_path, workspace="/home/dot/workspace")

    try:
        # 1. Non-existent file returns None
        raw = await comp.read_bytes("notes.txt")
        assert raw is None

        # 2. Write file
        await comp.write_bytes("notes.txt", b"hello dot")

        # 3. Read written file
        read_back = await comp.read_bytes("notes.txt")
        assert read_back == b"hello dot"

        # 4. List dir
        listing = await comp.list_dir(".")
        assert listing is not None
        assert any(e.name == "notes.txt" and e.type == "file" and e.size == 9 for e in listing)

        # 5. Stat existing file
        st = await comp.stat("notes.txt")
        assert st is not None
        assert st.name == "notes.txt"
        assert st.type == "file"
        assert st.size == 9

        # 6. Stat non-existent file
        assert await comp.stat("missing.txt") is None

        # 7. List non-existent dir returns None
        assert await comp.list_dir("missing_dir") is None

        # 8. Server error raises ComputerError without leaking body
        with pytest.raises(ComputerError) as exc_info:
            await comp.read_bytes("error_500.txt")
        assert exc_info.value.status_code == 500
        assert exc_info.value.route == "GET /v1/files"
        assert "Server on fire" not in str(exc_info.value)

        # 9. A file larger than the caller's limit is refused, one that fits is read
        await comp.write_bytes("twenty.bin", b"x" * 20)
        with pytest.raises(FileTooLargeError) as too_large:
            await comp.read_bytes("twenty.bin", max_bytes=10)
        assert too_large.value.size == 20 and too_large.value.max_bytes == 10
        assert await comp.read_bytes("twenty.bin", max_bytes=20) == b"x" * 20

        # 10. A directory where a file was named is a wrong kind, not a missing file
        (storage_dir / "home" / "dot" / "workspace" / "somedir").mkdir(parents=True)
        with pytest.raises(ComputerError) as wrong_kind:
            await comp.read_bytes("somedir")
        assert wrong_kind.value.status_code == WRONG_KIND
        assert await comp.stat("notes.txt/below") is None

    finally:
        await comp.aclose()
        server.close()
        await server.wait_closed()

