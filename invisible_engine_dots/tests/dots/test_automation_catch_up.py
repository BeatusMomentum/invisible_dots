"""An automation that came due while the computer was off runs once, and a kill -9 cannot make it run twice.

The computer powers off when idle, the engine ends with it, and a job whose time passed meanwhile runs when the
engine starts again (one-time jobs, and the last missed occurrence of a recurring one, never a backlog). The
engine records each firing durably under an id made from the job and the time it was due (`cron:<job>:<due>`),
and the cron service moves a job's next run only afterwards, so a process killed between the two finds the job
due again and the engine recognizes the firing it already holds.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from fakes.dot_config import ALLOW_ALL, runtime_config_body
from fakes.engine_harness import EngineHarness
from fakes.scripted_provider import ScriptEntry, says

from nanobot.dots.store import DotStore

ENGINE_ROOT = Path(__file__).resolve().parents[2]
VICTIM = Path(__file__).with_name("automation_victim.py")
HOUR_MS = 3_600_000

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the kill is SIGKILL")


def seed_jobs(root: Path, now_ms: int) -> tuple[int, int]:
    """Two jobs, both due while the computer was off: a one-time reminder and an hourly one that missed two runs."""
    reminder_due = now_ms - 3 * HOUR_MS
    hourly_due = now_ms - 2 * HOUR_MS
    jobs = [
        {
            "id": "reminder",
            "name": "call the dentist",
            "enabled": True,
            "schedule": {"kind": "at", "atMs": reminder_due},
            "payload": {"kind": "agent_turn", "message": "remind me"},
            "state": {"nextRunAtMs": reminder_due},
            "createdAtMs": 1,
            "updatedAtMs": 1,
            "deleteAfterRun": False,
        },
        {
            "id": "hourly",
            "name": "check the shop",
            "enabled": True,
            "schedule": {"kind": "every", "everyMs": HOUR_MS},
            "payload": {"kind": "agent_turn", "message": "look at the orders"},
            "state": {"nextRunAtMs": hourly_due},
            "createdAtMs": 1,
            "updatedAtMs": 1,
            "deleteAfterRun": False,
        },
    ]
    path = root / "cron" / "jobs.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps({"version": 1, "jobs": jobs}).encode("utf-8"))
    return reminder_due, hourly_due


def jobs_on_disk(root: Path) -> dict[str, Any]:
    return {job["id"]: job for job in json.loads((root / "cron" / "jobs.json").read_text("utf-8"))["jobs"]}


def kill_a_firing(root: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(VICTIM), str(root)],
        cwd=ENGINE_ROOT,
        env={**os.environ, "PYTHONPATH": os.pathsep.join([str(ENGINE_ROOT / "tests"), str(ENGINE_ROOT)])},
        capture_output=True,
        timeout=120,
    )
    assert done.returncode == -9, done.stderr.decode("utf-8", "replace")


def inbound_ids(store: DotStore) -> list[str]:
    rows = store.read(lambda conn: conn.execute("SELECT id FROM dots_inbound ORDER BY accepted_order").fetchall())
    return [row["id"] for row in rows]


def all_answered(store: DotStore, count: int) -> bool:
    rows = store.read(lambda conn: conn.execute("SELECT state FROM dots_inbound").fetchall())
    return len(rows) == count and all(row["state"] == "applied" for row in rows)


def told_to_the_model(harness: EngineHarness) -> str:
    """What the person-side of the chat transcript says, as one text."""
    return "\n".join(str(row["content"]) for row in harness.messages() if row["role"] == "user")


async def start_engine(root: Path, script: list[ScriptEntry]) -> tuple[EngineHarness, DotStore]:
    """The engine and its cron service on the state a process left, wired as main.py wires them."""
    store = DotStore.open(root / "state" / "engine.sqlite")
    harness = EngineHarness(root, store, script)
    harness.cron.on_job = harness.engine.automation_fired
    harness.cron.on_next_wake = harness.engine.automations_next_run
    harness.engine.start()
    harness.configure(runtime_config_body(permissions=ALLOW_ALL))
    await harness.cron.start()
    return harness, store


async def finish(harness: EngineHarness, store: DotStore) -> None:
    harness.cron.stop()
    for engine in harness.engines:
        await engine.stop()
    store.close()


class TestAKilledProcessDoesNotRunAJobTwice:
    async def test_the_firing_it_recorded_is_not_run_again_and_the_one_it_never_reached_is_not_lost(
        self, tmp_path: Path
    ) -> None:
        reminder_due, hourly_due = seed_jobs(tmp_path, int(time.time() * 1000))

        kill_a_firing(tmp_path)

        # What the kill left: the firing is in the database, the job still says it is due.
        store = DotStore.open(tmp_path / "state" / "engine.sqlite")
        assert inbound_ids(store) == [f"cron:reminder:{reminder_due}"]
        store.close()
        before = jobs_on_disk(tmp_path)
        assert before["reminder"]["state"]["nextRunAtMs"] == reminder_due
        assert before["reminder"]["enabled"] is True

        harness, store = await start_engine(tmp_path, [says("done"), says("done")])
        try:
            await harness.wait_until(lambda: all_answered(store, 2))
            await harness.idle()

            # Each firing is one input, the killed one included, and the chat holds each exactly once.
            assert inbound_ids(store) == [f"cron:reminder:{reminder_due}", f"cron:hourly:{hourly_due}"]
            said = told_to_the_model(harness)
            assert said.count('[Automation "call the dentist" fired] remind me') == 1
            assert said.count('[Automation "check the shop" fired] look at the orders') == 1
        finally:
            await finish(harness, store)

        # Both ran, the one-time job is over, the hourly one is next due after now (one run, not a backlog).
        after = jobs_on_disk(tmp_path)
        assert after["reminder"]["enabled"] is False and after["reminder"]["state"]["nextRunAtMs"] is None
        assert after["hourly"]["state"]["nextRunAtMs"] > time.time() * 1000
        assert len(after["hourly"]["state"]["runHistory"]) == 1

    async def test_a_start_after_that_runs_nothing_again(self, tmp_path: Path) -> None:
        seed_jobs(tmp_path, int(time.time() * 1000))
        kill_a_firing(tmp_path)
        harness, store = await start_engine(tmp_path, [says("done"), says("done")])
        await harness.wait_until(lambda: all_answered(store, 2))
        await harness.idle()
        await finish(harness, store)

        harness, store = await start_engine(tmp_path, [says("must not be asked")])
        try:
            await harness.idle()
            assert harness.asked() == 0
            assert len(inbound_ids(store)) == 2
        finally:
            await finish(harness, store)

    async def test_the_host_is_told_when_the_next_one_is_due(self, tmp_path: Path) -> None:
        seed_jobs(tmp_path, int(time.time() * 1000))
        kill_a_firing(tmp_path)

        harness, store = await start_engine(tmp_path, [says("done"), says("done")])
        try:
            await harness.wait_until(lambda: all_answered(store, 2))
            await harness.idle()
            hourly_next = jobs_on_disk(tmp_path)["hourly"]["state"]["nextRunAtMs"]
            await harness.wait_until(
                lambda: bool(harness.events_of("automation.next_run"))
                and harness.events_of("automation.next_run")[-1]["next_run_at_ms"] == hourly_next
            )
            assert hourly_next > time.time() * 1000
        finally:
            await finish(harness, store)
