"""`dots` is `invisible-playwright-mcp ui`, and nothing else.

It goes through the package's command GROUP rather than calling the `ui`
command directly, because the group is where the `.env` beside the command is
read and where an old session directory is carried over. Calling `ui` on its
own would skip both, and a key kept in `.env` would simply not be found.
"""
from __future__ import annotations

import sys

#: The one subcommand this program is. Every option after it is the
#: interface's own, so `dots --help` lists exactly what `ui --help` does.
SUBCOMMAND = "ui"


def main(argv: list[str] | None = None) -> None:
    from invisible_playwright_mcp.cli import main as group

    args = list(sys.argv[1:] if argv is None else argv)
    group(args=[SUBCOMMAND, *args], prog_name="dots")
