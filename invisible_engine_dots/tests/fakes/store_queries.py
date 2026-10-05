"""Reads of the store that only tests make."""

from __future__ import annotations

import sqlite3


def last_seq(conn: sqlite3.Connection) -> int:
    """The highest seq in the outbox, 0 when it is empty."""
    row = conn.execute("SELECT MAX(seq) FROM dots_outbox").fetchone()
    return int(row[0] or 0)
