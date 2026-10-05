"""The BrowserManager against a fake MCP server that speaks real MCP over stdio through the fake relay.

The manager's collaborators are real: a database file, nanobot's MCP client, the relay command line the
production Computer builds (run by `fake_relay.py`), and the MCP protocol (`fake_mcp_server.py`, which
serves the captured tool list of invisible-playwright-mcp). Directories are real directories under
`tmp_path`. Each test below is a behavior of architecture section 6; the ones with a counterpart in the
old TypeScript manager keep its wording.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from fakes.fake_mcp_server import install_fake_mcp, read_record, write_control
from fakes.local_computer import LocalComputer

from nanobot.agent.tools.base import ToolResult
from nanobot.dots import store as dots_store
from nanobot.dots.browser import (
    BrowserIdentityError,
    BrowserManager,
    result_is_error,
    result_text,
)
from nanobot.dots.protocol import BROWSER_ENV
from nanobot.dots.store import DotStore

FAST = {"open_retry_initial_s": 0.01, "open_retry_max_s": 0.02}


class Env:
    """A manager on a real store, a local computer and the fake MCP server."""

    def __init__(self, tmp_path: Path, store: DotStore) -> None:
        self.tmp_path = tmp_path
        self.store = store
        self.browsers = tmp_path / "browsers"
        self.relay_log = tmp_path / "relay.jsonl"
        (tmp_path / "bin").mkdir()
        self.mcp_bin = install_fake_mcp(tmp_path / "bin")
        (tmp_path / "computer").mkdir()
        self.computer = LocalComputer(tmp_path / "computer", relay_log=self.relay_log)
        self.managers: list[BrowserManager] = []

    def manager(self, **options: Any) -> BrowserManager:
        settings: dict[str, Any] = {
            "store": self.store,
            "computer": self.computer,
            "mcp_command": str(self.mcp_bin),
            "max_open": 3,
            "max_identities": 20,
            "browsers_dir": str(self.browsers),
            **FAST,
            **options,
        }
        manager = BrowserManager(**settings)
        self.managers.append(manager)
        return manager

    def mcp_home(self, identity_id: str) -> Path:
        return self.browsers / identity_id / "mcp"

    def record(self, identity_id: str) -> list[dict[str, Any]]:
        return read_record(self.mcp_home(identity_id))

    def calls(self, identity_id: str) -> list[tuple[str, dict[str, Any]]]:
        return [(entry["name"], entry["args"]) for entry in self.record(identity_id) if entry["kind"] == "call"]

    def events(self) -> list[dict[str, Any]]:
        rows = self.store.read(lambda conn: dots_store.read_outbox_after(conn, 0, 1000))
        return [row for row in rows if row["type"].startswith("browser.identity.")]

    def event_types(self) -> list[str]:
        return [row["type"] for row in self.events()]


@pytest.fixture
async def env(tmp_path: Path, dot_store: DotStore) -> AsyncIterator[Env]:
    made = Env(tmp_path, dot_store)
    yield made
    for manager in made.managers:
        await manager.close_all()


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------


async def test_creates_the_directories_and_the_row_and_follows_them_through_launch_and_close(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("Shopping Account")

    assert identity.id.startswith("shopping-account-") and len(identity.id) == len("shopping-account-") + 6
    root = env.browsers / identity.id
    assert (root / "profile").is_dir() and (root / "mcp").is_dir()
    assert not (root / "metadata.json").exists()
    assert (identity.name, identity.status, identity.last_used_at, identity.proxy) == (
        "Shopping Account",
        "available",
        None,
        None,
    )
    assert identity.profile_path == str(env.browsers / identity.id / "profile")

    launched = await manager.launch(identity.id)
    assert launched.status == "open" and launched.last_used_at is not None
    assert manager.get(identity.id) == launched

    await manager.close(identity.id)
    after = manager.get(identity.id)
    assert after is not None and after.status == "available"
    assert env.event_types() == ["browser.identity.created", "browser.identity.launched", "browser.identity.closed"]
    assert all(event["data"] == {"identity_id": identity.id, "name": "Shopping Account"} for event in env.events())


async def test_open_is_never_stored_so_another_manager_on_the_same_database_sees_available(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("kept")
    await manager.launch(identity.id)

    after_restart = env.manager()
    assert [(i.id, i.status) for i in after_restart.list_identities()] == [(identity.id, "available")]
    assert after_restart.open_count == 0


async def test_refuses_an_empty_name_a_bad_proxy_and_more_than_max_identities(env: Env) -> None:
    manager = env.manager(max_identities=2)

    with pytest.raises(BrowserIdentityError, match="non-empty name") as empty:
        await manager.create("   ")
    assert empty.value.code == "invalid"
    with pytest.raises(BrowserIdentityError, match="http, https, socks4 or socks5"):
        await manager.create("a", "ftp://host:21")
    with pytest.raises(BrowserIdentityError, match="must be a URL"):
        await manager.create("a", "not a url")
    await manager.create("one")
    await manager.create("two")
    with pytest.raises(BrowserIdentityError, match="max_identities 2") as limit:
        await manager.create("three")
    assert limit.value.code == "limit"
    assert env.event_types() == ["browser.identity.created"] * 2
    assert len(list((env.browsers).iterdir())) == 2


async def test_the_proxy_is_kept_for_the_launch_and_shown_only_redacted(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("proxied", "http://user:pw@proxy.test:8080")

    assert identity.proxy == "http://user:***@proxy.test:8080"
    stored = env.store.read(lambda conn: dots_store.get_identity(conn, identity.id))
    assert stored is not None and stored.proxy == "http://user:pw@proxy.test:8080"
    assert "pw" not in str(env.events())
    assert manager.list_identities() == [identity]


async def test_delete_closes_the_session_removes_the_directory_and_the_row(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("temp")
    await manager.launch(identity.id)

    await manager.delete(identity.id)

    assert not (env.browsers / identity.id).exists()
    assert manager.get(identity.id) is None
    assert not manager.is_open(identity.id)
    assert env.event_types()[-2:] == ["browser.identity.closed", "browser.identity.deleted"]
    with pytest.raises(BrowserIdentityError) as gone:
        await manager.delete(identity.id)
    assert gone.value.code == "not_found"


async def test_a_row_whose_directory_is_gone_can_still_be_deleted(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("half")
    (env.browsers / identity.id / "profile").rmdir()
    (env.browsers / identity.id / "mcp").rmdir()
    (env.browsers / identity.id).rmdir()

    await manager.delete(identity.id)

    assert manager.get(identity.id) is None
    assert env.event_types() == ["browser.identity.created", "browser.identity.deleted"]


async def test_refuses_ids_that_could_leave_the_browsers_directory(env: Env) -> None:
    manager = env.manager()
    for bad in ("../etc", "a/../../b", "..", "", "A", "a" * 65):
        with pytest.raises(BrowserIdentityError, match="no browser identity") as launch:
            await manager.launch(bad)
        assert launch.value.code == "not_found"
        with pytest.raises(BrowserIdentityError, match="no browser identity"):
            await manager.delete(bad)
        assert manager.get(bad) is None
    assert not (env.tmp_path / "etc").exists()


async def test_an_archived_identity_is_reported_so_and_is_not_launched(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("old")
    env.store.write(lambda conn: dots_store.set_identity_archived(conn, identity.id, True))

    archived = manager.get(identity.id)
    assert archived is not None and archived.status == "archived"
    with pytest.raises(BrowserIdentityError, match="archived") as refused:
        await manager.launch(identity.id)
    assert refused.value.code == "invalid"
    assert manager.open_count == 0


def test_the_limits_are_integers_of_at_least_one(env: Env) -> None:
    for options in ({"max_open": 0}, {"max_identities": 0}, {"max_open": 1.5}, {"max_identities": True}):
        with pytest.raises(ValueError, match="at least 1"):
            env.manager(**options)
    with pytest.raises(ValueError, match="must name a program"):
        env.manager(mcp_command="  ")


# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------


async def test_starts_the_server_as_dot_through_the_relay_with_the_environment_of_the_identity(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test-not-a-real-key")
    monkeypatch.setenv("SOME_OTHER_SECRET", "hidden")
    monkeypatch.setenv("STEALTHFOX_PROXY", "http://leak:1")
    manager = env.manager(display=":7")
    identity = await manager.create("env check", "http://user:pw@proxy.test:8080")

    await manager.launch(identity.id)

    root = env.browsers / identity.id
    [start] = [entry for entry in env.record(identity.id) if entry["kind"] == "start"]
    environment = start["env"]
    assert environment[BROWSER_ENV["MCP_HOME"]] == str(root / "mcp")
    assert environment[BROWSER_ENV["MCP_SESSION_ID"]] == identity.id
    assert environment[BROWSER_ENV["PROFILE_DIR"]] == str(root / "profile")
    assert environment[BROWSER_ENV["HEADLESS"]] == "0"
    assert environment[BROWSER_ENV["DISPLAY"]] == ":7"
    assert environment[BROWSER_ENV["PROXY"]] == "http://user:pw@proxy.test:8080"
    assert "OPENROUTER_API_KEY" not in environment and "SOME_OTHER_SECRET" not in environment
    assert start["cwd"] == str(root)

    # The one spawn of the program is the relay's: the working directory, the variables in the order of
    # the table and then the program, which is what runs it as dot in the guest.
    relay = [json.loads(line) for line in env.relay_log.read_text(encoding="utf-8").splitlines()]
    mcp_runs = [entry for entry in relay if entry["program"] == [str(env.mcp_bin)]]
    assert len(mcp_runs) == 1
    assert mcp_runs[0]["cwd"] == str(root)
    assert [pair.partition("=")[0] for pair in mcp_runs[0]["env"]] == [
        BROWSER_ENV[name] for name in ("MCP_HOME", "MCP_SESSION_ID", "PROFILE_DIR", "HEADLESS", "DISPLAY", "PROXY")
    ]
    assert not mcp_runs[0]["tty"]


async def test_leaves_the_proxy_variable_unset_for_an_identity_without_a_proxy_even_if_the_engine_has_one(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("STEALTHFOX_PROXY", "http://leak:1")
    manager = env.manager()
    identity = await manager.create("direct")

    await manager.launch(identity.id)

    [start] = [entry for entry in env.record(identity.id) if entry["kind"] == "start"]
    assert BROWSER_ENV["PROXY"] not in start["env"]


async def test_calls_browser_open_with_only_the_browser_role_and_retries_while_the_engine_downloads(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("slow engine", "socks5://proxy.test:1080")
    write_control(env.mcp_home(identity.id), download_answers=2)

    await manager.launch(identity.id)

    opens = [args for name, args in env.calls(identity.id) if name == "browser_open"]
    assert opens == [{"browser": "main"}] * 3
    assert manager.is_open(identity.id)


async def test_gives_up_after_the_open_deadline_with_the_servers_last_answer(env: Env) -> None:
    manager = env.manager(open_deadline_s=0.05, open_retry_initial_s=0.03, open_retry_max_s=0.03)
    identity = await manager.create("never ready")
    write_control(env.mcp_home(identity.id), download_answers=1000)

    with pytest.raises(BrowserIdentityError, match="was not ready within .*downloading now") as failed:
        await manager.launch(identity.id)

    assert failed.value.code == "launch_failed"
    assert not manager.is_open(identity.id)
    assert env.event_types() == ["browser.identity.created"]
    assert env.record(identity.id)[-1]["kind"] == "exit"


async def test_reports_a_browser_that_did_not_start_and_leaves_nothing_open(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("bad proxy")
    write_control(env.mcp_home(identity.id), fail_open=True)

    with pytest.raises(BrowserIdentityError, match="browser_open failed .*did NOT start") as failed:
        await manager.launch(identity.id)

    assert failed.value.code == "launch_failed"
    assert manager.open_count == 0
    assert env.event_types() == ["browser.identity.created"]
    assert env.record(identity.id)[-1]["kind"] == "exit"


async def test_what_the_server_says_of_the_proxy_reaches_the_caller_redacted(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("echo", "http://user:s3cret@proxy.test:8080")
    write_control(env.mcp_home(identity.id), fail_open=True, echo_proxy=True)

    with pytest.raises(BrowserIdentityError) as failed:
        await manager.launch(identity.id)

    assert "http://user:***@proxy.test:8080" in failed.value.message
    assert "s3cret" not in failed.value.message


async def test_reports_a_command_that_cannot_be_started_without_its_arguments(env: Env) -> None:
    manager = env.manager(mcp_command=str(env.tmp_path / "no-such-mcp-binary"))
    identity = await manager.create("missing", "http://user:s3cret@proxy.test:8080")

    with pytest.raises(BrowserIdentityError, match="could not start") as failed:
        await manager.launch(identity.id)

    assert failed.value.code == "launch_failed"
    assert "s3cret" not in failed.value.message
    assert manager.open_count == 0


async def test_launching_an_open_identity_changes_nothing(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("twice")
    first = await manager.launch(identity.id)

    second = await manager.launch(identity.id)

    assert second == first
    assert env.event_types().count("browser.identity.launched") == 1
    assert len([entry for entry in env.record(identity.id) if entry["kind"] == "start"]) == 1


# ---------------------------------------------------------------------------
# Open sessions
# ---------------------------------------------------------------------------


async def test_closes_the_least_recently_used_identity_beyond_max_open(env: Env) -> None:
    manager = env.manager(max_open=2)
    a, b, c = [await manager.create(name) for name in "abc"]
    await manager.launch(a.id)
    await manager.launch(b.id)
    # Using a makes b the least recently used.
    await manager.call_tool(a.id, "browser_status")

    await manager.launch(c.id)

    assert [manager.is_open(i.id) for i in (a, b, c)] == [True, False, True]
    assert manager.open_count == 2
    closed = [event["data"]["identity_id"] for event in env.events() if event["type"] == "browser.identity.closed"]
    assert closed == [b.id]
    assert "browser_close" in [name for name, _ in env.calls(b.id)]


async def test_an_action_on_a_closed_identity_does_not_launch_it(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("lazy")

    with pytest.raises(BrowserIdentityError) as refused:
        await manager.call_tool(identity.id, "browser_navigate", {"url": "https://example.com/"})

    assert refused.value.code == "not_open"
    assert refused.value.message == f"identity {identity.id} is not open; call browser_identity_launch first"
    assert manager.open_count == 0 and env.record(identity.id) == []
    with pytest.raises(BrowserIdentityError) as unknown:
        await manager.call_tool("../x", "browser_status")
    assert unknown.value.code == "not_open"


async def test_adds_the_browser_role_to_every_call_and_the_caller_cannot_choose_another(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("roles")
    await manager.launch(identity.id)

    result = await manager.call_tool(identity.id, "browser_navigate", {"url": "https://example.com/"})
    await manager.call_tool(identity.id, "browser_navigate", {"url": "https://example.org/", "browser": "support"})

    assert result_text(result) == "200 https://example.com/"
    navigations = [args for name, args in env.calls(identity.id) if name == "browser_navigate"]
    assert navigations == [
        {"url": "https://example.com/", "browser": "main"},
        {"url": "https://example.org/", "browser": "main"},
    ]


async def test_an_image_comes_back_as_a_content_block_and_an_error_as_an_error(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("pictures")
    await manager.launch(identity.id)

    shot = await manager.call_tool(identity.id, "browser_take_screenshot")
    frame = await manager.call_tool(identity.id, "browser_watch")
    text = await manager.call_tool(identity.id, "browser_read_text", {"selector": "h1"})
    refused = await manager.call_tool(identity.id, "browser_click", {"selector": "#x", "nonsense": 1})

    assert isinstance(shot, list) and shot[0]["type"] == "image_url"
    assert shot[0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert isinstance(frame, list) and frame[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert text == "text of h1" and not result_is_error(text)
    assert isinstance(refused, ToolResult) and refused.is_error


async def test_a_tool_the_server_does_not_have_is_a_programming_error(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("tools")
    await manager.launch(identity.id)

    with pytest.raises(ValueError, match="no tool browser_teleport"):
        await manager.call_tool(identity.id, "browser_teleport")


async def test_a_process_that_exited_is_a_crash_closed_once_and_launched_again_only_on_request(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("crashy")
    await manager.launch(identity.id)

    with pytest.raises(BrowserIdentityError, match="exited during browser_navigate") as crashed:
        await manager.call_tool(identity.id, "browser_navigate", {"url": "crash://now"})

    assert crashed.value.code == "crashed"
    assert not manager.is_open(identity.id)
    after = manager.get(identity.id)
    assert after is not None and after.status == "available"
    assert env.event_types() == ["browser.identity.created", "browser.identity.launched", "browser.identity.closed"]
    # Not started again behind the caller's back: the client reconnects a dead server unless it is told not to.
    assert len([entry for entry in env.record(identity.id) if entry["kind"] == "start"]) == 1
    with pytest.raises(BrowserIdentityError) as next_action:
        await manager.call_tool(identity.id, "browser_navigate", {"url": "https://example.org/"})
    assert next_action.value.code == "not_open"

    await manager.launch(identity.id)
    result = await manager.call_tool(identity.id, "browser_navigate", {"url": "https://example.org/"})

    assert "example.org" in result_text(result)
    starts = [entry for entry in env.record(identity.id) if entry["kind"] == "start"]
    assert len(starts) == 2 and starts[0]["pid"] != starts[1]["pid"]
    assert env.event_types().count("browser.identity.launched") == 2


async def test_a_process_that_died_between_calls_is_found_by_the_next_call_and_by_a_close(env: Env) -> None:
    manager = env.manager()
    a = await manager.create("idle a")
    b = await manager.create("idle b")
    await manager.launch(a.id)
    await manager.launch(b.id)
    for identity in (a, b):
        [start] = [entry for entry in env.record(identity.id) if entry["kind"] == "start"]
        os.kill(start["pid"], signal.SIGKILL)

    with pytest.raises(BrowserIdentityError) as crashed:
        await manager.call_tool(a.id, "browser_status")
    await manager.close(b.id)

    assert crashed.value.code == "crashed"
    assert manager.open_count == 0
    closed = [event["data"]["identity_id"] for event in env.events() if event["type"] == "browser.identity.closed"]
    assert sorted(closed) == sorted([a.id, b.id])


async def test_reopens_the_browser_once_when_the_server_says_it_is_gone(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("lost browser")
    write_control(env.mcp_home(identity.id), lose_browser_once=True)
    await manager.launch(identity.id)

    result = await manager.call_tool(identity.id, "browser_snapshot")

    assert not result_is_error(result)
    assert "selector: #go" in result_text(result)
    assert [name for name, _ in env.calls(identity.id)] == [
        "browser_open",
        "browser_snapshot",
        "browser_open",
        "browser_snapshot",
    ]
    assert env.event_types().count("browser.identity.launched") == 1


async def test_reopens_only_once_and_then_returns_what_the_server_said(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("lost twice")
    write_control(env.mcp_home(identity.id), lose_browser_always=True)
    await manager.launch(identity.id)

    result = await manager.call_tool(identity.id, "browser_snapshot")

    assert result_is_error(result) and "browser is gone" in result_text(result)
    assert [name for name, _ in env.calls(identity.id)] == [
        "browser_open",
        "browser_snapshot",
        "browser_open",
        "browser_snapshot",
    ]
    assert manager.is_open(identity.id)


async def test_set_limits_closes_only_the_sessions_beyond_a_lower_max_open_and_caps_new_identities(env: Env) -> None:
    manager = env.manager(max_open=3, max_identities=5)
    a, b, c = [await manager.create(name) for name in "abc"]
    for identity in (a, b, c):
        await manager.launch(identity.id)

    await manager.set_limits(1, 3)

    assert manager.limits == (1, 3)
    assert [manager.is_open(i.id) for i in (a, b, c)] == [False, False, True]
    with pytest.raises(BrowserIdentityError, match="max_identities 3"):
        await manager.create("d")
    await manager.set_limits(2, 4)
    await manager.launch(a.id)
    assert manager.open_count == 2
    assert (await manager.create("d")).name == "d"
    with pytest.raises(ValueError, match="max_open"):
        await manager.set_limits(0, 4)
    assert manager.limits == (2, 4)


async def test_a_lower_max_identities_deletes_nothing(env: Env) -> None:
    manager = env.manager(max_identities=5)
    for name in "abc":
        await manager.create(name)

    await manager.set_limits(1, 1)

    assert len(manager.list_identities()) == 3


# ---------------------------------------------------------------------------
# Close
# ---------------------------------------------------------------------------


async def test_closes_the_browser_before_the_process_so_firefox_flushes_its_profile(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("flush")
    await manager.launch(identity.id)

    await manager.close(identity.id)

    kinds = [(entry["kind"], entry.get("name")) for entry in env.record(identity.id)]
    assert kinds[-3:] == [("call", "browser_close"), ("done", "browser_close"), ("exit", None)]
    assert env.record(identity.id)[-1]["code"] == 0


async def test_closing_a_closed_identity_is_a_no_op_and_an_unknown_one_is_not_found(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("shut")

    await manager.close(identity.id)
    with pytest.raises(BrowserIdentityError) as unknown:
        await manager.close("nobody-abcdef")

    assert unknown.value.code == "not_found"
    assert env.event_types() == ["browser.identity.created"]


async def test_a_close_the_server_refuses_still_ends_the_process_and_emits_closed_once(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("stubborn")
    write_control(env.mcp_home(identity.id), refuse_close=True)
    await manager.launch(identity.id)

    await manager.close(identity.id)

    assert not manager.is_open(identity.id)
    assert env.event_types().count("browser.identity.closed") == 1
    assert env.record(identity.id)[-1]["kind"] == "exit"


async def test_close_all_stops_every_server(env: Env) -> None:
    manager = env.manager()
    a, b = await manager.create("a"), await manager.create("b")
    await asyncio.gather(manager.launch(a.id), manager.launch(b.id))
    assert manager.open_count == 2

    await manager.close_all()

    assert manager.open_count == 0
    assert all(i.status == "available" for i in manager.list_identities())
    assert env.event_types().count("browser.identity.closed") == 2
    for identity in (a, b):
        assert [e["kind"] for e in env.record(identity.id)][-1] == "exit"
    await manager.close_all()
    assert env.event_types().count("browser.identity.closed") == 2


async def test_close_all_goes_on_when_one_close_fails(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = env.manager()
    a, b = await manager.create("a"), await manager.create("b")
    await asyncio.gather(manager.launch(a.id), manager.launch(b.id))
    emit_closed = manager._emit_closed

    def failing(identity_id: str) -> None:
        if identity_id == a.id:
            raise RuntimeError("the database is gone")
        emit_closed(identity_id)

    monkeypatch.setattr(manager, "_emit_closed", failing)

    await manager.close_all()

    assert manager.open_count == 0
    assert [event["data"]["identity_id"] for event in env.events() if event["type"] == "browser.identity.closed"] == [b.id]
    for identity in (a, b):
        assert env.record(identity.id)[-1]["kind"] == "exit"


# ---------------------------------------------------------------------------
# Order
# ---------------------------------------------------------------------------


async def test_launches_run_one_at_a_time_and_never_beyond_max_open(env: Env) -> None:
    manager = env.manager(max_open=2)
    identities = [await manager.create(name) for name in "abcd"]
    peak = 0

    async def launch(identity_id: str) -> None:
        nonlocal peak
        await manager.launch(identity_id)
        peak = max(peak, manager.open_count)

    await asyncio.gather(*(launch(i.id) for i in identities))

    assert peak <= 2 and manager.open_count == 2
    types = env.event_types()
    assert types.count("browser.identity.launched") == 4 and types.count("browser.identity.closed") == 2


async def test_a_delete_waits_for_a_launch_in_flight_and_then_closes_what_it_opened(env: Env) -> None:
    manager = env.manager(open_retry_initial_s=0.05, open_retry_max_s=0.05)
    identity = await manager.create("busy")
    write_control(env.mcp_home(identity.id), download_answers=2)

    launching = asyncio.create_task(manager.launch(identity.id))
    await asyncio.sleep(0.2)
    await manager.delete(identity.id)
    await launching

    assert env.event_types() == [
        "browser.identity.created",
        "browser.identity.launched",
        "browser.identity.closed",
        "browser.identity.deleted",
    ]
    assert not (env.browsers / identity.id).exists() and manager.open_count == 0


async def test_calls_on_one_identity_run_one_at_a_time(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("serial")
    await manager.launch(identity.id)

    await asyncio.gather(
        manager.call_tool(identity.id, "browser_navigate", {"url": "slow://first"}),
        manager.call_tool(identity.id, "browser_status"),
    )

    trace = [(entry["kind"], entry["name"]) for entry in env.record(identity.id) if entry["kind"] in ("call", "done")]
    assert trace[2:] == [
        ("call", "browser_navigate"),
        ("done", "browser_navigate"),
        ("call", "browser_status"),
        ("done", "browser_status"),
    ]


async def test_a_close_waits_for_the_call_in_flight(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("patient")
    await manager.launch(identity.id)

    call = asyncio.create_task(manager.call_tool(identity.id, "browser_navigate", {"url": "slow://x"}))
    await asyncio.sleep(0.15)
    await manager.close(identity.id)

    assert result_text(await call) == "200 slow://x"
    trace = [(entry["kind"], entry.get("name")) for entry in env.record(identity.id) if entry["kind"] != "start"]
    assert trace[-4:] == [
        ("done", "browser_navigate"),
        ("call", "browser_close"),
        ("done", "browser_close"),
        ("exit", None),
    ]


async def test_a_launch_that_is_cancelled_leaves_nothing_open_and_the_next_one_works(env: Env) -> None:
    manager = env.manager(open_retry_initial_s=0.05, open_retry_max_s=0.05)
    identity = await manager.create("interrupted")
    write_control(env.mcp_home(identity.id), download_answers=1000)

    launching = asyncio.create_task(manager.launch(identity.id))
    # Cancel once the server answered `browser_open` with progress, however long its process took to start.
    async with asyncio.timeout(30):
        while not env.calls(identity.id):
            await asyncio.sleep(0.02)
    launching.cancel()
    with pytest.raises(asyncio.CancelledError):
        await launching

    assert manager.open_count == 0
    assert env.record(identity.id)[-1]["kind"] == "exit"
    write_control(env.mcp_home(identity.id), download_answers=0)
    await asyncio.wait_for(manager.launch(identity.id), 30)
    assert manager.is_open(identity.id)


async def test_events_are_in_the_same_transaction_as_the_record(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("atomic")

    rows = env.store.read(lambda conn: conn.execute("SELECT count(*) FROM dots_browser_identities").fetchone()[0])
    assert rows == 1 and env.event_types() == ["browser.identity.created"]

    await manager.delete(identity.id)

    rows = env.store.read(lambda conn: conn.execute("SELECT count(*) FROM dots_browser_identities").fetchone()[0])
    assert rows == 0 and env.event_types()[-1] == "browser.identity.deleted"


async def test_the_event_listener_of_the_store_hears_the_identity_events(env: Env) -> None:
    heard: list[int] = []
    remove = env.store.on_append(lambda: heard.append(1))
    manager = env.manager()

    await manager.create("heard")

    remove()
    assert heard == [1]
