"""The Dot's database: the outbox, inbound events, the task queue, intents, approvals, decisions, transcripts."""

from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fakes.store_queries import last_seq

from nanobot.dots import store as s
from nanobot.dots.store import SCHEMA_VERSION, DotStore, StoreOwnedError, StoreVersionError

TS = "2026-10-04T10:00:00.000Z"


def inbound(inbound_id: str, type_: str = "user.message", data: dict | None = None) -> dict:
    return {"id": inbound_id, "type": type_, "ts": TS, "data": data if data is not None else {"text": inbound_id}}


class TestOpen:
    def test_creates_the_parent_directory_and_the_tables(self, tmp_path: Path) -> None:
        store = DotStore.open(tmp_path / "a" / "b" / "engine.sqlite")
        try:
            names = store.read(
                lambda c: {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            )
        finally:
            store.close()
        assert {
            "dots_outbox",
            "dots_inbound",
            "dots_tasks",
            "dots_tool_intents",
            "dots_kv",
            "dots_approvals",
            "dots_tool_decisions",
            "sessions",
            "messages",
        } <= names

    def test_every_table_is_strict(self, dot_store: DotStore) -> None:
        rows = dot_store.read(lambda c: c.execute("PRAGMA table_list").fetchall())
        user_tables = [r for r in rows if r["schema"] == "main" and not r["name"].startswith("sqlite_")]
        assert len(user_tables) == 9
        assert all(r["strict"] == 1 for r in user_tables)

    def test_the_connection_is_wal_full_and_exclusive(self, dot_store: DotStore) -> None:
        def pragmas(c: sqlite3.Connection) -> tuple[str, int, str]:
            return (
                c.execute("PRAGMA journal_mode").fetchone()[0],
                c.execute("PRAGMA synchronous").fetchone()[0],
                c.execute("PRAGMA locking_mode").fetchone()[0],
            )

        assert dot_store.read(pragmas) == ("wal", 2, "exclusive")

    def test_reopening_after_close_keeps_the_rows(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        first = DotStore.open(path)
        first.write(lambda c: s.append_outbox(c, "agent.started", {}))
        first.close()
        second = DotStore.open(path)
        try:
            assert second.read(last_seq) == 1
        finally:
            second.close()

    def test_a_second_open_on_the_same_file_fails_naming_the_owner(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        first = DotStore.open(path)
        try:
            with pytest.raises(StoreOwnedError, match=re.escape(f"another engine owns {path}")):
                DotStore.open(path, open_timeout_s=0)
            # The owner is not disturbed by the attempt.
            first.write(lambda c: s.append_outbox(c, "agent.started", {}))
            assert first.read(last_seq) == 1
        finally:
            first.close()

    def test_the_file_is_free_again_once_the_owner_closes(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        DotStore.open(path).close()
        DotStore.open(path, open_timeout_s=0).close()

    def test_a_new_file_is_stamped_with_the_schema_version(self, tmp_path: Path) -> None:
        store = DotStore.open(tmp_path / "engine.sqlite")
        try:
            assert store.read(lambda c: c.execute("PRAGMA user_version").fetchone()[0]) == SCHEMA_VERSION
        finally:
            store.close()
        assert SCHEMA_VERSION > 0, "0 is what a file made before versions existed carries"

    def test_a_file_of_the_same_version_opens_and_keeps_its_rows(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        first = DotStore.open(path)
        first.write(lambda c: s.append_outbox(c, "agent.started", {}))
        first.close()

        second = DotStore.open(path)
        try:
            assert second.read(last_seq) == 1
            assert second.read(lambda c: c.execute("PRAGMA user_version").fetchone()[0]) == SCHEMA_VERSION
        finally:
            second.close()

    @staticmethod
    def a_file_with_tables_and_version(path: Path, version: int) -> None:
        raw = sqlite3.connect(path)
        try:
            raw.execute("CREATE TABLE dots_kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
            raw.execute("INSERT INTO dots_kv VALUES ('config', '{}')")
            raw.execute(f"PRAGMA user_version = {version}")
            raw.commit()
        finally:
            raw.close()

    @pytest.mark.parametrize("version", [0, SCHEMA_VERSION + 1, 99])
    def test_a_file_of_another_version_is_refused_and_left_as_it_was(self, tmp_path: Path, version: int) -> None:
        # Version 0 with tables is what an engine built before versions existed left.
        path = tmp_path / "engine.sqlite"
        self.a_file_with_tables_and_version(path, version)

        with pytest.raises(StoreVersionError, match="the engine database was made by another engine version") as raised:
            DotStore.open(path)
        assert str(path) in str(raised.value)

        raw = sqlite3.connect(path)
        try:
            # Nothing was written to it, not even the journal mode the engine sets on a file it accepts.
            assert raw.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
            assert raw.execute("PRAGMA user_version").fetchone()[0] == version
            assert [r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type = 'table'")] == ["dots_kv"]
            assert raw.execute("SELECT value_json FROM dots_kv").fetchall() == [("{}",)]
        finally:
            raw.close()

    def test_a_refused_file_is_not_left_locked(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        self.a_file_with_tables_and_version(path, 0)
        with pytest.raises(StoreVersionError):
            DotStore.open(path, open_timeout_s=0)
        raw = sqlite3.connect(path, timeout=0)
        raw.execute("BEGIN IMMEDIATE")
        raw.close()

    @pytest.mark.parametrize("state", ["fresh", "delete-mode"])
    def test_the_layout_check_holds_no_lock_when_it_returns(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, state: str
    ) -> None:
        # A shared lock the check kept would be held until the engine's WAL switch, and two engines
        # opening one file at once would each hold it and each fail that switch: both refused.
        path = tmp_path / "engine.sqlite"
        if state == "delete-mode":
            DotStore.open(path).close()
            raw = sqlite3.connect(path)
            raw.execute("PRAGMA journal_mode=DELETE")
            raw.close()
        check = s._check_layout
        probes: list[str] = []

        def probing_check(*args: object, **kwargs: object) -> object:
            result = check(*args, **kwargs)
            other = sqlite3.connect(path, isolation_level=None, timeout=0)
            try:
                other.execute("BEGIN EXCLUSIVE")
                other.execute("ROLLBACK")
                probes.append("free")
            except sqlite3.OperationalError:
                probes.append("held")
            finally:
                other.close()
            return result

        monkeypatch.setattr(s, "_check_layout", probing_check)
        DotStore.open(path).close()
        assert probes == ["free"]

    @pytest.mark.parametrize("round_", range(3))
    def test_of_two_engines_opening_one_file_at_once_exactly_one_wins(self, tmp_path: Path, round_: int) -> None:
        # Two processes released at the same instant on a fresh file: the loser is refused as owned, not both.
        # A winner keeps its store open until stdin closes, so the loser meets a held file.
        child = "\n".join(
            [
                "import sys, time",
                "from nanobot.dots import store as s",
                "from nanobot.dots.store import DotStore, StoreOwnedError",
                # The layout check made slow, so that both engines are inside it together:
                # whatever it still holds when it returns is held while the other one tries.
                "check = s._check_layout",
                "def slow_check(*args, **kwargs):",
                "    result = check(*args, **kwargs)",
                "    time.sleep(0.4)",
                "    return result",
                "s._check_layout = slow_check",
                "start = float(sys.argv[2])",
                "while time.time() < start: pass",
                "try:",
                "    store = DotStore.open(sys.argv[1], open_timeout_s=0.5)",
                "except StoreOwnedError:",
                "    print('owned', flush=True); sys.exit(0)",
                "print('won', flush=True)",
                "sys.stdin.read()",
                "store.close()",
            ]
        )
        path = tmp_path / "engine.sqlite"
        start = time.time() + 1.5
        procs = [
            subprocess.Popen(
                [sys.executable, "-c", child, str(path), str(start)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
            )
            for _ in range(2)
        ]
        try:
            results = sorted(proc.stdout.readline().strip() for proc in procs)  # type: ignore[union-attr]
        finally:
            for proc in procs:
                proc.stdin.close()  # type: ignore[union-attr]
            for proc in procs:
                proc.wait(timeout=30)
        assert results == ["owned", "won"]

    def test_a_closed_store_refuses_work(self, tmp_path: Path) -> None:
        store = DotStore.open(tmp_path / "engine.sqlite")
        store.close()
        store.close()
        with pytest.raises(RuntimeError, match="is closed"):
            store.read(last_seq)


class TestOutbox:
    def test_numbers_events_in_commit_order_and_reads_them_back_after_a_seq(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))
        dot_store.write(lambda c: s.append_outbox(c, "agent.state", {"state": "IDLE"}))
        dot_store.write(lambda c: s.append_outbox(c, "message.assistant", {"text": "hi"}))
        events = dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))
        assert [e["seq"] for e in events] == [1, 2, 3]
        assert [e["type"] for e in events] == ["agent.started", "agent.state", "message.assistant"]
        assert [e["data"] for e in dot_store.read(lambda c: s.read_outbox_after(c, 2, 10))] == [{"text": "hi"}]
        assert len(dot_store.read(lambda c: s.read_outbox_after(c, 0, 2))) == 2
        assert dot_store.read(last_seq) == 3

    def test_writes_nothing_for_a_transaction_that_rolls_back_and_never_reuses_a_committed_seq(
        self, dot_store: DotStore
    ) -> None:
        dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))

        def failing(c: sqlite3.Connection) -> None:
            s.append_outbox(c, "agent.state", {"state": "THINKING"})
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            dot_store.write(failing)
        assert [e["seq"] for e in dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))] == [1]
        dot_store.write(lambda c: s.append_outbox(c, "agent.state", {"state": "IDLE"}))
        dot_store.write(lambda c: c.execute("DELETE FROM dots_outbox WHERE seq = 2"))
        assert dot_store.write(lambda c: s.append_outbox(c, "agent.state", {"state": "DONE"}))["seq"] == 3

    def test_an_event_has_an_id_and_a_utc_timestamp_with_milliseconds(self, dot_store: DotStore) -> None:
        moment = datetime(2026, 10, 4, 12, 30, 5, 123456, tzinfo=timezone.utc)
        event = dot_store.write(lambda c: s.append_outbox(c, "agent.started", {"a": 1}, now=moment))
        assert event["ts"] == "2026-10-04T12:30:05.123Z"
        assert event["data"] == {"a": 1}
        assert len(event["id"]) == 36
        stored = dot_store.read(lambda c: s.read_outbox_after(c, 0, 1))[0]
        assert stored == event

    def test_refuses_a_type_the_host_does_not_know(self, dot_store: DotStore) -> None:
        with pytest.raises(ValueError, match="not an outbound event type"):
            dot_store.write(lambda c: s.append_outbox(c, "user.message", {}))
        assert dot_store.read(last_seq) == 0

    def test_keeps_non_ascii_text_and_lone_surrogates(self, dot_store: DotStore) -> None:
        text = "caf\u00e9 \u4e2d\u6587 \ud800"
        dot_store.write(lambda c: s.append_outbox(c, "message.assistant", {"text": text}))
        assert dot_store.read(lambda c: s.read_outbox_after(c, 0, 1))[0]["data"]["text"] == text

    def test_records_an_agent_state_once_and_again_only_when_forced(self, dot_store: DotStore) -> None:
        assert dot_store.write(lambda c: s.record_agent_state(c, "IDLE")) is True
        assert dot_store.write(lambda c: s.record_agent_state(c, "IDLE")) is False
        assert dot_store.write(lambda c: s.record_agent_state(c, "IDLE", force=True)) is True
        assert len(dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))) == 2
        assert dot_store.read(lambda c: s.read_kv(c, s.KV_AGENT_STATE)) == "IDLE"

    def test_refuses_a_state_the_host_does_not_know(self, dot_store: DotStore) -> None:
        with pytest.raises(ValueError, match="not an agent state"):
            dot_store.write(lambda c: s.record_agent_state(c, "SLEEPING"))


