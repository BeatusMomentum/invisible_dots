"""A Dot's state written by a released engine opens, and goes on working, under this engine.

A Dot keeps its disk across upgrades while every start of its computer runs the newest engine, so the
engine database and the automations file a release left must still work here. Each directory of
tests/fixtures/upgrade holds what one release wrote (made by make_engine_state.py run from that release's
checkout): a chat that remembered something, a completed task, an automation, a rejected chat write,
a task whose write still waits for its decision, and a browser identity.
"""

from __future__ import annotations

import shutil
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fakes.engine_harness import EngineHarness, decision, user_message
from fakes.scripted_provider import call, calls, says

from nanobot.dots import store as s
from nanobot.dots.store import DotStore

FIXTURES = Path(__file__).parent.parent / "fixtures" / "upgrade"
RELEASES = sorted(path.name for path in FIXTURES.iterdir() if path.is_dir())


@pytest.fixture(params=RELEASES)
def upgraded(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[EngineHarness]:
    """The engine of this checkout started on the state a release left."""
    release = FIXTURES / request.param
    database = tmp_path / "state" / "engine.sqlite"
    database.parent.mkdir(parents=True)
    with sqlite3.connect(database) as conn:
        conn.executescript((release / "engine.sql").read_text(encoding="utf-8"))
    conn.close()
    (tmp_path / "cron").mkdir()
    shutil.copyfile(release / "cron-jobs.json", tmp_path / "cron" / "jobs.json")
    store = DotStore.open(database)
    h = EngineHarness(tmp_path, store, [])
    yield h
    store.close()


def test_the_release_left_what_these_tests_upgrade(upgraded: EngineHarness) -> None:
    assert RELEASES, "no release state to upgrade from"
    h = upgraded
    assert [task.status for task in map(h.task, ("t-done", "t-wait"))] == ["completed", "running"]
    assert len(h.pending_approvals()) == 1


async def test_a_task_waiting_for_its_decision_through_the_upgrade_runs_its_call_once_approved(
    upgraded: EngineHarness,
) -> None:
    h = upgraded
    (waiting,) = h.pending_approvals()
    h.engine.start()
    # The config the release was pushed is the one the upgraded engine works with, before any push.
    assert h.engine.config is not None and h.engine.config.name == "fare-watch"
    assert h.engine.state_answer().pending_approval == waiting.approval_id

    h.provider.script = [calls(call("c5", "write_file", **waiting.arguments)), says("Written.")]
    h.engine.accept(decision("d-up", waiting.approval_id, "approve"))
    await h.idle()

    written = h.tmp_path / "home" / "dot" / "workspace" / "upgrade.txt"
    assert written.read_text(encoding="utf-8") == "written after the upgrade"
    assert h.task("t-wait").status == "completed"
    assert h.approval(waiting.approval_id).status == "done"
    assert h.engine.state_answer().pending_approval is None


async def test_the_chat_goes_on_from_the_history_the_release_kept(upgraded: EngineHarness) -> None:
    h = upgraded
    last_seq = h.store.read(lambda conn: conn.execute("SELECT MAX(seq) FROM dots_outbox").fetchone()[0])
    h.provider.script = [says("Teal.")]
    h.engine.start()
    h.engine.accept(user_message("m-up", "What is my favourite colour?"))
    await h.idle()

    request = h.provider.requests[-1]
    said = " ".join(str(m.get("content")) for m in request["messages"])
    assert "my favourite colour is teal" in said
    assert "Remind me every day to water the plants." in said
    answers = [e for e in h.events() if e["type"] == "message.assistant"]
    assert answers[-1]["data"]["text"] == "Teal."
    # The outbox goes on after the release's last event: the host's cursor still finds every new one.
    new = h.store.read(lambda conn: s.read_outbox_after(conn, last_seq, 1000))
    assert new and all(event["seq"] > last_seq for event in new)


def test_the_identity_and_the_automation_the_release_kept_are_there(upgraded: EngineHarness) -> None:
    h = upgraded
    identity = h.store.read(lambda conn: s.get_identity(conn, "idn_work"))
    assert identity is not None and identity.name == "work"
    assert [job.payload.message for job in h.cron.list_jobs()] == ["Water the plants"]
