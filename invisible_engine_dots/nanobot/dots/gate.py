"""The Dot's policy on every tool call (architecture 8.4).

It is the one approval system: the decision comes from the permission map the
host pushed in the Dot config, which carries a decision for every permission
the host knows. The runner applies it at the one boundary every execution path
crosses, on the arguments the tool would run with and before anything runs.

- allow: the call runs;
- deny: the call does not run and the model is told why; a tool with no
  permission, or a permission missing from the map, is denied;
- ask: the call is recorded with its full arguments and the host is asked, in
  one transaction, and the turn ends (the runner yields). Nothing waits in
  memory. Once approved, the engine tells the session to make the call again,
  and the one call an "ask" lets through is that one: in a turn of the same
  session, the same tool, exactly the approved arguments, once (status granted,
  then running);
- skipped: the calls of the same response that come after a parked one are not
  run either, and say so.

With no config or no store, every call is denied: the gate fails closed.

The gate decides a call that was prepared: one to a tool the turn was not offered, or
with arguments that do not fit the tool, fails before it and never reaches it. Its
`tool.called` says decision "allow" and ok false, as the contract reported such a call
(the gate only ever recorded a decision for a call that reached it). The denial of a
tool outside the permission table (permissions.py) is for a gate asked about one directly.

`close_open_calls` is the other half of what the gate recorded: a call that was
left without a result (the process or the turn ended) is closed by what the
database holds for it.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Mapping
from typing import Any, Protocol, TypeVar

from nanobot.agent.tools.gate_types import (
    SKIPPED_MESSAGE,
    Allow,
    Deny,
    GateCall,
    GateDecision,
    Park,
)
from nanobot.agent.transcript_metadata import METADATA_KEY
from nanobot.dots import store as dots_store
from nanobot.dots.permissions import tool_permission
from nanobot.dots.protocol import DotRuntimeConfig
from nanobot.dots.transcript_outbox import (
    CLOSED,
    CLOSED_APPROVAL_USED_TEXT,
    CLOSED_DENIED_TEXT,
    CLOSED_INTERRUPTED,
    CLOSED_INTERRUPTED_TEXT,
    CLOSED_NOT_RUN,
    CLOSED_NOT_RUN_TEXT,
)

T = TypeVar("T")


class GateStore(Protocol):
    """What the gate needs of the store: one write transaction."""

    def write(self, fn: Callable[[sqlite3.Connection], T]) -> T: ...


def park_message(approval_id: str) -> str:
    """The message the model reads in place of the call's result when the call waits for approval."""
    return (
        f"This call needs the user's approval ({approval_id}) and has not run. "
        "Do not call it again: the user's decision, and the call's result if it is approved, "
        "will arrive in a later message."
    )


def _deny(store: GateStore, call: GateCall, permission: str, reason: str) -> Deny:
    """A denial, recorded against the call so its `tool.called` (written from the transcript) says "deny"."""
    session_key, tool_call_id = call.session_key, call.tool_call_id
    if session_key and tool_call_id:
        store.write(lambda conn: dots_store.record_tool_decision(conn, session_key, tool_call_id, "deny"))
    return Deny(permission, reason)


def decide_tool_call(
    call: GateCall,
    config: DotRuntimeConfig | None,
    store: GateStore | None,
) -> GateDecision:
    """Decide one call. Pure apart from the writes it makes through `store`."""
    permission = tool_permission(call.tool_name)
    if config is None or store is None:
        return Deny(permission, "The Dot has no configuration yet, so no tool can run.")
    if not permission:
        return _deny(store, call, permission, f'The tool "{call.tool_name}" is not available to this Dot.')
    decision = config.permissions.get(permission, "deny")
    if decision == "allow":
        return Allow(permission, "allow")
    if decision != "ask":
        return _deny(store, call, permission, f"The Dot's policy denies {permission}.")
    session_key = call.session_key
    tool_call_id = call.tool_call_id
    if not session_key or not tool_call_id:
        return _deny(store, call, permission, f"{permission} needs approval, and this call has no session to wait in.")
    arguments: dict[str, Any] = dict(call.params) if isinstance(call.params, Mapping) else {}
    canonical = dots_store.canonical_arguments(arguments)

    def ask(conn: sqlite3.Connection) -> GateDecision:
        granted = next(
            (
                approval
                for approval in dots_store.list_approvals(conn, "granted")
                if approval.session_key == session_key
                and approval.tool == call.tool_name
                and dots_store.canonical_arguments(approval.arguments) == canonical
            ),
            None,
        )
        if granted is not None and dots_store.advance_approval(
            conn, granted.approval_id, "granted", "running", run_tool_call_id=tool_call_id
        ):
            dots_store.record_tool_decision(conn, session_key, tool_call_id, "ask")
            return Allow(permission, "ask")
        task = dots_store.get_task_by_session(conn, session_key)
        task_id = task.task_id if task else None
        approval, created = dots_store.request_approval(
            conn,
            session_key=session_key,
            task_id=task_id,
            tool_call_id=tool_call_id,
            tool=call.tool_name,
            permission=permission,
            arguments=arguments,
        )
        if created:
            dots_store.append_outbox(
                conn,
                "approval.requested",
                {
                    "approval_id": approval.approval_id,
                    **({"task_id": task_id} if task_id else {}),
                    "tool": call.tool_name,
                    "permission": permission,
                    "arguments": arguments,
                    "reason": f"The Dot's policy asks before {permission}.",
                },
            )
        dots_store.record_tool_decision(conn, session_key, tool_call_id, "park")
        return Park(permission, approval.approval_id, park_message(approval.approval_id))

    return store.write(ask)


