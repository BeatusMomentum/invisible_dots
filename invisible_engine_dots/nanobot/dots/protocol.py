"""The invisible_dots guest contract (architecture sections 5.3, 5.4 and 7).

This is what the engine serves on the agent socket. The host's copy of these
names lives in packages/shared; tests/repo/vendored-nanobot.test.ts in the
parent repository reads the tuples below and checks that both sides list the
same routes, event types, states, model roles and cancel event. That test parses this file
with a regex, so each tuple is written as `NAME = ("a", "b", ...)` with plain
string literals, and the route table as `"key": "value"` lines.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

# Routes of `/run/invisible-dots-agent/agent.sock`, reached by the host as `/v1/agent/...`.
AGENT_ROUTES = {
    "health": "/health",
    "secrets": "/secrets",
    "config": "/config",
    "events": "/events",
    "events_stream": "/events/stream",
    "state": "/state",
    "browser_identities": "/browser-identities",
    "prepare_sleep": "/prepare-sleep",
}

INBOUND_EVENT_TYPES = (
    "user.message",
    "task.created",
    "approval.received",
    "system.event",
)

OUTBOUND_EVENT_TYPES = (
    "agent.started",
    "agent.state",
    "message.assistant",
    "task.started",
    "task.progress",
    "task.completed",
    "task.failed",
    "approval.requested",
    "tool.called",
    "browser.identity.created",
    "browser.identity.deleted",
    "browser.identity.launched",
    "browser.identity.closed",
    "memory.written",
)

AGENT_STATES = (
    "IDLE",
    "THINKING",
    "PLANNING",
    "EXECUTING",
    "WAITING_APPROVAL",
    "DONE",
)

# The roles a Dot's `models` map may name (MODEL_ROLES in packages/shared config.ts, which the host applies when
# a config is created or patched; tests/repo/vendored-nanobot.test.ts keeps the two equal).
MODEL_ROLES = ("summary",)

# The longest `target` of a `tool.called` event, in characters: code points, which is how zod 4 measures a string
# (TOOL_TARGET_MAX in packages/shared events.ts, whose schema refuses more; tests/repo/vendored-nanobot.test.ts
# keeps the two equal, and packages/shared/test/events.test.ts pins the unit).
TOOL_TARGET_MAX = 160

# The `system.event` name of a cancelled task; its data is `{"task_id": ...}`.
TASK_CANCELLED_EVENT = "task.cancelled"

# What an OpenRouter key is made of: one rule, owned by packages/shared (OPENROUTER_KEY_PATTERN and
# OPENROUTER_KEY_RULE in protocol.ts), which the host applies when the user enters the key. This is the
# guest's own check of what `POST /secrets` carries; tests/repo/vendored-nanobot.test.ts keeps the two
# texts equal, so each is written as one plain string literal.
OPENROUTER_KEY_PATTERN = "[!-~]+"
OPENROUTER_KEY_RULE = "the key must be printable ASCII without spaces, as it travels in a header"


class InvalidEvent(ValueError):
    """An inbound event that does not match the contract."""


class DotsConfigError(ValueError):
    """A `PUT /config` body that does not match the Dot configuration."""


T = TypeVar("T")

# Strict scalars: a JSON number is not a string and a bool is not a number, as in
# the host's zod schemas. `strict` is per field because it is the nested models
# that are built from dicts.
NonEmptyStr = Annotated[str, Field(min_length=1, strict=True)]
StrictInt = Annotated[int, Field(strict=True)]
PositiveInt = Annotated[int, Field(strict=True, gt=0)]
StrictBool = Annotated[bool, Field(strict=True)]


def _refuse_null(value: T, expected: str) -> T:
    """An optional field is absent or has a value; JSON null is neither (zod's `.optional()` refuses it).

    Worded as zod words it, which is what the host's own parse of the same events says.
    """
    if value is None:
        raise ValueError(f"Invalid input: expected {expected}, received null")
    return value


_ISO_DATETIME_WITH_OFFSET = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)"
)


def _iso_datetime_with_offset(value: str) -> str:
    if _ISO_DATETIME_WITH_OFFSET.fullmatch(value) is None:
        raise ValueError("must be an ISO 8601 datetime with an offset")
    try:
        datetime.fromisoformat(value)
    except ValueError:
        raise ValueError("must be an ISO 8601 datetime with an offset") from None
    return value


class _InboundBase(BaseModel):
    id: NonEmptyStr
    ts: Annotated[str, Field(strict=True)]

    @field_validator("ts")
    @classmethod
    def _ts_has_offset(cls, value: str) -> str:
        return _iso_datetime_with_offset(value)


class UserMessageData(BaseModel):
    text: NonEmptyStr


class UserMessageEvent(_InboundBase):
    type: Literal["user.message"]
    data: UserMessageData


class TaskCreatedData(BaseModel):
    task_id: NonEmptyStr
    description: NonEmptyStr
    priority: StrictInt


class TaskCreatedEvent(_InboundBase):
    type: Literal["task.created"]
    data: TaskCreatedData


class ApprovalReceivedData(BaseModel):
    approval_id: NonEmptyStr
    decision: Literal["approve", "reject"]
    note: Annotated[str, Field(strict=True)] | None = None

    @field_validator("note")
    @classmethod
    def _note_is_absent_or_a_string(cls, value: str | None) -> str | None:
        return _refuse_null(value, "string")


class ApprovalReceivedEvent(_InboundBase):
    type: Literal["approval.received"]
    data: ApprovalReceivedData


class SystemEventData(BaseModel):
    name: NonEmptyStr
    data: dict[str, Any]


class SystemEvent(_InboundBase):
    type: Literal["system.event"]
    data: SystemEventData


InboundEvent = Annotated[
    UserMessageEvent | TaskCreatedEvent | ApprovalReceivedEvent | SystemEvent,
    Field(discriminator="type"),
]
_inbound_adapter: TypeAdapter[Any] = TypeAdapter(InboundEvent)


def _describe_issues(error: ValidationError, *, tagged: bool) -> str:
    """Every problem as `path: message`, never with the value that caused it.

    pydantic's own text for an unknown discriminator tag quotes the tag it was
    given, so those two cases are worded here. `tagged` drops the tag that
    pydantic puts first in the path of an error inside a union member.
    """
    problems: list[str] = []
    for issue in error.errors(include_url=False, include_input=False):
        loc = tuple(str(part) for part in issue["loc"])
        if issue["type"] == "union_tag_invalid":
            loc, message = ("type",), "unknown event type"
        elif issue["type"] == "union_tag_not_found":
            loc, message = ("type",), "Field required"
        else:
            # A validator's own text, without pydantic's "Value error, " in front of it.
            message = issue["msg"].removeprefix("Value error, ")
            if tagged and loc and loc[0] in INBOUND_EVENT_TYPES:
                loc = loc[1:]
        problems.append(f"{'.'.join(loc) or '<root>'}: {message}")
    return "; ".join(problems)


def parse_inbound_event(value: object) -> UserMessageEvent | TaskCreatedEvent | ApprovalReceivedEvent | SystemEvent:
    """Validate an inbound event; raises InvalidEvent with every problem listed."""
    try:
        return _inbound_adapter.validate_python(value)
    except ValidationError as error:
        raise InvalidEvent(f"invalid inbound event: {_describe_issues(error, tagged=True)}") from None


class _Open(BaseModel):
    """A section of the Dot configuration: the fields the guest acts on are checked, the rest kept."""

    model_config = ConfigDict(extra="allow")


class ModelConfig(_Open):
    provider: Literal["openrouter"]
    id: NonEmptyStr


class BrowserIdentitiesConfig(_Open):
    managed_by_dot: StrictBool
    max_identities: PositiveInt
    max_open: PositiveInt


class BrowserConfig(_Open):
    identities: BrowserIdentitiesConfig


class MemoryConfig(_Open):
    enabled: StrictBool


class LimitsConfig(_Open):
    max_steps_per_task: PositiveInt
    context_tokens: Annotated[int, Field(strict=True, ge=4000, le=1_000_000)]
    max_cost_per_task_usd: Annotated[float, Field(strict=True, gt=0)]


class DotRuntimeConfig(_Open):
    """The Dot configuration minus `computer` (architecture section 7).

    The host validated it already with the canonical schema; this checks the
    fields the guest acts on, and keeps the rest as it came.
    """

    name: Annotated[str, Field(strict=True, pattern=r"^[a-z0-9-]{1,40}$")]
    goal: NonEmptyStr
    instructions: Annotated[str, Field(strict=True)] | None = None
    model: ModelConfig
    models: dict[str, NonEmptyStr] | None = None
    browser: BrowserConfig
    permissions: dict[str, Literal["allow", "ask", "deny"]]
    memory: MemoryConfig
    limits: LimitsConfig

    @field_validator("instructions")
    @classmethod
    def _instructions_are_absent_or_a_string(cls, value: str | None) -> str | None:
        return _refuse_null(value, "string")

    @field_validator("models")
    @classmethod
    def _models_are_absent_or_a_record_of_roles(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        models = _refuse_null(value, "record")
        for role in models:
            if role not in MODEL_ROLES:
                raise ValueError(f'unknown model role "{role}" (the roles are: {", ".join(MODEL_ROLES)})')
        return models


def parse_runtime_config(value: object) -> DotRuntimeConfig:
    """Validate a `PUT /config` body; raises DotsConfigError with every problem listed."""
    try:
        return DotRuntimeConfig.model_validate(value)
    except ValidationError as error:
        raise DotsConfigError(f"invalid Dot config: {_describe_issues(error, tagged=False)}") from None
