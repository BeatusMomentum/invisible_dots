"""The Dot's automations as the API shows them: the jobs of nanobot's CronService.

The cron tool lets the Dot make them (after the person approved the `automations` permission); the
person lists, pauses and deletes them through `GET`, `PATCH` and `DELETE /automations` (architecture
section 5.3). Times are milliseconds since the epoch, as the service keeps them.
"""

from __future__ import annotations

from typing import Any

from nanobot.cron.types import CronJob


def automation_json(job: CronJob) -> dict[str, Any]:
    """One job as the API shows it. The schedule names only the fields its kind uses."""
    schedule: dict[str, Any] = {"kind": job.schedule.kind}
    for key, value in (
        ("at_ms", job.schedule.at_ms),
        ("every_ms", job.schedule.every_ms),
        ("expr", job.schedule.expr),
        ("tz", job.schedule.tz),
    ):
        if value is not None:
            schedule[key] = value
    state = job.state
    return {
        "id": job.id,
        "name": job.name,
        "enabled": job.enabled,
        "schedule": schedule,
        "message": job.payload.message,
        "next_run_at_ms": state.next_run_at_ms,
        "last_run_at_ms": state.last_run_at_ms,
        "last_status": state.last_status,
        "last_error": state.last_error,
        "delete_after_run": job.delete_after_run,
        "created_at_ms": job.created_at_ms,
    }