class TestOutboxListeners:
    def test_is_called_once_after_a_commit_that_added_rows(self, dot_store: DotStore) -> None:
        calls: list[int] = []
        dot_store.on_append(lambda: calls.append(dot_store.read(last_seq)))

        def two_events(c: sqlite3.Connection) -> None:
            s.append_outbox(c, "agent.started", {})
            s.append_outbox(c, "agent.state", {"state": "IDLE"})

        dot_store.write(two_events)
        # The listener runs after the commit: it sees both rows, and runs once.
        assert calls == [2]

    def test_is_not_called_for_a_commit_that_added_none_or_that_rolled_back(self, dot_store: DotStore) -> None:
        calls: list[int] = []
        dot_store.on_append(lambda: calls.append(1))
        dot_store.write(lambda c: s.write_kv(c, "k", 1))

        def failing(c: sqlite3.Connection) -> None:
            s.append_outbox(c, "agent.started", {})
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            dot_store.write(failing)
        assert calls == []

    def test_a_failing_listener_does_not_break_the_write_or_the_others(self, dot_store: DotStore) -> None:
        calls: list[str] = []

        def broken() -> None:
            raise RuntimeError("listener bug")

        dot_store.on_append(broken)
        dot_store.on_append(lambda: calls.append("second"))
        event = dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))
        assert event["seq"] == 1
        assert calls == ["second"]

    def test_a_removed_listener_is_not_called(self, dot_store: DotStore) -> None:
        calls: list[int] = []
        remove = dot_store.on_append(lambda: calls.append(1))
        remove()
        remove()
        dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))
        assert calls == []


