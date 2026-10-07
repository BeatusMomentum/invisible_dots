"""A gate for the tests that are not about the gate: it allows every call."""

from __future__ import annotations

from nanobot.agent.tools.gate_types import Allow, GateCall, GateDecision


class AllowAllGate:
    """Allows every call it is asked about. Only for tests of what runs after a gate has let a call through."""

    def decide(self, call: GateCall) -> GateDecision:
        return Allow("test.allow_all", "allow")

    def skip(self, tool_call_id: str, session_key: str | None) -> None:
        return None
