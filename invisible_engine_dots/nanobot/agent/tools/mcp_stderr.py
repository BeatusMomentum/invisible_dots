"""The stderr of an MCP server on its way to the engine's own stderr, through a filter.

An MCP server started over stdio inherits the engine's stderr, which the journal keeps. A server that is
handed a secret (a proxy URL with its password) may repeat it there in a log line or a traceback, so
`connect_mcp_servers` gives such a server a pipe instead: the process writes into it, and a thread reads it,
passes every line through the server's `stderr_filter` and writes the result to the engine's stderr.
"""

from __future__ import annotations

import codecs
import os
import sys
import threading
from collections.abc import Callable
from typing import TextIO

# A line longer than this is cut: the journal keeps lines of a few KiB at most, and a server that never ends a
# line must not grow the buffer without bound.
LINE_CAP = 64 * 1024
# What stays behind when a long line is cut, so that a secret straddling the cut is still whole in the next
# piece. It must be longer than any text the filter looks for; a proxy URL is a few hundred characters.
HOLDBACK = 4096
CHUNK_SIZE = 64 * 1024
WITHHELD = "[a line of the server's stderr was withheld: its filter failed]\n"


def _to_engine_stderr(text: str) -> None:
    # Looked up at each write, so a stderr that was replaced (a test, a redirect) is the one written to.
    sys.stderr.write(text)
    sys.stderr.flush()


class FilteredStderr:
    """A pipe that a server's stderr is written into; what is read from it is filtered and passed on.

    `errlog` is the write end, a real file, which the SDK hands to the new process as its stderr. Once the
    process has started, `close_write_end` drops this side's copy, so the pipe ends when the process (and
    whatever inherited it) does, and the thread then ends after the last line.
    """

    def __init__(
        self,
        scrub: Callable[[str], str],
        *,
        sink: Callable[[str], None] = _to_engine_stderr,
        line_cap: int = LINE_CAP,
        holdback: int = HOLDBACK,
        chunk_size: int = CHUNK_SIZE,
    ) -> None:
        if holdback >= line_cap:
            raise ValueError("holdback must be smaller than line_cap")
        self._scrub = scrub
        self._sink = sink
        self._line_cap = line_cap
        self._holdback = holdback
        self._chunk_size = chunk_size
        read_fd, write_fd = os.pipe()
        self.errlog: TextIO = os.fdopen(write_fd, "w", encoding="utf-8", errors="replace")
        threading.Thread(target=self._pump, args=(read_fd,), name="mcp-stderr", daemon=True).start()

    def close_write_end(self) -> None:
        self.errlog.close()

    def _pump(self, read_fd: int) -> None:
        # Decoded on the way in, so a character cut in two by a read is whole again; the filter sees text.
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        pending = ""
        try:
            while chunk := os.read(read_fd, self._chunk_size):
                *lines, pending = (pending + decoder.decode(chunk)).split("\n")
                for line in lines:
                    self._emit(line + "\n")
                if len(pending) > self._line_cap:
                    # Filter the whole buffer first, then hold back its end: a secret that lies in it is
                    # replaced, one that starts in the last `holdback` characters is completed by the next read.
                    filtered = self._filtered(pending)
                    if filtered is None:
                        self._write(WITHHELD)
                        pending = ""
                    else:
                        self._write(filtered[: -self._holdback])
                        pending = filtered[-self._holdback :]
            pending += decoder.decode(b"", final=True)
            if pending:
                self._emit(pending)
        except OSError:
            pass  # the descriptor was closed under the thread: nothing more will come
        finally:
            os.close(read_fd)

    def _emit(self, text: str) -> None:
        filtered = self._filtered(text)
        self._write(WITHHELD if filtered is None else filtered)

    def _filtered(self, text: str) -> str | None:
        """The text through the filter; None when the filter failed on it."""
        try:
            return self._scrub(text)
        except Exception:
            # Fail closed: text the filter could not handle may hold the secret, so it is not written at all.
            return None

    def _write(self, text: str) -> None:
        if not text:
            return
        try:
            self._sink(text)
        except Exception:
            # The journal cannot take it. Reading on matters more: a process whose stderr pipe is full blocks.
            pass