class TestWrite:
    def test_a_write_inside_a_write_is_refused(self, dot_store: DotStore) -> None:
        with pytest.raises(sqlite3.OperationalError, match="within a transaction"):
            dot_store.write(lambda c: dot_store.write(lambda c2: None))
        # The outer transaction is rolled back and the store still works.
        assert dot_store.write(lambda c: 5) == 5

    def test_returns_what_the_function_returns(self, dot_store: DotStore) -> None:
        assert dot_store.write(lambda c: "result") == "result"

    def test_a_base_exception_rolls_back_too(self, dot_store: DotStore) -> None:
        def cancelled(c: sqlite3.Connection) -> None:
            s.append_outbox(c, "agent.started", {})
            raise KeyboardInterrupt

        with pytest.raises(KeyboardInterrupt):
            dot_store.write(cancelled)
        assert dot_store.read(last_seq) == 0

    def test_a_checkpoint_empties_the_wal(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))
        dot_store.checkpoint()
        wal = Path(str(dot_store.path) + "-wal")
        assert not wal.exists() or wal.stat().st_size == 0


class TestInbound:
    def test_accepts_an_event_id_once(self, dot_store: DotStore) -> None:
        event = inbound("e1", data={"text": "hello"})
        assert dot_store.write(lambda c: s.record_inbound(c, event, "accepted")) is True
        assert dot_store.write(lambda c: s.record_inbound(c, event, "accepted")) is False
        rows = dot_store.read(lambda c: s.list_inbound(c, "accepted"))
        assert [r.id for r in rows] == ["e1"]
        assert rows[0].data == {"text": "hello"} and rows[0].type == "user.message" and rows[0].ts == TS

    def test_moves_a_user_message_to_the_transcript_then_applies_every_one_the_transcript_holds(
        self, dot_store: DotStore
    ) -> None:
        for inbound_id in ("a", "b", "c"):
            dot_store.write(lambda c, i=inbound_id: s.record_inbound(c, inbound(i), "accepted"))
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "a")) is True
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "a")) is False
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "b")) is True
        assert dot_store.write(s.apply_answered_inputs) == ["a", "b"]
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "applied"))] == ["a", "b"]
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "accepted"))] == ["c"]
        assert dot_store.write(s.apply_answered_inputs) == []

    def test_does_not_move_other_inbound_types_to_the_transcript(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("x", "approval.received", {}), "accepted"))
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "x")) is False

    def test_an_automation_firing_is_applied_with_the_messages_but_never_named(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("m1"), "accepted"))
        dot_store.write(lambda c: s.record_inbound(c, inbound("cron:j:1", "automation.fired", {"name": "n"}), "accepted"))
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "cron:j:1")) is True
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "m1")) is True
        assert dot_store.write(s.apply_answered_inputs) == ["m1"]
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "applied"))] == ["m1", "cron:j:1"]

    def test_an_automation_alone_applies_and_names_nobody(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("cron:j:2", "automation.fired", {}), "accepted"))
        dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "cron:j:2"))
        assert dot_store.write(s.apply_answered_inputs) == []
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "applied"))] == ["cron:j:2"]

    def test_lists_in_the_order_they_were_accepted(self, dot_store: DotStore) -> None:
        for inbound_id in ("z", "a", "m"):
            dot_store.write(lambda c, i=inbound_id: s.record_inbound(c, inbound(i), "accepted"))
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "accepted"))] == ["z", "a", "m"]

    def test_refuses_a_type_it_does_not_store(self, dot_store: DotStore) -> None:
        with pytest.raises(ValueError, match="not an inbound event type"):
            dot_store.write(lambda c: s.record_inbound(c, inbound("x", "message.assistant", {}), "accepted"))

    def test_an_event_recorded_as_applied_has_its_time(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("e"), "applied", now_ms=1234))
        row = dot_store.read(lambda c: c.execute("SELECT accepted_at, applied_at FROM dots_inbound").fetchone())
        assert (row["accepted_at"], row["applied_at"]) == (1234, 1234)


