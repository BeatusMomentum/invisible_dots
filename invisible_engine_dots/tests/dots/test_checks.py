"""The guest's own checks: what `/health` reports and how often it looks."""

from __future__ import annotations

import asyncio
import os
import socket
import threading
from pathlib import Path

import pytest

from nanobot.dots import checks as checks_module
from nanobot.dots.checks import GuestChecks, create_guest_checks


def executable(directory: Path, name: str = "invisible-playwright-mcp", mode: int = 0o755) -> Path:
    path = directory / name
    path.write_bytes(b"#!/bin/sh\n")
    path.chmod(mode)
    return path


def closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class TestWhatItChecks:
    async def test_a_writable_directory_a_reachable_target_and_an_installed_browser_all_pass(
        self, tmp_path: Path
    ) -> None:
        server = await asyncio.start_server(lambda reader, writer: writer.close(), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        executable(bin_dir)
        try:
            checks = create_guest_checks(
                writable_dir=tmp_path, network_target=f"127.0.0.1:{port}", path=str(bin_dir)
            )
            result = await checks()
        finally:
            server.close()
            await server.wait_closed()

        assert result == GuestChecks(True, True, True)
        assert result.to_json() == {
            "filesystem_writable": True,
            "network_reachable": True,
            "browser_installed": True,
        }
        # The probe file does not stay behind.
        assert [p.name for p in tmp_path.iterdir() if p.name.startswith(".write-check")] == []

    async def test_each_failure_is_its_own_flag(self, tmp_path: Path) -> None:
        checks = create_guest_checks(
            writable_dir=tmp_path / "missing",
            network_target=f"127.0.0.1:{closed_port()}",
            path=str(tmp_path),
        )

        assert await checks() == GuestChecks(False, False, False)

    async def test_the_browser_is_looked_up_in_the_path_or_named_by_an_absolute_path(self, tmp_path: Path) -> None:
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        found = executable(elsewhere, "mcp-server")
        target = f"127.0.0.1:{closed_port()}"

        by_path = create_guest_checks(
            writable_dir=tmp_path, network_target=target, browser_command="mcp-server", path=f"/nope{os.pathsep}{elsewhere}"
        )
        absolute = create_guest_checks(
            writable_dir=tmp_path, network_target=target, browser_command=str(found), path=""
        )
        not_executable = create_guest_checks(
            writable_dir=tmp_path,
            network_target=target,
            browser_command=str(executable(elsewhere, "plain-file", 0o644)),
            path="",
        )

        assert (await by_path()).browser_installed is True
        assert (await absolute()).browser_installed is True
        assert (await not_executable()).browser_installed is False

    async def test_a_target_that_is_not_host_and_port_is_just_unreachable(self, tmp_path: Path) -> None:
        checks = create_guest_checks(writable_dir=tmp_path, network_target="127.0.0.1:not-a-port", path="")

        assert (await checks()).network_reachable is False

    async def test_a_target_without_a_port_means_https(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dialed: list[tuple[str, int]] = []

        async def refuse(host: str, port: int) -> tuple[None, None]:
            dialed.append((host, port))
            raise ConnectionRefusedError

        monkeypatch.setattr(asyncio, "open_connection", refuse)
        checks = create_guest_checks(writable_dir=tmp_path, network_target="example.test", path="")

        assert (await checks()).network_reachable is False
        assert dialed == [("example.test", 443)]


class TestHowOften:
    @pytest.fixture
    def writes(self, monkeypatch: pytest.MonkeyPatch) -> list[int]:
        """The writable check, counted: it is the one that runs in a thread."""
        made: list[int] = []
        lock = threading.Lock()

        def counted(directory: Path) -> bool:
            with lock:
                made.append(1)
            return True

        monkeypatch.setattr(checks_module, "_can_write", counted)
        return made

    async def test_runs_at_most_once_per_ttl(self, tmp_path: Path, writes: list[int]) -> None:
        checks = create_guest_checks(writable_dir=tmp_path, network_target=f"127.0.0.1:{closed_port()}", path="")

        first = await checks()
        second = await checks()

        assert first is second
        assert len(writes) == 1

    async def test_looks_again_once_the_ttl_has_passed(self, tmp_path: Path, writes: list[int]) -> None:
        checks = create_guest_checks(
            writable_dir=tmp_path, network_target=f"127.0.0.1:{closed_port()}", path="", ttl_s=0.0
        )

        await checks()
        await checks()

        assert len(writes) == 2

    async def test_callers_that_arrive_together_share_one_run(self, tmp_path: Path, writes: list[int]) -> None:
        checks = create_guest_checks(writable_dir=tmp_path, network_target=f"127.0.0.1:{closed_port()}", path="")

        results = await asyncio.gather(*(checks() for _ in range(5)))

        assert len(writes) == 1
        assert all(result == results[0] for result in results)

    async def test_a_caller_that_gives_up_does_not_stop_the_run_the_others_wait_for(
        self, tmp_path: Path, writes: list[int]
    ) -> None:
        checks = create_guest_checks(writable_dir=tmp_path, network_target=f"127.0.0.1:{closed_port()}", path="")
        impatient = asyncio.create_task(checks())
        patient = asyncio.create_task(checks())
        await asyncio.sleep(0)
        impatient.cancel()

        assert (await patient).filesystem_writable is True
        assert len(writes) == 1
