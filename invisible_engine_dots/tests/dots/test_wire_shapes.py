"""What the engine answers to `GET /automations` and `GET /tools`, and the data of the outbound events a part of
it writes, pinned in a file the host checks.

The host describes these answers with schemas in `packages/shared/src/protocol.ts` (`automationSchema`,
`toolInfoSchema`). The engine is Python and cannot import them, so this test writes what the engine really answers into
`wire_shapes.json`, and `apps/scheduler/test/engine-shapes.test.ts` parses that file with the schemas and runs the
host's fake guest on the same permissions. A key renamed, added or dropped here fails this test until the file is
written again (`UPDATE_WIRE_SHAPES=1 pytest tests/dots/test_wire_shapes.py`), and then fails the host's test until its
schema says the same.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from nanobot.cron.types import CronJob, CronJobState, CronPayload, CronSchedule
from nanobot.dots.automations import automation_json
from nanobot.dots import store as dots_store
from nanobot.dots.permissions import TOOL_PERMISSIONS, offered_tools, tool_table

FIXTURE = Path(__file__).with_name("wire_shapes.json")


class _Registry:
    """Stands in for the tool registry: a row's description is the only thing `tool_table` asks it for."""

    def get(self, name: str) -> Any:
        return SimpleNamespace(description=f"description of {name}")


def _automations() -> list[dict[str, Any]]:
    jobs = [
        CronJob(
            id="job_every",
            name="check the shop",
            schedule=CronSchedule(kind="every", every_ms=3_600_000),
            payload=CronPayload(message="look at the orders"),
            state=CronJobState(next_run_at_ms=1_790_000_000_000, last_run_at_ms=1_789_996_400_000, last_status="ok"),
            created_at_ms=1_789_990_000_000,
        ),
        CronJob(
            id="job_cron",
            name="morning report",
            enabled=False,
            schedule=CronSchedule(kind="cron", expr="0 9 * * 1-5", tz="Europe/Rome"),
            payload=CronPayload(message="write the report"),
            state=CronJobState(last_run_at_ms=1_789_900_000_000, last_status="error", last_error="the model was unreachable"),
            created_at_ms=1_789_000_000_000,
        ),
        CronJob(
            id="job_at",
            name="remind me",
            schedule=CronSchedule(kind="at", at_ms=1_791_000_000_000),
            payload=CronPayload(message="call the dentist"),
            state=CronJobState(next_run_at_ms=1_791_000_000_000, last_status="skipped"),
            created_at_ms=1_789_500_000_000,
            delete_after_run=True,
        ),
    ]
    return [automation_json(job) for job in jobs]


_OFFERED_CASES = [
    {"permissions": {"computer.exec": "allow", "files.read": "ask", "files.write": "deny", "memory.read": "allow", "automations": "deny"}, "memory_enabled": True},
    {"permissions": {"computer.exec": "allow", "files.read": "ask", "files.write": "deny", "memory.read": "allow", "automations": "deny"}, "memory_enabled": False},
    {"permissions": {}, "memory_enabled": True},
    {"permissions": {"computer.exec": "ask", "files.read": "ask", "files.write": "ask", "memory.read": "ask", "automations": "ask"}, "memory_enabled": True},
    {"permissions": {"browser.identity.list": "allow", "browser.identity.create": "allow", "browser.identity.delete": "ask"}, "memory_enabled": True, "managed_identities": True},
    {"permissions": {"browser.identity.list": "allow", "browser.identity.create": "allow", "browser.identity.delete": "ask"}, "memory_enabled": True, "managed_identities": False},
]


def _outbound_event_data(directory: Path) -> list[dict[str, Any]]:
    """The events the engine writes about its automations, as the store writes them (no seq, id or time: those vary)."""
    store = dots_store.DotStore.open(directory / "engine.sqlite")
    try:
        for next_run_at_ms in (1_790_000_000_000, None):
            store.write(lambda conn, at=next_run_at_ms: dots_store.record_next_run(conn, at))
        written = store.read(lambda conn: dots_store.read_outbox_after(conn, 0, 100))
    finally:
        store.close()
    return [{"type": event["type"], "data": event["data"]} for event in written]


def _shapes(directory: Path) -> dict[str, Any]:
    cases = []
    for case in _OFFERED_CASES:
        case = {"managed_identities": True, **case}
        offered = offered_tools(case["permissions"], memory_enabled=case["memory_enabled"], managed_identities=case["managed_identities"])
        cases.append({**case, "offered": offered, "tools": tool_table(_Registry(), offered)})
    return {"automations": _automations(), "outbound_event_data": _outbound_event_data(directory), "tool_offering": cases}


def test_the_answers_of_the_engine_are_the_ones_the_host_checks(tmp_path: Path) -> None:
    shapes = _shapes(tmp_path)
    text = json.dumps(shapes, indent=2, sort_keys=True) + "\n"
    if os.environ.get("UPDATE_WIRE_SHAPES") == "1":
        FIXTURE.write_bytes(text.encode("utf-8"))
    assert FIXTURE.exists(), "wire_shapes.json is missing: write it with UPDATE_WIRE_SHAPES=1"
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == shapes


def test_the_cases_reach_every_kind_of_schedule_and_every_kind_of_tool(tmp_path: Path) -> None:
    shapes = _shapes(tmp_path)
    assert {a["schedule"]["kind"] for a in shapes["automations"]} == {"at", "every", "cron"}
    assert {a["last_status"] for a in shapes["automations"]} == {"ok", "error", "skipped"}
    assert [event["data"]["next_run_at_ms"] for event in shapes["outbound_event_data"]] == [1_790_000_000_000, None]
    for case in shapes["tool_offering"]:
        assert [row["name"] for row in case["tools"]] == list(TOOL_PERMISSIONS)
    memory_off = next(c for c in shapes["tool_offering"] if not c["memory_enabled"] and c["permissions"].get("memory.read") == "allow")
    assert "memory_get" not in memory_off["offered"] and "memory_search" not in memory_off["offered"]
    unmanaged = next(c for c in shapes["tool_offering"] if not c["managed_identities"])
    assert unmanaged["permissions"]["browser.identity.create"] == "allow"
    assert "browser_identity_create" not in unmanaged["offered"] and "browser_identity_delete" not in unmanaged["offered"]
    assert "browser_identity_list" in unmanaged["offered"]