class TestTasks:
    def test_runs_the_highest_priority_first_then_the_oldest(self, dot_store: DotStore) -> None:
        def enqueue(task_id: str, priority: int, description: str = "d") -> bool:
            return dot_store.write(
                lambda c: s.enqueue_task(c, task_id=task_id, description=description, priority=priority)
            )

        enqueue("low", 0)
        enqueue("high-old", 5)
        enqueue("high-new", 5)
        assert enqueue("low", 9, "again") is False
        assert dot_store.read(s.next_queued_task).task_id == "high-old"
        dot_store.write(lambda c: s.start_task(c, "high-old"))
        assert dot_store.read(s.next_queued_task).task_id == "high-new"
        started = dot_store.read(lambda c: s.get_task(c, "high-old"))
        assert (started.status, started.attempts) == ("running", 1)
        assert dot_store.read(lambda c: s.get_task_by_session(c, s.task_session_key("low"))).task_id == "low"
        assert dot_store.read(lambda c: s.get_task(c, "low")).description == "d"
        assert dot_store.read(s.get_running_task).task_id == "high-old"

    def test_there_is_no_next_task_and_no_running_task_in_an_empty_queue(self, dot_store: DotStore) -> None:
        assert dot_store.read(s.next_queued_task) is None
        assert dot_store.read(s.get_running_task) is None
        assert dot_store.read(lambda c: s.get_task(c, "nope")) is None
        assert dot_store.read(lambda c: s.get_task_by_session(c, "task:nope")) is None

    def test_ends_a_task_once(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        dot_store.write(lambda c: s.start_task(c, "t"))
        assert dot_store.write(lambda c: s.finish_task(c, "t", "cancelled")) is True
        assert dot_store.write(lambda c: s.finish_task(c, "t", "completed", summary="late")) is False
        assert dot_store.read(lambda c: s.get_task(c, "t")).status == "cancelled"

    def test_a_queued_task_can_be_cancelled(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        assert dot_store.write(lambda c: s.finish_task(c, "t", "cancelled")) is True

    def test_a_completion_needs_a_summary_and_a_failure_an_error(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        with pytest.raises(ValueError, match="summary"):
            dot_store.write(lambda c: s.finish_task(c, "t", "completed"))
        with pytest.raises(ValueError, match="error"):
            dot_store.write(lambda c: s.finish_task(c, "t", "failed"))
        assert dot_store.write(lambda c: s.finish_task(c, "t", "failed", error="it broke")) is True
        row = dot_store.read(lambda c: c.execute("SELECT status, summary, error FROM dots_tasks").fetchone())
        assert (row["status"], row["summary"], row["error"]) == ("failed", None, "it broke")

    def test_gives_back_an_attempt_abandoned_by_a_sleep(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        dot_store.write(lambda c: s.start_task(c, "t"))
        dot_store.write(lambda c: s.uncount_task_attempt(c, "t"))
        assert dot_store.read(lambda c: s.get_task(c, "t")).attempts == 0
        dot_store.write(lambda c: s.uncount_task_attempt(c, "t"))
        assert dot_store.read(lambda c: s.get_task(c, "t")).attempts == 0

    def test_every_start_counts_an_attempt(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        for expected in (1, 2, 3):
            dot_store.write(lambda c: s.start_task(c, "t"))
            assert dot_store.read(lambda c: s.get_task(c, "t")).attempts == expected


class TestKv:
    def test_reads_back_what_was_written_and_a_default_when_missing(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.read_kv(c, "k")) is None
        assert dot_store.read(lambda c: s.read_kv(c, "k", "fallback")) == "fallback"
        dot_store.write(lambda c: s.write_kv(c, "k", {"a": [1, 2]}))
        dot_store.write(lambda c: s.write_kv(c, "k", {"a": [3]}))
        assert dot_store.read(lambda c: s.read_kv(c, "k")) == {"a": [3]}


class TestToolIntents:
    def test_keeps_the_first_start_of_a_call_hands_it_back_once_and_clears_what_is_left(
        self, dot_store: DotStore
    ) -> None:
        intent = s.ToolIntent("c1", "exec", "s", None, 100)
        dot_store.write(lambda c: s.record_tool_intent(c, intent))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c1", "exec", "s", None, 999)))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c2", "exec", "s", "t1", 200)))
        taken = dot_store.write(lambda c: s.take_tool_intent(c, "s", "c1"))
        assert taken == intent
        assert dot_store.write(lambda c: s.take_tool_intent(c, "s", "c1")) is None
        left = dot_store.write(s.take_all_tool_intents)
        assert [(i.tool_call_id, i.task_id) for i in left] == [("c2", "t1")]
        assert dot_store.write(s.take_all_tool_intents) == []

    def test_listing_the_intents_leaves_them_in_place_oldest_first(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("late", "exec", "s", None, 300)))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("early", "exec", "t", "t1", 100)))
        listed = dot_store.read(s.list_tool_intents)
        assert [(i.tool_call_id, i.session_key) for i in listed] == [("early", "t"), ("late", "s")]
        assert dot_store.read(s.list_tool_intents) == listed


