"""What an MCP server writes to its stderr, on its way to the engine's journal, through a filter."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from collections.abc import Callable

import pytest

from nanobot.agent.tools.mcp_stderr import FilteredStderr, StderrFilter
from nanobot.dots.browser import _proxy_stderr_filter

SECRET = "hunter2-pass"


def hide_secret(text: str) -> str:
    return text.replace(SECRET, "***")


class Journal:
    """The sink of a FilteredStderr: what reached the journal, and a way to wait for it."""

    def __init__(self) -> None:
        self.chunks: list[str] = []
        self._lock = threading.Lock()

    def write(self, text: str) -> None:
        with self._lock:
            self.chunks.append(text)

    @property
    def text(self) -> str:
        with self._lock:
            return "".join(self.chunks)

    def wait_for(self, done: Callable[[str], bool], timeout: float = 10.0) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if done(self.text):
                return self.text
            time.sleep(0.01)
        raise AssertionError(f"the journal never got what was awaited; it has {self.text[-200:]!r}")


def write_through(stderr: FilteredStderr, data: bytes) -> None:
    """What a child does: write to the inherited descriptor, then exit (the end of its copy)."""
    stderr.errlog.write(data.decode("utf-8"))
    stderr.errlog.flush()
    stderr.close_write_end()


def test_a_line_reaches_the_journal_with_the_secret_hidden_and_its_newline_kept() -> None:
    journal = Journal()
    stderr = FilteredStderr(StderrFilter(hide_secret, len(SECRET)), sink=journal.write)

    write_through(stderr, f"first {SECRET}\nsecond\nthird {SECRET} and more".encode())

    assert journal.wait_for(lambda text: "and more" in text) == "first ***\nsecond\nthird *** and more"


def test_what_a_real_process_writes_to_the_inherited_descriptor_is_filtered() -> None:
    journal = Journal()
    stderr = FilteredStderr(StderrFilter(hide_secret, len(SECRET)), sink=journal.write)
    program = f"import sys; sys.stderr.write('traceback: {SECRET}\\n'); sys.stderr.write('done')"

    subprocess.run([sys.executable, "-c", program], stderr=stderr.errlog, check=True)
    stderr.close_write_end()

    assert journal.wait_for(lambda text: "done" in text) == "traceback: ***\ndone"


@pytest.mark.parametrize("offset", range(0, 200))
def test_a_long_line_is_cut_without_splitting_the_secret_across_two_pieces(offset: int) -> None:
    # Small limits, so the cut falls at every place around the secret: the line is longer than 64 characters,
    # the last 16 are held back (the secret has 12), and the pipe is read 8 bytes at a time.
    journal = Journal()
    stderr = FilteredStderr(StderrFilter(hide_secret, 16), sink=journal.write, line_cap=64, chunk_size=8)
    line = "x" * offset + SECRET + "y" * (150 - offset)

    write_through(stderr, line.encode())

    expected = "x" * offset + "***" + "y" * (150 - offset)
    assert journal.wait_for(lambda text: len(text) >= len(expected)) == expected


def test_a_multibyte_character_cut_by_a_read_is_not_damaged() -> None:
    journal = Journal()
    stderr = FilteredStderr(StderrFilter(hide_secret, len(SECRET)), sink=journal.write, chunk_size=1)

    write_through(stderr, "caffè ☃ \U0001f98a\n".encode())

    assert journal.wait_for(lambda text: text.endswith("\n")) == "caffè ☃ \U0001f98a\n"


def test_a_line_the_filter_cannot_handle_is_withheld_and_the_next_one_goes_on() -> None:
    journal = Journal()

    def broken(text: str) -> str:
        if "boom" in text:
            raise RuntimeError("the filter broke")
        return text

    stderr = FilteredStderr(StderrFilter(broken, 4), sink=journal.write)
    write_through(stderr, b"boom with the secret\nfine\n")

    # Fail closed: the line itself never goes out unfiltered.
    assert journal.wait_for(lambda text: "fine" in text) == "[a line of the server's stderr was withheld: its filter failed]\nfine\n"


def test_a_journal_that_cannot_be_written_does_not_stop_the_server_from_writing() -> None:
    # A child blocked on a full pipe would hang; the pump has to go on reading whatever the sink does.
    def broken_sink(text: str) -> None:
        raise OSError("the journal is closed")

    stderr = FilteredStderr(StderrFilter(hide_secret, len(SECRET)), sink=broken_sink)
    writer = threading.Thread(target=write_through, args=(stderr, b"line of text\n" * 40_000), daemon=True)
    writer.start()
    writer.join(timeout=20)

    assert not writer.is_alive()


@pytest.mark.parametrize("offset", [0, 30_000, 64 * 1024 - 100, 64 * 1024 + 1, 100_000, 130_000 - 70_000])
def test_a_secret_longer_than_a_default_line_is_not_split_by_the_cut(offset: int) -> None:
    # The filter says how long its text is, and the pump keeps that much behind: a secret of 70 000 characters,
    # more than a line may hold by default, straddles the cut of a line of 200 000 characters, read in 64 KiB pieces.
    secret = "k" * 70_000
    journal = Journal()
    stderr = FilteredStderr(StderrFilter(lambda text: text.replace(secret, "***"), len(secret)), sink=journal.write)
    line = "x" * offset + secret + "y" * (200_000 - offset)

    write_through(stderr, line.encode())

    expected = "x" * offset + "***" + "y" * (200_000 - offset)
    assert journal.wait_for(lambda text: len(text) >= len(expected)) == expected


@pytest.mark.parametrize("offset", range(10_000, 32_000, 1_000))
def test_a_proxy_password_longer_than_four_kib_is_hidden_wherever_the_cut_falls(offset: int) -> None:
    # The first line of defence of the journal: a password (and its JSON form, 12 characters to a fox) that no
    # fixed holdback could cover. The cut falls inside the password for some offsets.
    password = "s3cr3t-\U0001f98a" * 600
    proxy = f"http://user:{password}@proxy.test:8080"
    journal = Journal()
    stderr = FilteredStderr(_proxy_stderr_filter(proxy), sink=journal.write, line_cap=30_000, chunk_size=8192)
    shown = json.dumps(password)[1:-1]  # as a log line of JSON shows it: 12 characters for each fox
    line = "x" * offset + shown + "y" * (50_000 - offset)

    write_through(stderr, line.encode())

    expected = "x" * offset + "***" + "y" * (50_000 - offset)
    assert journal.wait_for(lambda text: len(text) >= len(expected)) == expected
