"""The contract between the runner and the policy that gates its tool calls.

The runner decides nothing about a call: it asks a `ToolGate` and obeys one of
three answers. The Dot's policy (`nanobot.dots.gate`) implements the protocol;
this module is the one owner of what crosses it, so the generic layer never
imports the Dot layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

# What the model reads in place of the result of a call that came after a parked one in the same response.
SKIPPED_MESSAGE = (
    "Not executed: an earlier call of this response is waiting for the user's approval. "
    "Make it again after the decision."
)


@dataclass(frozen=True)
class GateCall:
    """One tool call as the gate sees it.

    params are the arguments the tool would run with: the final shape, after
    every cast and validation. A call with no tool_call_id or no session_key
    has nothing to record against and nowhere to wait.
    """

    tool_name: str
    params: object
    tool_call_id: str | None
    session_key: str | None


@dataclass(frozen=True)
class Allow:
    permission: str
    # "ask" when the call is the approved one made again.
    decision: str


@dataclass(frozen=True)
class Deny:
    permission: str
    reason: str


@dataclass(frozen=True)
class Park:
    permission: str
    approval_id: str
    # What the model reads in place of the call's result.
    message: str


GateDecision = Allow | Deny | Park


class ToolGate(Protocol):
    """The one policy every tool call crosses before it runs."""

    def decide(self, call: GateCall) -> GateDecision: ...

    def skip(self, tool_call_id: str, session_key: str | None) -> None: ...