class TestCanonicalArguments:
    def test_ignores_key_order_at_every_level(self) -> None:
        assert s.canonical_arguments({"b": 1, "a": {"d": 2, "c": [{"y": 1, "x": 2}]}}) == s.canonical_arguments(
            {"a": {"c": [{"x": 2, "y": 1}], "d": 2}, "b": 1}
        )
        assert s.canonical_arguments({"a": [1, 2]}) != s.canonical_arguments({"a": [2, 1]})
        assert s.canonical_arguments({"a": 1}) == '{"a":1}'


class TestApprovals:
    def request(self, store: DotStore, tool_call_id: str = "call-1", session_key: str = "chat") -> tuple[s.Approval, bool]:
        return store.write(
            lambda c: s.request_approval(
                c,
                session_key=session_key,
                task_id=None,
                tool_call_id=tool_call_id,
                tool="exec",
                permission="computer.exec",
                arguments={"command": "ls", "n": [1, {"b": 2}]},
            )
        )

    def test_creates_one_pending_approval_per_call(self, dot_store: DotStore) -> None:
        approval, created = self.request(dot_store)
        again, created_again = self.request(dot_store)
        assert created is True and created_again is False
        assert again == approval
        assert approval.approval_id.startswith("appr_")
        assert (approval.status, approval.note, approval.run_tool_call_id, approval.resolved_at) == ("pending", None, None, None)
        assert approval.arguments == {"command": "ls", "n": [1, {"b": 2}]}

    def test_each_call_gets_its_own_id(self, dot_store: DotStore) -> None:
        first, _ = self.request(dot_store, "call-1")
        second, _ = self.request(dot_store, "call-2")
        assert first.approval_id != second.approval_id
        assert [a.tool_call_id for a in dot_store.read(lambda c: s.list_approvals(c, "pending"))] == ["call-1", "call-2"]

    def test_advances_only_from_the_status_it_is_in(self, dot_store: DotStore) -> None:
        approval, _ = self.request(dot_store)
        aid = approval.approval_id
        assert dot_store.write(lambda c: s.advance_approval(c, aid, "approved", "granted")) is False
        assert dot_store.write(lambda c: s.advance_approval(c, aid, "pending", "approved", note="go", now_ms=77)) is True
        assert dot_store.write(lambda c: s.advance_approval(c, aid, "pending", "rejected")) is False
        approved = dot_store.read(lambda c: s.get_approval(c, aid))
        assert (approved.status, approved.note, approved.resolved_at) == ("approved", "go", 77)
        assert dot_store.write(lambda c: s.advance_approval(c, aid, "approved", "granted")) is True
        granted = dot_store.read(lambda c: s.get_approval(c, aid))
        # The note and the time of the decision survive the later steps.
        assert (granted.status, granted.note, granted.resolved_at) == ("granted", "go", 77)

    def test_the_run_ends_when_the_result_reaches_the_transcript(self, dot_store: DotStore) -> None:
        approval, _ = self.request(dot_store)
        aid = approval.approval_id
        for before, after in (("pending", "approved"), ("approved", "granted")):
            dot_store.write(lambda c, b=before, a=after: s.advance_approval(c, aid, b, a))
        dot_store.write(lambda c: s.advance_approval(c, aid, "granted", "running", run_tool_call_id="call-2"))
        assert dot_store.write(lambda c: s.finish_approval_run(c, "chat", "call-9")) is False
        assert dot_store.write(lambda c: s.finish_approval_run(c, "chat", "call-2")) is True
        assert dot_store.write(lambda c: s.finish_approval_run(c, "chat", "call-2")) is False
        done = dot_store.read(lambda c: s.get_approval(c, aid))
        assert (done.status, done.run_tool_call_id) == ("done", "call-2")

    def test_an_approval_holds_its_session_until_it_is_done(self, dot_store: DotStore) -> None:
        approval, _ = self.request(dot_store, session_key="task:t1")
        aid = approval.approval_id
        assert dot_store.read(lambda c: s.open_approval_for_session(c, "task:t1")).approval_id == aid
        assert dot_store.read(lambda c: s.open_approval_for_session(c, "chat")) is None
        for before, after in (("pending", "rejected"), ("rejected", "told")):
            dot_store.write(lambda c, b=before, a=after: s.advance_approval(c, aid, b, a))
        assert dot_store.read(lambda c: s.open_approval_for_session(c, "task:t1")) is not None
        dot_store.write(lambda c: s.advance_approval(c, aid, "told", "done"))
        assert dot_store.read(lambda c: s.open_approval_for_session(c, "task:t1")) is None

    def test_an_unknown_approval_is_none(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.get_approval(c, "appr_nope")) is None