def record_skipped(store: GateStore, session_key: str | None, tool_call_id: str) -> None:
    """Record that a call was not run because an earlier call of its response parked."""
    if session_key:
        store.write(lambda conn: dots_store.record_tool_decision(conn, session_key, tool_call_id, "skipped"))


class DotsGate:
    """The gate as the runner calls it: the engine's live config and its store.

    The config is read at the moment of each call, so a push between two calls
    of one turn applies to the second.
    """

    def __init__(self, get_config: Callable[[], DotRuntimeConfig | None], store: GateStore) -> None:
        self._get_config = get_config
        self._store = store

    def decide(self, call: GateCall) -> GateDecision:
        return decide_tool_call(call, self._get_config(), self._store)

    def skip(self, tool_call_id: str, session_key: str | None) -> None:
        record_skipped(self._store, session_key, tool_call_id)


def close_open_calls(conn: sqlite3.Connection, session_key: str) -> list[dict[str, Any]]:
    """Give a result to every call of the newest assistant message that has none; returns the messages.

    What the database holds for the call says what happened to it:
    - an intent: it started and the process or turn ended in it, so it may have taken effect
      (`tool.called` says interrupted, with the decision the gate recorded);
    - a park decision: it waits for the user, and says so again;
    - a deny decision: it was refused (`tool.called` says deny);
    - a skip decision: an earlier call of its response parked;
    - an ask decision and no intent: the gate let an approved call through and the call never
      started, so the approval is given back (approved again) and the session is told again;
    - nothing: it never started.
    """
    closed: list[dict[str, Any]] = []
    for call in dots_store.open_tool_calls(conn, session_key):
        call_id = call["id"]
        function = call.get("function")
        name = function.get("name") if isinstance(function, Mapping) else None
        intent = dots_store.peek_tool_intent(conn, session_key, call_id)
        decision = dots_store.peek_tool_decision(conn, session_key, call_id)
        metadata: dict[str, Any] = {}
        if intent is not None:
            text = CLOSED_INTERRUPTED_TEXT + (CLOSED_APPROVAL_USED_TEXT if decision == "ask" else "")
            metadata[CLOSED] = CLOSED_INTERRUPTED
        elif decision == "park" and (approval := dots_store.get_approval_by_tool_call(conn, session_key, call_id)) is not None:
            text = park_message(approval.approval_id)
            metadata[CLOSED] = CLOSED_NOT_RUN
        elif decision == "deny":
            text = CLOSED_DENIED_TEXT
        elif decision == "skipped":
            text = SKIPPED_MESSAGE
            metadata[CLOSED] = CLOSED_NOT_RUN
        else:
            if decision == "ask":
                dots_store.return_approval_run(conn, session_key, call_id)
            text = CLOSED_NOT_RUN_TEXT
            metadata[CLOSED] = CLOSED_NOT_RUN
        message: dict[str, Any] = {
            "role": "tool",
            "tool_call_id": call_id,
            "name": name if isinstance(name, str) and name else "unknown",
            "content": text,
        }
        if metadata:
            message[METADATA_KEY] = metadata
        closed.append(message)
    if closed:
        dots_store.append_messages(conn, session_key, closed, final_index=None)
    return closed
