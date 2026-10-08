"""Write the engine state a Dot of a release leaves, for tests/dots/test_upgrade.py.

Run it with the engine's Python from the invisible_engine_dots directory of a checkout of the release
(a worktree of its tag), giving it this directory's folder for the release:

    python -I <this file> <path to tests/fixtures/upgrade/<release tag>>

It drives that release's own engine through a chat, a task, an automation, a rejected and a pending
approval and a browser identity, and writes engine.sql (the SQLite dump) and cron-jobs.json.
"""

from __future__ import annotations

import asyncio
import shutil
import sqlite3
import sys
from pathlib import Path
from threading import Thread

sys.path.insert(0, "tests")

import nanobot.utils.token_encoding as token_encoding  # noqa: E402

token_encoding._encoding = None
token_encoding._warmup_thread = Thread()

from fakes.dot_config import runtime_config_body  # noqa: E402
from fakes.engine_harness import EngineHarness, decision, task_created, user_message  # noqa: E402
from fakes.scripted_provider import call, calls, says  # noqa: E402

from nanobot.dots import store as s  # noqa: E402
from nanobot.dots.store import DotStore  # noqa: E402

PERMISSIONS = {"computer.exec": "allow", "files.read": "allow", "files.write": "ask", "automations": "allow"}


async def main(out: Path) -> None:
    work = out / "work"
    shutil.rmtree(work, ignore_errors=True)
    store = DotStore.open(work / "state" / "engine.sqlite")
    h = EngineHarness(work, store, [])
    # The automations' service runs, as in the guest, so an added job is in jobs.json.
    await h.cron.start()
    h.engine.start()
    h.configure(runtime_config_body(permissions=PERMISSIONS))

    # A chat that remembers something.
    h.provider.script = [says("Noted: your favourite colour is teal.")]
    h.engine.accept(user_message("m1", "Remember: my favourite colour is teal."))
    await h.idle()

    # A task that ran a command and completed.
    h.provider.script = [calls(call("c1", "exec", command="ls /home/dot/workspace")), says("The workspace is listed.")]
    h.engine.accept(task_created("t-done", "List the workspace."))
    await h.idle()

    # An automation the chat added.
    h.provider.script = [
        calls(call("c2", "cron", action="add", message="Water the plants", every_seconds=86400)),
        says("I will remind you every day."),
    ]
    h.engine.accept(user_message("m2", "Remind me every day to water the plants."))
    await h.idle()

    # A chat write that was rejected: the approval is done.
    h.provider.script = [calls(call("c3", "write_file", path="note.txt", content="draft")), says("Understood, I will not write it.")]
    h.engine.accept(user_message("m3", "Write a note."))
    await h.idle()
    (rejected,) = h.pending_approvals()
    h.engine.accept(decision("d1", rejected.approval_id, "reject", "not now"))
    await h.idle()

    # A task whose write still waits for its decision when the Dot is upgraded.
    h.provider.script = [calls(call("c4", "write_file", path="upgrade.txt", content="written after the upgrade"))]
    h.engine.accept(task_created("t-wait", "Write upgrade.txt."))
    await h.idle()
    (waiting,) = h.pending_approvals()

    # A browser identity with a used profile.
    store.write(lambda conn: s.insert_identity(conn, identity_id="idn_work", name="work", proxy=None, now_ms=1_700_000_000_000))
    store.write(lambda conn: s.touch_identity(conn, "idn_work", now_ms=1_700_000_100_000))

    await h.engine.stop()
    h.cron.stop()
    store.close()

    database = sqlite3.connect(work / "state" / "engine.sqlite")
    (out / "engine.sql").write_text("\n".join(database.iterdump()) + "\n", encoding="utf-8", newline="\n")
    database.close()
    shutil.copyfile(work / "cron" / "jobs.json", out / "cron-jobs.json")
    shutil.rmtree(work)
    print("pending approval", waiting.approval_id)


asyncio.run(main(Path(sys.argv[1]).resolve()))