class TestToolDecisions:
    def test_a_decision_is_handed_back_once(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, "chat", "c1", "park"))
        assert dot_store.read(lambda c: s.peek_tool_decision(c, "chat", "c1")) == "park"
        assert dot_store.read(lambda c: s.peek_tool_decision(c, "chat", "c1")) == "park"
        assert dot_store.write(lambda c: s.take_tool_decision(c, "chat", "c1")) == "park"
        assert dot_store.write(lambda c: s.take_tool_decision(c, "chat", "c1")) is None
        assert dot_store.read(lambda c: s.peek_tool_decision(c, "chat", "c1")) is None

    def test_a_later_decision_replaces_the_earlier_one(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, "chat", "c1", "deny"))
        dot_store.write(lambda c: s.record_tool_decision(c, "chat", "c1", "skipped"))
        assert dot_store.write(lambda c: s.take_tool_decision(c, "chat", "c1")) == "skipped"

    def test_refuses_a_decision_it_does_not_know(self, dot_store: DotStore) -> None:
        with pytest.raises(ValueError, match="not a tool decision"):
            dot_store.write(lambda c: s.record_tool_decision(c, "chat", "c1", "allow"))  # type: ignore[arg-type]


class TestTranscripts:
    def test_appends_in_order_and_reads_back(self, dot_store: DotStore) -> None:
        first = {"role": "user", "content": "one"}
        second = {"role": "assistant", "content": None, "tool_calls": [{"id": "x", "type": "function"}]}
        third = {"role": "tool", "tool_call_id": "x", "name": "exec", "content": "ok"}
        dot_store.write(lambda c: s.append_messages(c, "chat", [first, second], final_index=None))
        dot_store.write(lambda c: s.append_messages(c, "chat", [third], final_index=None))
        dot_store.write(lambda c: s.append_messages(c, "task:t1", [{"role": "user", "content": "other"}], final_index=None))
        assert dot_store.read(lambda c: s.read_messages(c, "chat")) == [first, second, third]
        assert dot_store.read(lambda c: s.read_messages(c, "task:t1")) == [{"role": "user", "content": "other"}]
        assert dot_store.read(lambda c: s.read_messages(c, "task:none")) == []
        indices = dot_store.read(lambda c: [r[0] for r in c.execute("SELECT idx FROM messages WHERE session_key = 'chat' ORDER BY idx")])
        assert indices == [0, 1, 2]

    def test_a_rolled_back_transaction_leaves_no_message_and_no_outbox_row(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("m1"), "in_transcript"))

        def failing(c: sqlite3.Connection) -> None:
            s.append_messages(
                c, "chat", [{"role": "user", "content": "x"}, {"role": "assistant", "content": "answer"}], final_index=1
            )
            raise RuntimeError("the next commit point failed")

        with pytest.raises(RuntimeError):
            dot_store.write(failing)
        assert dot_store.read(lambda c: s.read_messages(c, "chat")) == []
        assert dot_store.read(lambda c: s.read_outbox_after(c, 0, 10)) == []
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "in_transcript"))] == ["m1"]

    def test_the_final_message_answers_in_the_same_transaction(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("m1"), "accepted"))
        dot_store.write(
            lambda c: s.append_messages(
                c,
                "chat",
                [
                    {"role": "user", "content": "hello", "_dots": {"dots_inbound_id": "m1"}},
                    {"role": "assistant", "content": "hi there"},
                ],
                final_index=1,
            )
        )
        events = dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))
        assert [(e["type"], e["data"]) for e in events] == [("message.assistant", {"text": "hi there", "in_reply_to": "m1"})]

    def test_a_final_index_outside_the_messages_is_refused(self, dot_store: DotStore) -> None:
        for bad in (1, -1):
            with pytest.raises(ValueError, match="final_index"):
                dot_store.write(lambda c, b=bad: s.append_messages(c, "chat", [{"role": "assistant", "content": "x"}], final_index=b))
        with pytest.raises(ValueError, match="final_index"):
            dot_store.write(lambda c: s.append_messages(c, "chat", [], final_index=0))
        assert dot_store.read(lambda c: s.read_messages(c, "chat")) == []

    def test_a_session_has_metadata_that_starts_empty(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.read_session_metadata(c, "chat")) == {}
        dot_store.write(lambda c: s.append_messages(c, "chat", [{"role": "user", "content": "x"}], final_index=None))
        assert dot_store.read(lambda c: s.read_session_metadata(c, "chat")) == {}
        dot_store.write(lambda c: s.write_session_metadata(c, "chat", {"summary": "s", "last_consolidated": 3}))
        dot_store.write(lambda c: s.append_messages(c, "chat", [{"role": "user", "content": "y"}], final_index=None))
        assert dot_store.read(lambda c: s.read_session_metadata(c, "chat")) == {"summary": "s", "last_consolidated": 3}
        dot_store.write(lambda c: s.write_session_metadata(c, "chat", {"summary": "t"}, now_ms=5))
        assert dot_store.read(lambda c: s.read_session_metadata(c, "chat")) == {"summary": "t"}
        assert dot_store.read(lambda c: c.execute("SELECT updated_at FROM sessions WHERE key = 'chat'").fetchone()[0]) == 5

    def test_messages_survive_a_reopen_as_json(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        message = {"role": "assistant", "content": "caf\u00e9", "tool_calls": [{"id": "1", "function": {"arguments": "{}"}}]}
        store = DotStore.open(path)
        store.write(lambda c: s.append_messages(c, "chat", [message], final_index=None))
        store.close()
        store = DotStore.open(path)
        try:
            assert store.read(lambda c: s.read_messages(c, "chat")) == [message]
            raw = store.read(lambda c: c.execute("SELECT message_json FROM messages").fetchone()[0])
            assert json.loads(raw) == message
        finally:
            store.close()


class TestOpenToolCalls:
    def assistant(self, *ids: str) -> dict:
        return {"role": "assistant", "content": None, "tool_calls": [{"id": i, "type": "function"} for i in ids]}

    def result(self, call_id: str) -> dict:
        return {"role": "tool", "tool_call_id": call_id, "name": "exec", "content": "ok"}

    def append(self, store: DotStore, *messages: dict, key: str = "chat") -> None:
        store.write(lambda c: s.append_messages(c, key, list(messages), final_index=None))

    def open_ids(self, store: DotStore, key: str = "chat") -> list[str]:
        return [call["id"] for call in store.read(lambda c: s.open_tool_calls(c, key))]

    def test_an_empty_session_has_none(self, dot_store: DotStore) -> None:
        assert self.open_ids(dot_store) == []

    def test_every_call_of_the_newest_assistant_message_without_a_result_is_open(self, dot_store: DotStore) -> None:
        self.append(dot_store, {"role": "user", "content": "go"}, self.assistant("a", "b", "c"), self.result("a"))
        assert self.open_ids(dot_store) == ["b", "c"]
        self.append(dot_store, self.result("c"))
        assert self.open_ids(dot_store) == ["b"]
        self.append(dot_store, self.result("b"))
        assert self.open_ids(dot_store) == []

    def test_only_the_newest_assistant_message_counts(self, dot_store: DotStore) -> None:
        self.append(dot_store, self.assistant("old"), self.result("other"), self.assistant("new"))
        assert self.open_ids(dot_store) == ["new"]

    def test_a_newest_assistant_message_without_calls_has_none_open(self, dot_store: DotStore) -> None:
        self.append(dot_store, self.assistant("old"), {"role": "assistant", "content": "done"})
        assert self.open_ids(dot_store) == []

    def test_a_user_message_after_the_calls_does_not_close_them(self, dot_store: DotStore) -> None:
        self.append(dot_store, self.assistant("a"), {"role": "user", "content": "still there?"})
        assert self.open_ids(dot_store) == ["a"]

    def test_returns_the_calls_as_they_were_stored(self, dot_store: DotStore) -> None:
        call = {"id": "a", "type": "function", "function": {"name": "exec", "arguments": '{"command":"ls"}'}}
        self.append(dot_store, {"role": "assistant", "content": None, "tool_calls": [call]})
        assert dot_store.read(lambda c: s.open_tool_calls(c, "chat")) == [call]

    def test_sessions_are_independent(self, dot_store: DotStore) -> None:
        self.append(dot_store, self.assistant("a"))
        self.append(dot_store, self.assistant("t"), self.result("t"), key="task:t1")
        assert self.open_ids(dot_store) == ["a"]
        assert self.open_ids(dot_store, "task:t1") == []


class TestToolIntentsAndApprovalsByCall:
    def test_an_intent_can_be_looked_at_without_being_taken(self, dot_store: DotStore) -> None:
        intent = s.ToolIntent("c1", "exec", "chat", None, 10)
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "chat", "c1")) is None
        dot_store.write(lambda c: s.record_tool_intent(c, intent))
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "chat", "c1")) == intent
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "chat", "c1")) == intent
        assert dot_store.write(lambda c: s.take_tool_intent(c, "chat", "c1")) == intent
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "chat", "c1")) is None
        assert dot_store.write(lambda c: s.take_tool_intent(c, "chat", "c1")) is None

    def test_an_approval_is_found_by_the_call_that_asked_for_it(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.get_approval_by_tool_call(c, "chat", "c1")) is None
        approval, _ = dot_store.write(
            lambda c: s.request_approval(
                c, session_key="chat", task_id=None, tool_call_id="c1", tool="exec", permission="computer.exec", arguments={}
            )
        )
        assert dot_store.read(lambda c: s.get_approval_by_tool_call(c, "chat", "c1")) == approval
        assert dot_store.read(lambda c: s.get_approval_by_tool_call(c, "chat", "c2")) is None


