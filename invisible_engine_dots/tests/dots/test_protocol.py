"""The guest contract: the names the host shares, the inbound events and the Dot config."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

import pytest

from nanobot.dots.protocol import (
    AGENT_ROUTES,
    AGENT_STATES,
    INBOUND_EVENT_TYPES,
    OUTBOUND_EVENT_TYPES,
    TASK_CANCELLED_EVENT,
    DotsConfigError,
    InvalidEvent,
    parse_inbound_event,
    parse_runtime_config,
)

TS = "2026-10-04T10:00:00.000Z"


def event(type_: str, data: dict[str, Any], **fields: Any) -> dict[str, Any]:
    return {"id": "e1", "ts": TS, "type": type_, "data": data, **fields}


class TestSharedNames:
    def test_the_inbound_types_are_the_four_the_host_sends(self) -> None:
        assert INBOUND_EVENT_TYPES == ("user.message", "task.created", "approval.received", "system.event")

    def test_the_outbound_types_include_every_event_the_engine_writes(self) -> None:
        for name in (
            "agent.started",
            "agent.state",
            "message.assistant",
            "task.started",
            "task.completed",
            "task.failed",
            "approval.requested",
            "tool.called",
        ):
            assert name in OUTBOUND_EVENT_TYPES
        assert len(set(OUTBOUND_EVENT_TYPES)) == len(OUTBOUND_EVENT_TYPES)

    def test_the_states_are_the_six_of_the_runtime(self) -> None:
        assert AGENT_STATES == ("IDLE", "THINKING", "PLANNING", "EXECUTING", "WAITING_APPROVAL", "DONE")

    def test_the_routes_start_with_a_slash_and_are_distinct(self) -> None:
        assert all(route.startswith("/") for route in AGENT_ROUTES.values())
        assert len(set(AGENT_ROUTES.values())) == len(AGENT_ROUTES)
        assert AGENT_ROUTES["events_stream"] == "/events/stream"

    def test_the_cancel_event_name(self) -> None:
        assert TASK_CANCELLED_EVENT == "task.cancelled"


class TestInboundEvents:
    def test_accepts_each_of_the_four_types(self) -> None:
        message = parse_inbound_event(event("user.message", {"text": "hello"}))
        assert (message.type, message.data.text) == ("user.message", "hello")
        task = parse_inbound_event(
            event("task.created", {"task_id": "t1", "description": "do it", "priority": 5})
        )
        assert (task.data.task_id, task.data.priority) == ("t1", 5)
        approval = parse_inbound_event(
            event("approval.received", {"approval_id": "appr_1", "decision": "reject", "note": "no"})
        )
        assert (approval.data.decision, approval.data.note) == ("reject", "no")
        system = parse_inbound_event(event("system.event", {"name": TASK_CANCELLED_EVENT, "data": {"task_id": "t1"}}))
        assert system.data.data == {"task_id": "t1"}

    def test_the_note_of_an_approval_is_optional(self) -> None:
        parsed = parse_inbound_event(event("approval.received", {"approval_id": "a", "decision": "approve"}))
        assert parsed.data.note is None

    def test_a_null_note_is_refused_as_the_host_refuses_it(self) -> None:
        # zod's `z.string().optional()` takes a string or nothing, never null.
        with pytest.raises(InvalidEvent) as caught:
            parse_inbound_event(event("approval.received", {"approval_id": "a", "decision": "approve", "note": None}))
        assert str(caught.value) == "invalid inbound event: data.note: Invalid input: expected string, received null"

    @pytest.mark.parametrize(
        "stamp",
        ["2026-10-04T10:00:00Z", "2026-10-04T10:00:00.123+02:00", "2026-10-04T10:00:00-0530", "2026-10-04T10:00Z"],
    )
    def test_accepts_a_timestamp_with_an_offset(self, stamp: str) -> None:
        assert parse_inbound_event(event("user.message", {"text": "x"}, ts=stamp)).ts == stamp

    @pytest.mark.parametrize(
        "stamp",
        ["2026-10-04T10:00:00", "2026-10-04", "2026-10-04 10:00:00Z", "2026-13-04T10:00:00Z", "yesterday", "", 1_760_000_000],
    )
    def test_refuses_a_timestamp_without_an_offset_or_not_a_timestamp(self, stamp: object) -> None:
        with pytest.raises(InvalidEvent, match="ts:"):
            parse_inbound_event(event("user.message", {"text": "x"}, ts=stamp))

    def test_lists_every_problem_with_its_path(self) -> None:
        with pytest.raises(InvalidEvent) as caught:
            parse_inbound_event({"id": "", "ts": "nope", "type": "task.created", "data": {"task_id": "t", "priority": 1.5}})
        message = str(caught.value)
        assert message.startswith("invalid inbound event: ")
        for path in ("id:", "ts:", "data.description:", "data.priority:"):
            assert path in message

    @pytest.mark.parametrize(
        ("value", "path"),
        [
            (event("user.message", {"text": ""}), "data.text"),
            (event("user.message", {}), "data.text"),
            (event("task.created", {"task_id": "t", "description": "d", "priority": True}), "data.priority"),
            (event("task.created", {"task_id": "t", "description": "d", "priority": "5"}), "data.priority"),
            (event("approval.received", {"approval_id": "a", "decision": "maybe"}), "data.decision"),
            (event("system.event", {"name": "n"}), "data.data"),
            (event("system.event", {"name": "", "data": {}}), "data.name"),
            (event("user.message", {"text": "x"}, id=""), "id"),
        ],
    )
    def test_refuses_what_the_zod_schema_refuses(self, value: dict[str, Any], path: str) -> None:
        with pytest.raises(InvalidEvent, match=f"{path}:"):
            parse_inbound_event(value)

    @pytest.mark.parametrize("value", [None, "text", [], 3, {}, {"type": 4}, {"type": "task.cancelled"}])
    def test_refuses_what_is_not_an_event(self, value: object) -> None:
        with pytest.raises(InvalidEvent, match="^invalid inbound event: "):
            parse_inbound_event(value)

    def test_never_echoes_a_value(self) -> None:
        secret = "sk-or-this-must-not-appear"
        values: list[object] = [
            {"type": secret, "id": "e", "ts": TS, "data": {}},
            event("approval.received", {"approval_id": "a", "decision": secret}),
            event("task.created", {"task_id": "t", "description": "d", "priority": secret}),
            event("user.message", {"text": "x"}, ts=secret),
            event("user.message", {"text": secret}, id=secret + "\n", extra=secret) | {"data": secret},
            secret,
        ]
        for value in values:
            with pytest.raises(InvalidEvent) as caught:
                parse_inbound_event(value)
            assert secret not in str(caught.value)


class TestRuntimeConfig:
    def test_accepts_a_full_config_and_keeps_what_it_does_not_know(self, config_body: Callable[..., dict[str, Any]]) -> None:
        body = config_body(
            instructions="Be brief.",
            models={"vision": "google/gemini"},
            permissions={"computer.exec": "ask", "files.read": "allow", "files.write": "deny"},
            computer={"cpu": 4},
            model={"provider": "openrouter", "id": "m", "temperature": 0.2},
        )
        body["limits"]["extra_limit"] = 7
        config = parse_runtime_config(body)
        assert config.name == "fare-watch"
        assert config.permissions == {"computer.exec": "ask", "files.read": "allow", "files.write": "deny"}
        assert config.models == {"vision": "google/gemini"}
        dumped = config.model_dump()
        assert dumped["computer"] == {"cpu": 4}
        assert dumped["model"]["temperature"] == 0.2
        assert dumped["limits"]["extra_limit"] == 7
        assert dumped == body

    def test_the_optional_fields_default_to_none(self, config_body: Callable[..., dict[str, Any]]) -> None:
        config = parse_runtime_config(config_body())
        assert config.instructions is None
        assert config.models is None

    @pytest.mark.parametrize(
        ("field", "expected"), [("instructions", "string"), ("models", "record")]
    )
    def test_an_optional_field_is_absent_or_has_a_value_never_null(
        self, config_body: Callable[..., dict[str, Any]], field: str, expected: str
    ) -> None:
        body = config_body()
        body[field] = None

        with pytest.raises(DotsConfigError) as caught:
            parse_runtime_config(body)

        assert str(caught.value) == f"invalid Dot config: {field}: Invalid input: expected {expected}, received null"

    @pytest.mark.parametrize("name", ["a", "fare-watch", "a" * 40, "0-9"])
    def test_accepts_a_name(self, config_body: Callable[..., dict[str, Any]], name: str) -> None:
        assert parse_runtime_config(config_body(name=name)).name == name

    @pytest.mark.parametrize("name", ["", "A", "a b", "a_b", "a" * 41, "a\n", 5])
    def test_refuses_a_name(self, config_body: Callable[..., dict[str, Any]], name: object) -> None:
        with pytest.raises(DotsConfigError, match="name:"):
            parse_runtime_config(config_body(name=name))

    @pytest.mark.parametrize(
        ("mutate", "path"),
        [
            (lambda b: b.update(goal=""), "goal"),
            (lambda b: b.update(instructions=3), "instructions"),
            (lambda b: b["model"].update(provider="anthropic"), "model.provider"),
            (lambda b: b["model"].update(id=""), "model.id"),
            (lambda b: b.update(models={"vision": ""}), "models.vision"),
            (lambda b: b["browser"]["identities"].update(managed_by_dot="yes"), "browser.identities.managed_by_dot"),
            (lambda b: b["browser"]["identities"].update(max_identities=0), "browser.identities.max_identities"),
            (lambda b: b["browser"]["identities"].update(max_open=-1), "browser.identities.max_open"),
            (lambda b: b.update(permissions={"files.read": "maybe"}), "permissions.files.read"),
            (lambda b: b["memory"].update(enabled=1), "memory.enabled"),
            (lambda b: b["limits"].update(max_steps_per_task=0), "limits.max_steps_per_task"),
            (lambda b: b["limits"].update(max_steps_per_task=1.5), "limits.max_steps_per_task"),
            (lambda b: b["limits"].update(context_tokens=3999), "limits.context_tokens"),
            (lambda b: b["limits"].update(context_tokens=1_000_001), "limits.context_tokens"),
            (lambda b: b["limits"].update(max_cost_per_task_usd=0), "limits.max_cost_per_task_usd"),
            (lambda b: b["limits"].update(max_cost_per_task_usd=True), "limits.max_cost_per_task_usd"),
            (lambda b: b.pop("browser"), "browser"),
            (lambda b: b.pop("limits"), "limits"),
        ],
    )
    def test_refuses_what_the_zod_schema_refuses(
        self,
        config_body: Callable[..., dict[str, Any]],
        mutate: Callable[[dict[str, Any]], object],
        path: str,
    ) -> None:
        body = copy.deepcopy(config_body())
        mutate(body)
        with pytest.raises(DotsConfigError, match=f"^invalid Dot config: .*{path}:"):
            parse_runtime_config(body)

    def test_the_edges_of_the_limits_pass(self, config_body: Callable[..., dict[str, Any]]) -> None:
        for tokens in (4000, 1_000_000):
            body = config_body()
            body["limits"]["context_tokens"] = tokens
            assert parse_runtime_config(body).limits.context_tokens == tokens
        body = config_body()
        body["limits"]["max_cost_per_task_usd"] = 0.01
        assert parse_runtime_config(body).limits.max_cost_per_task_usd == 0.01

    def test_lists_every_problem(self, config_body: Callable[..., dict[str, Any]]) -> None:
        body = config_body(name="X", goal="")
        body["limits"]["context_tokens"] = 1
        with pytest.raises(DotsConfigError) as caught:
            parse_runtime_config(body)
        for path in ("name:", "goal:", "limits.context_tokens:"):
            assert path in str(caught.value)

    @pytest.mark.parametrize("value", [None, [], "config", 4])
    def test_refuses_what_is_not_an_object(self, value: object) -> None:
        with pytest.raises(DotsConfigError, match="^invalid Dot config: <root>"):
            parse_runtime_config(value)

    def test_never_echoes_a_value(self, config_body: Callable[..., dict[str, Any]]) -> None:
        secret = "sk-or-this-must-not-appear"
        body = config_body(name=secret, goal=1, permissions={"files.read": secret}, memory={"enabled": secret})
        body["model"]["provider"] = secret
        body["limits"]["context_tokens"] = secret
        with pytest.raises(DotsConfigError) as caught:
            parse_runtime_config(body)
        assert secret not in str(caught.value)
