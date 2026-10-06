"""An engine that is killed in the middle of an automation firing; run by test_automation_catch_up.py.

It records the firing of the first due job in its database, as the engine does, and dies by SIGKILL on the spot:
before the cron service could save that the job ran and moved its next run. What is left on disk is what a
`kill -9` (or a power cut) at that moment leaves: the engine's database holds the firing, jobs.json still says
the job is due.

Usage: python automation_victim.py <directory that holds state/engine.sqlite and cron/jobs.json>
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path

from fakes.engine_harness import EngineHarness

from nanobot.cron.types import CronJob
from nanobot.dots.store import DotStore


async def main(root: Path) -> None:
    store = DotStore.open(root / "state" / "engine.sqlite")
    harness = EngineHarness(root, store, [], key=False)

    async def fire_then_die(job: CronJob) -> None:
        await harness.engine.automation_fired(job)
        os.kill(os.getpid(), signal.SIGKILL)

    harness.cron.on_job = fire_then_die
    harness.cron.on_next_wake = harness.engine.automations_next_run
    harness.engine.start()
    await harness.cron.start()
    await asyncio.sleep(60)
    sys.exit("the victim was not killed")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