class TestLoadingASession:
    def seed(self, store: DotStore, count: int) -> list[dict]:
        messages = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(count)]
        store.write(lambda c: s.append_messages(c, "chat", messages, final_index=None))
        return messages

    def test_an_unknown_session_is_empty(self, dot_store: DotStore) -> None:
        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert (session.key, session.messages, session.metadata, session.last_consolidated) == ("chat", [], {}, 0)

    def test_the_session_holds_the_messages_the_metadata_and_the_offset(self, dot_store: DotStore) -> None:
        messages = self.seed(dot_store, 4)
        dot_store.write(lambda c: s.write_session_metadata(c, "chat", {"_last_summary": {"text": "t"}, "last_consolidated": 2}))
        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert session.messages == messages
        assert session.last_consolidated == 2
        # The offset is a field of the session, not part of its metadata.
        assert session.metadata == {"_last_summary": {"text": "t"}}
        assert [m["content"] for m in session.get_history()] == ["m2", "m3"]

    def test_the_history_replay_copies_only_the_keys_of_a_model_message(self, dot_store: DotStore) -> None:
        dot_store.write(
            lambda c: s.append_messages(
                c,
                "chat",
                [
                    {"role": "user", "content": "go", "timestamp": "2026-10-05T10:00:00", "_dots": {"dots_inbound_id": "m1"}},
                    {"role": "assistant", "content": "ok", "timestamp": "2026-10-05T10:00:01", "_meta": {"x": 1}},
                ],
                final_index=None,
            )
        )
        history = dot_store.read(lambda c: s.load_session(c, "chat")).get_history()
        assert history == [{"role": "user", "content": "go"}, {"role": "assistant", "content": "ok"}]


