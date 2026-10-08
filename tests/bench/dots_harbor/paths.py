"""Where a benchmark task's absolute paths live in a Dot.

A Harbor task assumes root in a container: it works in /app, the harness puts the tests in /tests, the
reference solution in /solution and the logs in /logs. A Dot's model works as the user dot, with no root
(architecture section 4.2), and the host reaches only dot's home. So every such root is moved under
/home/dot/bench, the same way in the commands, the instruction and the text files the harness uploads.
"""

from __future__ import annotations

import re

BENCH_HOME = "/home/dot/bench"
ROOTS = ("app", "tests", "solution", "logs", "installed-agent", "workspace", "data", "output", "results")

# A root at the start of a path: not preceded by a path or URL character, followed by "/" or the path's end.
_ROOT = re.compile(r"(?<![\w.~/:-])/(" + "|".join(re.escape(root) for root in ROOTS) + r")(?=/|$|[\s\"'`);:,|&<>=\]}])")


def map_paths(text: str) -> str:
    """`text` with each absolute path under one of the roots moved under BENCH_HOME."""
    return _ROOT.sub(lambda match: f"{BENCH_HOME}/{match.group(1)}", text)


def map_path(path: str) -> str:
    return map_paths(str(path))


def map_file(content: bytes) -> bytes:
    """A text file's content mapped; any other file as it is."""
    if b"\x00" in content:
        return content
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return content
    return map_paths(text).encode("utf-8")
