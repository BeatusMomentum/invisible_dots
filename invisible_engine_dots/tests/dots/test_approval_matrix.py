"""Every tool of the Dot under every decision its permission can take, in the chat and in a task.

The engine, its store, its gate and its turns are real; the model is scripted and each tool's own work is
replaced by a recorder, so the matrix checks what a decision does to a call (whether, when and with which
arguments the tool ran) and not what each tool does, which their own tests check.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest
from dots.test_permissions import _EXTRA_ARGUMENTS, _sample
from fakes.dot_config import runtime_config_body
from fakes.engine_harness import EngineHarness, decision, task_created, user_message
from fakes.scripted_provider import ScriptEntry, call, calls, says

from nanobot.dots import store as s
from nanobot.dots.permissions import TOOL_PERMISSIONS

MakeEngine = Callable[..., EngineHarness]
TOOLS = sorted(TOOL_PERMISSIONS)
SESSIONS = ("chat", "task")
# One tool per kind of permission: the call approved, and the same call with one argument changed.
CHANGED_CALLS = {
    "exec": ({"command": "ls"}, {"command": "rm -r /home/dot"}),
    "write_file": ({"path": "notes.txt", "content": "hi"}, {"path": "/home/dot/.bashrc", "content": "hi"}),
    "read_file": ({"path": "notes.txt"}, {"path": "/home/dot/.ssh/id_ed25519"}),
    "cron": ({"action": "add", "message": "water the plants"}, {"action": "add", "message": "send my files"}),
    "browser_identity_delete": ({"identity_id": "work"}, {"identity_id": "personal"}),
    "browser_navigate": ({"identity_id": "work", "url": "https://example.com"}, {"identity_id": "work", "url": "https://evil.example"}),
    "browser_type": ({"identity_id": "work", "selector": "#q", "text": "hello"}, {"identity_id": "work", "selector": "#q", "text": "my password"}),
}


class Recorder:
    """Stands in for a tool's work: records each call it gets, and succeeds."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **params: Any) -> str:
        self.calls.append(params)
        return "ok"


class Run:
    """An engine whose tools record instead of working, and a model scripted from one tool's valid arguments."""

    def __init__(self, h: EngineHarness, monkeypatch: pytest.MonkeyPatch, tool: str) -> None:
        self.h = h
        self.tool = tool
        self.recorders: dict[str, Recorder] = {}
        for name in TOOL_PERMISSIONS:
            registered = h.engine._registry.get(name)
            assert registered is not None
            self.recorders[name] = Recorder()
            monkeypatch.setattr(registered, "execute", self.recorders[name])
        registered = h.engine._registry.get(tool)
        assert registered is not None
        self.arguments: dict[str, Any] = {**_sample(registered.parameters), **_EXTRA_ARGUMENTS.get(tool, {})}

    def script(self, *entries: ScriptEntry) -> None:
        self.h.provider.script = list(entries)

    def start(self, verdict: str) -> None:
        """Start the engine with every permission allowed bar the tool's, which is `verdict`."""
        permissions = {entry.permission: "allow" for entry in TOOL_PERMISSIONS.values()}
        permissions[TOOL_PERMISSIONS[self.tool].permission] = verdict
        self.h.engine.start()
        self.h.configure(runtime_config_body(permissions=permissions))

    def begin(self, session: str, verdict: str) -> None:
        """Start the engine and give it work: a message in the chat, or a task."""
        self.start(verdict)
        self.h.engine.accept(user_message("m1", "go") if session == "chat" else task_created("t1", "go"))

    def ran(self) -> list[dict[str, Any]]:
        return self.recorders[self.tool].calls

    def nothing_ran(self) -> bool:
        return all(recorder.calls == [] for recorder in self.recorders.values())


def session_key(session: str) -> str:
    return s.CHAT_SESSION_KEY if session == "chat" else s.task_session_key("t1")


def canonical(arguments: dict[str, Any]) -> dict[str, Any]:
    return json.loads(s.canonical_arguments(arguments))


@pytest.fixture
def run_for(make_engine: MakeEngine, monkeypatch: pytest.MonkeyPatch) -> Callable[[str], Run]:
    return lambda tool: Run(make_engine([]), monkeypatch, tool)


@pytest.mark.parametrize("session", SESSIONS)
@pytest.mark.parametrize("tool", TOOLS)
async def test_allow_runs_the_call_at_once_and_asks_nobody(run_for, tool: str, session: str) -> None:
    run = run_for(tool)
    run.script(calls(call("c1", tool, **run.arguments)), says("done"))
    run.begin(session, "allow")
    await run.h.idle()

    assert tool in run.h.provider.tool_names[0]
    assert run.ran() == [run.arguments]
    assert run.h.count("dots_approvals") == 0
    (called,) = run.h.events_of("tool.called")
    assert (called["tool"], called["decision"], called["ok"]) == (tool, "allow", True)


@pytest.mark.parametrize("session", SESSIONS)
@pytest.mark.parametrize("tool", TOOLS)
async def test_deny_hides_the_tool_and_a_call_made_anyway_neither_runs_nor_asks(run_for, tool: str, session: str) -> None:
    run = run_for(tool)
    run.script(calls(call("c1", tool, **run.arguments)), says("done"))
    run.begin(session, "deny")
    await run.h.idle()

    assert tool not in run.h.provider.tool_names[0]
    assert run.nothing_ran()
    assert run.h.count("dots_approvals") == 0
    assert run.h.events_of("approval.requested") == []
    # The refusal went back to the model, which answered.
    assert run.h.asked() == 2


