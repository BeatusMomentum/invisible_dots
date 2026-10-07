"""exec sessions on a pseudo-terminal: what the model reads, and what stays as before.

The relay of these tests is the fake one (tests/fakes/fake_relay.py), which runs the program
on the engine's pipes, so a real terminal's behavior (echo, line endings, `test -t 0`) is the smoke's.
These tests write the escape sequences a terminal would carry themselves.
"""

from __future__ import annotations

import asyncio
import re
import shlex
import sys
from pathlib import Path

from fakes.local_computer import LocalComputer

from nanobot.agent.tools.exec_session import (
    ExecSessionManager,
    ExecSessionTool,
    ListExecSessionsTool,
)
from nanobot.agent.tools.shell import ExecTool


def _python_command(code: str) -> str:
    return f"{shlex.quote(sys.executable)} -u -c {shlex.quote(code)}"


def _session_id(output: str) -> str:
    match = re.search(r"session_id:\s*([0-9a-f]+)", output)
    assert match, output
    return match.group(1)


COLORED = "import sys; sys.stdout.write('\\x1b[1;32mname?\\x1b[0m\\r\\n10%\\r50%\\r100%\\r\\n'); sys.stdin.readline()"


async def _colored_output(tool: ExecTool, manager: ExecSessionManager, *, tty: bool) -> str:
    """What the model reads of COLORED, which writes once and then waits on its input. On a loaded machine the
    interpreter can take longer than the first yield to start; the model then reads the session, as here."""
    first = await tool.execute(command=_python_command(COLORED), tty=tty, yield_time_ms=500)
    if "100%" in first:
        return first
    session = ExecSessionTool(manager=manager)
    return await session.execute(session_id=_session_id(first), wait_for="100%", timeout_ms=10_000)


def test_a_tty_session_shows_the_text_of_the_screen(tmp_path: Path) -> None:
    async def run() -> str:
        manager = ExecSessionManager()
        tool = ExecTool(LocalComputer(tmp_path), timeout=10, session_manager=manager)
        try:
            return await _colored_output(tool, manager, tty=True)
        finally:
            await manager.close_all()

    result = asyncio.run(run())

    assert "\x1b" not in result
    assert "\r" not in result
    assert result.startswith("name?\n100%\n")
    assert "Process running. session_id:" in result


def test_a_session_without_a_tty_keeps_the_raw_stream(tmp_path: Path) -> None:
    async def run() -> str:
        manager = ExecSessionManager()
        tool = ExecTool(LocalComputer(tmp_path), timeout=10, session_manager=manager)
        try:
            return await _colored_output(tool, manager, tty=False)
        finally:
            await manager.close_all()

    result = asyncio.run(run())

    assert "\x1b[1;32mname?\x1b[0m\r\n10%\r50%\r100%\r\n" in result


def test_an_escape_sequence_split_across_two_polls_is_never_shown_in_halves(tmp_path: Path) -> None:
    code = (
        "import sys; sys.stdout.write('a\\x1b[3'); sys.stdout.flush(); sys.stdin.readline(); "
        "sys.stdout.write('1mred\\x1b]0;ti'); sys.stdout.flush(); sys.stdin.readline(); "
        "sys.stdout.write('tle\\x07 end\\n')"
    )

    async def run() -> tuple[str, str, str]:
        manager = ExecSessionManager()
        tool = ExecTool(LocalComputer(tmp_path), timeout=10, session_manager=manager)
        session = ExecSessionTool(manager=manager)
        try:
            first = await tool.execute(command=_python_command(code), tty=True, yield_time_ms=500)
            sid = _session_id(first)
            second = await session.execute(session_id=sid, input="go\n", timeout_ms=1000)
            third = await session.execute(session_id=sid, input="go\n", timeout_ms=1000, until_exit=True)
            return first, second, third
        finally:
            await manager.close_all()

    first, second, third = asyncio.run(run())

    assert first.startswith("a\nProcess running")  # the cut sequence is held back, not shown
    assert "\x1b" not in first + second + third
    assert "[3" not in first + second + third
    assert second.startswith("red\nProcess running")
    assert third.startswith(" end\n")
    assert "title" not in second + third
    assert "Exit code: 0" in third


def test_the_end_of_a_tty_session_flushes_a_sequence_that_never_finished(tmp_path: Path) -> None:
    code = "import sys; sys.stdout.write('end\\x1b[3')"

    async def run() -> str:
        manager = ExecSessionManager()
        tool = ExecTool(LocalComputer(tmp_path), timeout=10, session_manager=manager)
        try:
            return await tool.execute(command=_python_command(code), tty=True, yield_time_ms=2000)
        finally:
            await manager.close_all()

    result = asyncio.run(run())

    assert result.startswith("end")
    assert "\x1b" not in result
    assert "Exit code: 0" in result


def test_input_and_terminate_work_on_a_tty_session_as_on_any_session(tmp_path: Path) -> None:
    code = "import sys; print('name? ', end='', flush=True); print('hi ' + sys.stdin.readline().strip(), flush=True); sys.stdin.readline()"

    async def run() -> tuple[str, str, str]:
        manager = ExecSessionManager()
        tool = ExecTool(LocalComputer(tmp_path), timeout=10, session_manager=manager)
        session = ExecSessionTool(manager=manager)
        try:
            first = await tool.execute(command=_python_command(code), tty=True, yield_time_ms=500)
            sid = _session_id(first)
            answered = await session.execute(session_id=sid, input="Ada\n", wait_for="hi Ada", timeout_ms=3000)
            ended = await session.execute(session_id=sid, terminate=True)
            return first, answered, ended
        finally:
            await manager.close_all()

    first, answered, ended = asyncio.run(run())

    assert "name? " in first
    assert "hi Ada" in answered
    assert "Session terminated." in ended
    assert "Exit code:" in ended


def test_list_exec_sessions_shows_which_sessions_are_terminals(tmp_path: Path) -> None:
    async def run() -> str:
        manager = ExecSessionManager()
        tool = ExecTool(LocalComputer(tmp_path), timeout=10, session_manager=manager)
        try:
            await tool.execute(command="read _", tty=True, yield_time_ms=100)
            await tool.execute(command="read _; echo plain", yield_time_ms=100)
            return await ListExecSessionsTool(manager=manager).execute()
        finally:
            await manager.close_all()

    lines = asyncio.run(run()).splitlines()

    assert len(lines) == 2
    terminal, plain = sorted(lines, key=lambda line: "| tty |" not in line)
    assert "| running | tty |" in terminal
    assert terminal.endswith("| read _")
    assert "| tty |" not in plain
