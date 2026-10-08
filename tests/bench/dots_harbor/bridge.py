"""Calls of tests/bench/bridge.ts: the product, driven from the outside like the end-to-end run."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

BRIDGE = Path(__file__).resolve().parent.parent / "bridge.ts"
NODE = os.environ.get("BENCH_NODE", "node")


class BridgeError(RuntimeError):
    pass


async def call(*args: str, stdin: bytes = b"", raw: bool = False, timeout_s: float | None = None) -> Any:
    process = await asyncio.create_subprocess_exec(
        NODE,
        str(BRIDGE),
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(process.communicate(stdin), timeout_s)
    except (TimeoutError, asyncio.CancelledError):
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        raise BridgeError(f"bridge {args[0]} {args[1]}: exit {process.returncode}: {err.decode(errors='replace')[-2000:]}")
    return out if raw else json.loads(out)