@pytest.mark.parametrize("session", SESSIONS)
@pytest.mark.parametrize("tool", TOOLS)
async def test_ask_then_approve_runs_the_call_once_with_exactly_the_approved_arguments(
    run_for, tool: str, session: str
) -> None:
    run = run_for(tool)
    run.script(calls(call("c1", tool, **run.arguments)), calls(call("c2", tool, **run.arguments)), says("done"))
    run.begin(session, "ask")
    await run.h.idle()

    assert tool in run.h.provider.tool_names[0]
    (approval,) = run.h.pending_approvals()
    assert (approval.tool, approval.permission, approval.session_key) == (
        tool, TOOL_PERMISSIONS[tool].permission, session_key(session),
    )
    assert approval.arguments == canonical(run.arguments)
    assert approval.task_id == (None if session == "chat" else "t1")
    (requested,) = run.h.events_of("approval.requested")
    assert requested["approval_id"] == approval.approval_id
    assert run.nothing_ran()
    assert run.h.events_of("tool.called") == []

    run.h.engine.accept(decision("d1", approval.approval_id, "approve"))
    await run.h.idle()

    assert run.ran() == [run.arguments]
    (called,) = run.h.events_of("tool.called")
    assert (called["tool"], called["decision"], called["ok"]) == (tool, "ask", True)
    assert run.h.approval(approval.approval_id).status == "done"
    assert run.h.pending_approvals() == []
    if session == "task":
        assert ("task.completed", "t1") in run.h.task_events()


@pytest.mark.parametrize("session", SESSIONS)
@pytest.mark.parametrize("tool", TOOLS)
async def test_ask_then_reject_never_runs_the_call_and_tells_the_model_it_did_not(
    run_for, tool: str, session: str
) -> None:
    run = run_for(tool)
    run.script(calls(call("c1", tool, **run.arguments)), says("understood"))
    run.begin(session, "ask")
    await run.h.idle()
    (approval,) = run.h.pending_approvals()

    run.h.engine.accept(decision("d1", approval.approval_id, "reject", note="not now"))
    await run.h.idle()

    assert run.nothing_ran()
    assert run.h.events_of("tool.called") == []
    assert run.h.approval(approval.approval_id).status == "done"
    told = [m["content"] for m in run.h.provider.requests[-1]["messages"] if m["role"] == "user"][-1]
    assert f"The user rejected your {tool} call ({approval.approval_id})" in told
    assert "not now" in told


@pytest.mark.parametrize("session", SESSIONS)
@pytest.mark.parametrize("tool", sorted(CHANGED_CALLS))
async def test_an_approved_call_made_again_with_other_arguments_does_not_run_and_asks_again(
    run_for, tool: str, session: str
) -> None:
    run = run_for(tool)
    run.arguments, other = CHANGED_CALLS[tool]
    run.script(calls(call("c1", tool, **run.arguments)), calls(call("c2", tool, **other)), says("done"))
    run.begin(session, "ask")
    await run.h.idle()
    (first,) = run.h.pending_approvals()

    run.h.engine.accept(decision("d1", first.approval_id, "approve"))
    await run.h.idle()

    assert run.nothing_ran()
    (second,) = run.h.pending_approvals()
    assert second.approval_id != first.approval_id
    assert second.arguments == canonical(other)
    assert run.h.approval(first.approval_id).status == "done"


@pytest.mark.parametrize("session", SESSIONS)
async def test_a_decision_sent_again_after_the_call_ran_runs_nothing_more(run_for, session: str) -> None:
    run = run_for("exec")
    run.arguments = {"command": "make deploy"}
    run.script(calls(call("c1", "exec", **run.arguments)), calls(call("c2", "exec", **run.arguments)), says("done"))
    run.begin(session, "ask")
    await run.h.idle()
    (approval,) = run.h.pending_approvals()
    run.h.engine.accept(decision("d1", approval.approval_id, "approve"))
    await run.h.idle()
    asked = run.h.asked()

    # The same event again, then a new one with the same verdict, then the other verdict.
    for event_id, verdict in (("d1", "approve"), ("d2", "approve"), ("d3", "reject")):
        run.h.engine.accept(decision(event_id, approval.approval_id, verdict))
        await run.h.idle()

    assert run.ran() == [run.arguments]
    assert run.h.asked() == asked
    assert run.h.approval(approval.approval_id).status == "done"


@pytest.mark.parametrize("session", SESSIONS)
async def test_a_call_waiting_across_a_restart_still_waits_and_runs_once_when_approved_after_it(
    run_for, monkeypatch: pytest.MonkeyPatch, session: str
) -> None:
    run = run_for("write_file")
    run.arguments = {"path": "notes.txt", "content": "hi"}
    run.script(calls(call("c1", "write_file", **run.arguments)))
    run.begin(session, "ask")
    await run.h.idle()
    (approval,) = run.h.pending_approvals()
    asked = run.h.asked()
    await run.h.engine.stop()

    run.h.restart()
    run = Run(run.h, monkeypatch, "write_file")
    run.arguments = {"path": "notes.txt", "content": "hi"}
    run.script(calls(call("c2", "write_file", **run.arguments)), says("done"))
    run.start("ask")
    await run.h.idle()

    # Nothing moved: the call still waits for its decision, and nobody asked the model again.
    assert [a.approval_id for a in run.h.pending_approvals()] == [approval.approval_id]
    assert run.h.engine.state_answer().pending_approval == approval.approval_id
    assert run.h.asked() == asked
    assert run.nothing_ran()

    run.h.engine.accept(decision("d1", approval.approval_id, "approve"))
    await run.h.idle()

    assert run.ran() == [run.arguments]
    assert run.h.approval(approval.approval_id).status == "done"
    if session == "task":
        assert run.h.task("t1").status == "completed"