class TestSummaryCheckpoints:
    def seed(self, store: DotStore, count: int) -> None:
        messages = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(count)]
        store.write(lambda c: s.append_messages(c, "chat", messages, final_index=None))

    def test_a_marker_is_inserted_at_the_boundary_and_the_later_rows_move_up(self, dot_store: DotStore) -> None:
        self.seed(dot_store, 6)
        dot_store.write(lambda c: s.commit_summary_checkpoint(c, "chat", "what happened", 3))

        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert [m["content"] for m in session.messages if m["content"].startswith("m")] == [f"m{i}" for i in range(6)]
        assert len(session.messages) == 7
        marker = session.messages[3]
        assert marker["role"] == "user" and marker["content"].startswith("Continue the active task")
        assert [m["content"] for m in session.messages[4:]] == ["m3", "m4", "m5"]
        assert session.last_consolidated == 3
        assert session.metadata["_last_summary"]["text"] == "what happened"
        assert dot_store.read(lambda c: [r[0] for r in c.execute("SELECT idx FROM messages ORDER BY idx")]) == list(range(7))
        # The replay starts after the boundary, anchored on the marker, so a mid-turn start survives.
        assert [m["content"] for m in session.get_history()] == ["m3", "m4", "m5"]

    def test_a_second_checkpoint_replaces_the_first_summary(self, dot_store: DotStore) -> None:
        self.seed(dot_store, 4)
        dot_store.write(lambda c: s.commit_summary_checkpoint(c, "chat", "first", 2))
        self.seed(dot_store, 2)
        dot_store.write(lambda c: s.commit_summary_checkpoint(c, "chat", "second", 5))

        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert session.metadata["_last_summary"]["text"] == "second"
        assert session.last_consolidated == 5
        assert len(session.messages) == 8

    def test_a_boundary_outside_the_session_is_refused_and_changes_nothing(self, dot_store: DotStore) -> None:
        self.seed(dot_store, 3)
        dot_store.write(lambda c: s.commit_summary_checkpoint(c, "chat", "first", 2))
        for bad in (1, 5):
            with pytest.raises(ValueError, match="summary boundary"):
                dot_store.write(lambda c, b=bad: s.commit_summary_checkpoint(c, "chat", "again", b))
        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert (len(session.messages), session.last_consolidated, session.metadata["_last_summary"]["text"]) == (4, 2, "first")
