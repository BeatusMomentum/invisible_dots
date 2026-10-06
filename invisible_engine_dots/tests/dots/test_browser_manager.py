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
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import pytest
from fakes.browser_manager import mcp_home
from fakes.fake_mcp_server import install_fake_mcp, proxy_forms, read_record, write_control
from fakes.local_computer import LocalComputer

from nanobot.agent.tools.base import ToolResult
from nanobot.dots import store as dots_store
from nanobot.dots.browser import (
    BrowserIdentityError,
    BrowserManager,
    _proxy_stderr_filter,
    _scrub,
    result_is_error,
    result_text,
)
from nanobot.dots.protocol import BROWSER_ENV, BROWSERS_DIR, MCP_HOMES_DIR
from nanobot.dots.store import DotStore

FAST = {"open_retry_initial_s": 0.01, "open_retry_max_s": 0.02}


class Env:
    """A manager on a real store, a local computer and the fake MCP server."""

    def __init__(self, tmp_path: Path, store: DotStore) -> None:
        self.tmp_path = tmp_path
        self.store = store
        self.browsers = tmp_path / "browsers"
        self.mcp_homes = tmp_path / "mcp-homes"
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
            "mcp_homes_dir": str(self.mcp_homes),
            **FAST,
            **options,
        }
        manager = BrowserManager(**settings)
        self.managers.append(manager)
        return manager

    def mcp_home(self, identity_id: str) -> Path:
        return mcp_home(self.tmp_path, identity_id)

    def record(self, identity_id: str) -> list[dict[str, Any]]:
        return read_record(self.mcp_home(identity_id))

    async def until_recorded(self, identity_id: str, kind: str, name: str, timeout_s: float = 30) -> None:
        """Wait until the fake MCP server has recorded an entry: its process start time is not the test's to guess."""
        async with asyncio.timeout(timeout_s):
            while not any(e["kind"] == kind and e.get("name") == name for e in self.record(identity_id)):
                await asyncio.sleep(0.01)

    def calls(self, identity_id: str) -> list[tuple[str, dict[str, Any]]]:
        return [(entry["name"], entry["args"]) for entry in self.record(identity_id) if entry["kind"] == "call"]

    def events(self) -> list[dict[str, Any]]:
        rows = self.store.read(lambda conn: dots_store.read_outbox_after(conn, 0, 1000))
        return [row for row in rows if row["type"].startswith("browser.identity.")]

    def event_types(self) -> list[str]:
        return [row["type"] for row in self.events()]


async def _until(condition: Callable[[], bool], timeout_s: float = 10.0) -> None:
    """Wait for something the manager does by itself."""
    async with asyncio.timeout(timeout_s):
        while not condition():
            await asyncio.sleep(0.02)


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
    assert (root / "profile").is_dir() and env.mcp_home(identity.id).is_dir()
    assert not (root / "mcp").exists()
    assert not (root / "metadata.json").exists()
    assert (identity.name, identity.status, identity.last_used_at, identity.has_proxy) == (
        "Shopping Account",
        "available",
        None,
        False,
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


async def test_refuses_an_empty_name_and_more_than_max_identities(env: Env) -> None:
    manager = env.manager(max_identities=2)

    with pytest.raises(BrowserIdentityError, match="non-empty name") as empty:
        await manager.create("   ")
    assert empty.value.code == "invalid"
    await manager.create("one")
    await manager.create("two")
    with pytest.raises(BrowserIdentityError, match="max_identities 2") as limit:
        await manager.create("three")
    assert limit.value.code == "limit"
    assert env.event_types() == ["browser.identity.created"] * 2
    assert len(list((env.browsers).iterdir())) == 2


async def test_the_proxy_is_kept_as_given_for_the_launch_and_shown_to_no_one(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("proxied", "http://user:pw@proxy.test:8080")

    assert identity.has_proxy
    stored = env.store.read(lambda conn: dots_store.get_identity(conn, identity.id))
    assert stored is not None and stored.proxy == "http://user:pw@proxy.test:8080"
    assert not any(text in repr(identity) + str(env.events()) for text in ("pw", "user", "proxy.test"))
    assert manager.list_identities() == [identity]


@pytest.mark.parametrize("proxy", ["not a url", "ftp://host:21", "http://host", "  socks5://user:s3cr3t-pw@host:1080  "])
async def test_a_proxy_is_not_judged_by_the_manager_and_reaches_the_server_as_written(env: Env, proxy: str) -> None:
    # invisible-playwright-mcp owns the reading of a proxy (its scheme, host and port, its errors): the manager
    # keeps what it is given and hands it over unchanged, at the launch.
    manager = env.manager()
    identity = await manager.create("as written", proxy)

    await manager.launch(identity.id)

    [start] = [entry for entry in env.record(identity.id) if entry["kind"] == "start"]
    assert start["env"][BROWSER_ENV["PROXY"]] == proxy


async def test_delete_closes_the_session_removes_the_directory_and_the_row(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("temp")
    await manager.launch(identity.id)

    assert env.mcp_home(identity.id).is_dir()

    await manager.delete(identity.id)

    assert not (env.browsers / identity.id).exists()
    assert not env.mcp_home(identity.id).exists()
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
    env.mcp_home(identity.id).rmdir()
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
    assert environment[BROWSER_ENV["MCP_HOME"]] == str(env.mcp_home(identity.id))
    assert environment[BROWSER_ENV["MCP_SESSION_ID"]] == identity.id
    assert environment[BROWSER_ENV["PROFILE_DIR"]] == str(root / "profile")
    assert environment[BROWSER_ENV["HEADLESS"]] == "0"
    assert environment[BROWSER_ENV["DISPLAY"]] == ":7"
    assert environment[BROWSER_ENV["PROXY"]] == "http://user:pw@proxy.test:8080"
    # No self-repair of invisible_core from the package index.
    assert environment[BROWSER_ENV["CORE_AUTOFIX"]] == "off"
    assert "OPENROUTER_API_KEY" not in environment and "SOME_OTHER_SECRET" not in environment
    assert start["cwd"] == str(root)

    # The one spawn of the program is the relay's: the working directory, the variables in the order of
    # the table and then the program, which is what runs it as dot in the guest. The proxy, which has a
    # password, is not among the variables of the command line: the relay is told its name and reads the
    # value from its own environment.
    relay = [json.loads(line) for line in env.relay_log.read_text(encoding="utf-8").splitlines()]
    mcp_runs = [entry for entry in relay if entry["program"] == [str(env.mcp_bin)]]
    assert len(mcp_runs) == 1
    assert mcp_runs[0]["cwd"] == str(root)
    assert [pair.partition("=")[0] for pair in mcp_runs[0]["env"]] == [
        BROWSER_ENV[name]
        for name in ("MCP_HOME", "MCP_SESSION_ID", "PROFILE_DIR", "HEADLESS", "DISPLAY", "CORE_AUTOFIX")
    ]
    assert mcp_runs[0]["env_from"] == [BROWSER_ENV["PROXY"]]
    assert "user:pw" not in json.dumps(mcp_runs[0])
    assert not mcp_runs[0]["tty"]


def test_the_default_home_of_the_servers_is_outside_the_directory_the_host_reads() -> None:
    # The host's file routes read /home/dot and nothing else (checkHomePath); the server saves the proxy of its
    # browser, password included, under its home.
    assert BROWSERS_DIR.startswith("/home/dot/")
    assert not (MCP_HOMES_DIR + "/").startswith("/home/dot/")


async def test_the_session_file_with_the_proxy_password_is_under_the_servers_home_and_nowhere_in_the_browsers_directory(
    env: Env,
) -> None:
    manager = env.manager()
    identity = await manager.create("shop", "http://user:pw-secret@proxy.test:8080")

    await manager.launch(identity.id)

    session_file = env.mcp_home(identity.id) / "sessions" / f"{identity.id}.json"
    assert "pw-secret" in session_file.read_text(encoding="utf-8")
    assert env.mcp_homes not in env.browsers.parents and env.browsers not in env.mcp_homes.parents
    holders = [path for path in env.browsers.rglob("*") if path.is_file() and b"pw-secret" in path.read_bytes()]
    assert holders == []


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


async def test_what_the_server_says_of_the_proxy_reaches_the_caller_hidden(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("echo", "http://user:s3cret@proxy.test:8080")
    write_control(env.mcp_home(identity.id), fail_open=True, echo_proxy=True)

    with pytest.raises(BrowserIdentityError) as failed:
        await manager.launch(identity.id)

    assert "[proxy]" in failed.value.message
    assert "s3cret" not in failed.value.message and "proxy.test" not in failed.value.message


async def test_what_a_page_tool_returns_of_the_proxy_is_hidden_in_results_and_in_errors(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("echo pages", "http://user:s3cret@proxy.test:8080")
    write_control(env.mcp_home(identity.id), echo_proxy_on_pages=True)
    await manager.launch(identity.id)

    failed = await manager.call_tool(identity.id, "browser_navigate", {"url": "https://example.org/"})
    read = await manager.call_tool(identity.id, "browser_read_text", {})

    assert result_is_error(failed) and not result_is_error(read)
    for result in (failed, read):
        assert "[proxy]" in result_text(result)
        assert "s3cret" not in result_text(result) and "proxy.test" not in result_text(result)


# The credentials of the first proxy are written percent-encoded, with a lowercase escape, so the password as
# written, decoded and encoded again are different strings. The second one has a quote, a backslash and a slash
# in its password: its repr, its JSON-escaped text and `quote` with the default `safe="/"` differ from those too.
ENCODED_PROXY = "http://us%40er:p%40ss%3aword@proxy.test:8080"
ESCAPING_PROXY = "http://us%40er:p%22a%5cb%2fc%27d%40e@proxy.test:8080"
PASSWORD_FORMS = (
    "password_as_written",
    "password_decoded",
    "password_encoded_again",
    "password_encoded_keeping_slash",
    "password_repr",
    "password_json",
    "basic_credentials",
)
# How many of PASSWORD_FORMS are different strings for each proxy.
DISTINCT_FORMS = {ENCODED_PROXY: 4, ESCAPING_PROXY: 7}


def password_secrets(proxy: str) -> list[str]:
    """The strings of `proxy` that must reach no answer, no journal and no transcript."""
    forms = proxy_forms(proxy)
    secrets = list(dict.fromkeys(forms[name] for name in PASSWORD_FORMS))
    assert len(secrets) == DISTINCT_FORMS[proxy]
    return secrets


async def journal_until(capfd: pytest.CaptureFixture[str], marker: str) -> str:
    """What the engine wrote to its stderr, which the journal keeps, until `marker` is in it."""
    journal = ""
    async with asyncio.timeout(15):
        while marker not in journal:
            journal += capfd.readouterr().err
            await asyncio.sleep(0.02)
    return journal


@pytest.mark.parametrize("proxy", [ENCODED_PROXY, ESCAPING_PROXY])
@pytest.mark.parametrize("form", sorted(proxy_forms(ENCODED_PROXY)))
async def test_the_password_leaves_in_no_form_a_server_can_repeat_it(env: Env, proxy: str, form: str) -> None:
    manager = env.manager()
    identity = await manager.create("forms", proxy)
    mcp_home = env.mcp_home(identity.id)
    secrets = password_secrets(proxy)

    write_control(mcp_home, fail_open=True, echo_proxy_as=form)
    with pytest.raises(BrowserIdentityError) as failed_launch:
        await manager.launch(identity.id)
    write_control(mcp_home, echo_proxy_as=form)
    await manager.launch(identity.id)
    failed = await manager.call_tool(identity.id, "browser_navigate", {"url": "https://example.org/"})
    read = await manager.call_tool(identity.id, "browser_read_text", {})

    assert result_is_error(failed) and not result_is_error(read)
    # The whole URL is replaced by "[proxy]" and a piece of its credentials by "***".
    hidden = "[proxy]" if form.startswith("url_") else "***"
    for said in (failed_launch.value.message, result_text(failed), result_text(read)):
        assert hidden in said
        for secret in secrets:
            assert secret not in said


@pytest.mark.parametrize("proxy", [ENCODED_PROXY, ESCAPING_PROXY])
async def test_the_password_does_not_reach_the_journal_through_the_stderr_of_the_server(
    env: Env, capfd: pytest.CaptureFixture[str], proxy: str
) -> None:
    manager = env.manager()
    identity = await manager.create("journal", proxy)
    write_control(env.mcp_home(identity.id), stderr_proxy=True)
    secrets = password_secrets(proxy)
    capfd.readouterr()

    await manager.launch(identity.id)
    journal = await journal_until(capfd, "[stderr written]")
    await manager.close(identity.id)

    # Everything the server wrote got through with the credentials hidden: a line for each form, and the long
    # line, which the pump has to cut, so a password may be split across two reads.
    for name in proxy_forms(proxy):
        assert f"[{name}] " in journal
    assert "[url] [proxy]" in journal
    assert journal.count("padding") >= 40_000
    assert "***" in journal
    for secret in secrets:
        assert secret not in journal


async def test_the_stderr_of_a_server_with_a_proxy_without_a_password_reaches_the_journal_as_it_is(
    env: Env, capfd: pytest.CaptureFixture[str]
) -> None:
    manager = env.manager()
    identity = await manager.create("open proxy", "http://proxy.test:8080")
    write_control(env.mcp_home(identity.id), stderr_proxy=True)
    capfd.readouterr()

    await manager.launch(identity.id)
    journal = await journal_until(capfd, "[stderr written]")

    assert "[url] http://proxy.test:8080\n" in journal
    assert "***" not in journal


def test_a_password_with_a_backslash_and_both_quotes_is_hidden_in_a_traceback_and_in_json() -> None:
    # Written raw in the URL, as a user may paste it: `repr` doubles the backslash and escapes the single quote
    # (the URL holds both kinds), `json.dumps` escapes the double quote and the backslash.
    proxy = "http://us\"er:pa\"ss\\w'rd@proxy.test:8080"
    password = "pa\"ss\\w'rd"
    texts = [
        str(ValueError(f"proxy URL {proxy!r} is not valid")),
        json.dumps({"error": f"cannot use {proxy}"}),
        json.dumps({"password": password}),
        f"{{'password': {password!r}}}",
        f"proxy password {password}",
    ]

    for text in texts:
        scrubbed = _scrub(text, proxy)
        assert scrubbed != text
        for piece in ("w'rd", "w\\'rd", "w\\\\'rd", "ss\\\\w", "pa\\\"ss", "pa\"ss"):
            assert piece not in scrubbed, (piece, scrubbed)


@pytest.mark.parametrize(
    ("proxy", "said", "scrubbed"),
    [
        ("socks5://user@proxy.test:1080", "refused socks5://user@proxy.test:1080", "refused [proxy]"),
        ("http://[::1", "refused http://[::1", "refused [proxy]"),
        ("socks5://proxy.test:1080", "refused socks5://proxy.test:1080", "refused socks5://proxy.test:1080"),
        ("not a url", "refused not a url", "refused not a url"),
    ],
    ids=["a user alone", "a URL that cannot be read", "no credentials", "not a URL"],
)
def test_a_proxy_is_hidden_when_it_carries_credentials_or_cannot_be_read_and_otherwise_left_alone(
    proxy: str, said: str, scrubbed: str
) -> None:
    # What the library prints of a proxy with nothing secret in it (scheme, host, port) is its own safe form.
    assert _scrub(said, proxy) == scrubbed


def test_the_stderr_filter_of_a_proxy_knows_the_longest_text_it_hides() -> None:
    # No rule bounds the length of a proxy, and an escaped form is up to 12 times longer than the password.
    password = "\U0001f98a" * 3000
    proxy = f"http://user:{password}@proxy.test:8080"

    found = _proxy_stderr_filter(proxy)

    assert found.longest_match >= len(json.dumps(f"user:{password}")[1:-1])
    assert found.longest_match >= len(proxy)
    assert found.scrub(f"log {json.dumps(password)[1:-1]} end") == "log *** end"


async def test_a_proxy_without_a_password_leaves_what_the_server_says_as_it_is(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("open proxy", "http://proxy.test:8080")
    write_control(env.mcp_home(identity.id), echo_proxy_on_pages=True)
    await manager.launch(identity.id)

    read = await manager.call_tool(identity.id, "browser_read_text", {})

    assert result_text(read) == "page behind http://proxy.test:8080"


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
        await manager.call_tool(identity.id, "browser_navigate", {"url": "https://crash.test/now"})

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


async def test_a_process_that_dies_while_idle_closes_its_identity_at_once_and_frees_its_slot(env: Env) -> None:
    manager = env.manager(max_open=2)
    a, b, c = [await manager.create(name) for name in ("idle a", "idle b", "idle c")]
    await manager.launch(a.id)
    await manager.launch(b.id)
    [start] = [entry for entry in env.record(a.id) if entry["kind"] == "start"]

    os.kill(start["pid"], signal.SIGKILL)
    # No call and no close: the manager finds out by itself.
    await _until(lambda: not manager.is_open(a.id))

    assert manager.open_count == 1 and manager.is_open(b.id)
    assert env.event_types().count("browser.identity.closed") == 1
    # The dead identity no longer holds a slot, so opening another closes nothing that lives.
    await manager.launch(c.id)
    assert [manager.is_open(i.id) for i in (a, b, c)] == [False, True, True]
    with pytest.raises(BrowserIdentityError) as next_action:
        await manager.call_tool(a.id, "browser_status")
    assert next_action.value.code == "not_open"
    await manager.close(a.id)
    closed = [event["data"]["identity_id"] for event in env.events() if event["type"] == "browser.identity.closed"]
    assert closed == [a.id]
    after = manager.get(a.id)
    assert after is not None and after.status == "available"


def _process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def test_a_browser_the_server_says_is_gone_closes_the_identity_and_is_not_reopened_behind_the_model(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("lost browser")
    write_control(env.mcp_home(identity.id), lose_browser_once=True)
    await manager.launch(identity.id)
    [start] = [entry for entry in env.record(identity.id) if entry["kind"] == "start"]

    with pytest.raises(BrowserIdentityError) as lost:
        await manager.call_tool(identity.id, "browser_snapshot")

    # The model is told in its own vocabulary what the library says (the browser is gone, it came back as the
    # same person) and what to call: it cannot call browser_open, the launch is its way.
    assert lost.value.code == "crashed"
    assert lost.value.message == (
        f'the browser of identity "{identity.id}" is gone: it closed or crashed during browser_snapshot. '
        "The identity is closed and keeps its profile: call browser_identity_launch to open it again as the same "
        "person, then navigate again, because it comes back on a blank page"
    )
    assert "browser_open" not in lost.value.message
    # One call, no browser_open and no second snapshot: nothing was repeated and nothing was opened.
    assert [name for name, _ in env.calls(identity.id)] == ["browser_open", "browser_snapshot"]
    assert not manager.is_open(identity.id) and manager.open_count == 0
    after = manager.get(identity.id)
    assert after is not None and after.status == "available"
    assert env.event_types() == ["browser.identity.created", "browser.identity.launched", "browser.identity.closed"]
    # The server's process is stopped with the identity (its browser is not coming back), as a close stops it.
    await _until(lambda: not _process_is_alive(start["pid"]))
    with pytest.raises(BrowserIdentityError) as next_action:
        await manager.call_tool(identity.id, "browser_snapshot")
    assert next_action.value.code == "not_open"
    assert [name for name, _ in env.calls(identity.id)] == ["browser_open", "browser_snapshot"]


async def test_a_page_that_says_the_browser_is_gone_in_a_failed_click_does_not_close_the_identity(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("hostile overlay")
    write_control(env.mcp_home(identity.id), overlay_says_gone=True)
    await manager.launch(identity.id)

    result = await manager.call_tool(identity.id, "browser_click", {"selector": "#go"})

    # The error is the page's answer and passes through as it is; the identity stays open and nothing was closed.
    assert result_is_error(result) and "the main browser is gone" in result_text(result)
    assert manager.is_open(identity.id)
    assert env.event_types() == ["browser.identity.created", "browser.identity.launched"]
    follow_up = await manager.call_tool(identity.id, "browser_snapshot")
    assert not result_is_error(follow_up)
    assert [name for name, _ in env.calls(identity.id)] == ["browser_open", "browser_click", "browser_snapshot"]


GONE_SENTENCE = (
    "the main browser is gone: it closed or crashed. Call browser_open to open it again; "
    "it comes back as the same person."
)
NOT_OPEN_SENTENCE = "the main browser is not open. Call browser_open to open it."


@pytest.mark.parametrize(
    ("text", "lost"),
    [
        (GONE_SENTENCE, True),
        (NOT_OPEN_SENTENCE, True),
        (f"Error executing tool browser_click: {GONE_SENTENCE}", True),
        (f"Error executing tool browser_navigate: {NOT_OPEN_SENTENCE}\n", True),
        # What a page controls inside a longer error: never the library's whole answer.
        ('click failed: {"covered_by": {"text": "the main browser is gone"}}', False),
        (f"Error executing tool browser_click: click on #a failed: {GONE_SENTENCE}", False),
        (f"Error executing tool browser_click: {GONE_SENTENCE} and then some page text", False),
        ("no option in #size has the value or the label 'the main browser is not open'", False),
        ("the support browser is gone: it closed or crashed.", False),
    ],
)
def test_only_the_librarys_whole_sentence_is_a_lost_browser(text: str, lost: bool) -> None:
    assert BrowserManager._is_browser_lost(ToolResult.error(text)) is lost
    assert BrowserManager._is_browser_lost(text) is False


async def test_the_launch_that_follows_a_lost_browser_makes_a_new_server_and_the_identity_works_again(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("lost, then launched")
    write_control(env.mcp_home(identity.id), lose_browser_once=True)
    await manager.launch(identity.id)
    with pytest.raises(BrowserIdentityError):
        await manager.call_tool(identity.id, "browser_snapshot")

    write_control(env.mcp_home(identity.id))
    await manager.launch(identity.id)
    result = await manager.call_tool(identity.id, "browser_snapshot")

    assert not result_is_error(result)
    assert "selector: #go" in result_text(result)
    starts = [entry for entry in env.record(identity.id) if entry["kind"] == "start"]
    assert len(starts) == 2 and starts[0]["pid"] != starts[1]["pid"]
    assert env.event_types().count("browser.identity.launched") == 2
    assert env.event_types().count("browser.identity.closed") == 1


async def test_a_lost_browser_frees_its_slot_of_max_open(env: Env) -> None:
    manager = env.manager(max_open=1)
    a, b = [await manager.create(name) for name in ("lost a", "other b")]
    write_control(env.mcp_home(a.id), lose_browser_always=True)
    await manager.launch(a.id)
    with pytest.raises(BrowserIdentityError):
        await manager.call_tool(a.id, "browser_snapshot")

    await manager.launch(b.id)

    # The identity that was lost holds no slot, so b opened without closing anything that lived.
    assert [manager.is_open(i.id) for i in (a, b)] == [False, True]
    assert env.event_types().count("browser.identity.closed") == 1


async def test_set_limits_closes_only_the_sessions_beyond_a_lower_max_open_and_caps_new_identities(env: Env) -> None:
    manager = env.manager(max_open=3, max_identities=5)
    a, b, c = [await manager.create(name) for name in "abc"]
    for identity in (a, b, c):
        await manager.launch(identity.id)

    manager.set_limits(1, 3)

    assert manager.limits == (1, 3)
    assert [manager.is_open(i.id) for i in (a, b, c)] == [False, False, True]
    with pytest.raises(BrowserIdentityError, match="max_identities 3"):
        await manager.create("d")
    manager.set_limits(2, 4)
    await manager.launch(a.id)
    assert manager.open_count == 2
    assert (await manager.create("d")).name == "d"
    with pytest.raises(ValueError, match="max_open"):
        manager.set_limits(0, 4)
    assert manager.limits == (2, 4)


async def test_a_lower_max_identities_deletes_nothing(env: Env) -> None:
    manager = env.manager(max_identities=5)
    for name in "abc":
        await manager.create(name)

    manager.set_limits(1, 1)

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


async def start_slow_launch(env: Env, manager: BrowserManager, name: str) -> tuple[str, asyncio.Task[Any]]:
    """A launch that is still waiting for the engine's download: the identity's id and the launch's task."""
    identity = await manager.create(name)
    write_control(env.mcp_home(identity.id), download_answers=100_000)
    launching = asyncio.create_task(manager.launch(identity.id))
    await env.until_recorded(identity.id, "call", "browser_open")
    return identity.id, launching


async def stop_launch(launching: asyncio.Task[Any]) -> None:
    launching.cancel()
    with pytest.raises(asyncio.CancelledError):
        await launching


async def test_a_launch_in_flight_holds_up_no_other_identity_and_no_config_change(env: Env) -> None:
    manager = env.manager(max_open=3, open_retry_initial_s=0.05, open_retry_max_s=0.05)
    other = await manager.create("other")
    spare = await manager.create("spare")
    await manager.launch(other.id)
    slow_id, launching = await start_slow_launch(env, manager, "slow")

    async with asyncio.timeout(10):
        manager.set_limits(3, 30)
        await manager.close(other.id)
        await manager.delete(spare.id)
        fresh = await manager.create("fresh")

    assert not launching.done()
    assert manager.get(spare.id) is None and manager.get(fresh.id) is not None
    assert not manager.is_open(slow_id) and not manager.is_open(other.id)
    await stop_launch(launching)
    assert manager.open_count == 0


async def test_a_lower_max_open_answers_at_once_and_closes_the_excess_in_the_background(env: Env) -> None:
    manager = env.manager(max_open=3)
    a, b, c = [await manager.create(name) for name in "abc"]
    for identity in (a, b, c):
        await manager.launch(identity.id)

    manager.set_limits(1, 20)

    # Nothing has been closed yet, but only c counts as open and the others cannot be used.
    assert [manager.is_open(i.id) for i in (a, b, c)] == [False, False, True]
    assert env.event_types().count("browser.identity.closed") == 0
    with pytest.raises(BrowserIdentityError) as refused:
        await manager.call_tool(a.id, "browser_status")
    assert refused.value.code == "not_open"
    await manager.close_all()
    assert sorted(
        event["data"]["identity_id"] for event in env.events() if event["type"] == "browser.identity.closed"
    ) == sorted([a.id, b.id, c.id])
    for identity in (a, b):
        assert env.record(identity.id)[-1]["kind"] == "exit"


async def test_a_lower_max_open_closes_a_browser_that_is_still_opening_once_it_has_opened(env: Env) -> None:
    manager = env.manager(max_open=2, open_retry_initial_s=0.05, open_retry_max_s=0.05)
    identity = await manager.create("late")
    write_control(env.mcp_home(identity.id), download_answers=3)
    launching = asyncio.create_task(manager.launch(identity.id))
    await asyncio.sleep(0.1)
    other = await manager.create("other")
    await manager.launch(other.id)

    manager.set_limits(1, 20)
    await launching
    await manager.close_all()

    assert env.event_types().count("browser.identity.launched") == 2
    assert sorted(
        event["data"]["identity_id"] for event in env.events() if event["type"] == "browser.identity.closed"
    ) == sorted([identity.id, other.id])


async def test_two_launches_of_one_identity_start_one_browser_and_share_the_outcome(env: Env) -> None:
    manager = env.manager(open_retry_initial_s=0.05, open_retry_max_s=0.05)
    identity = await manager.create("shared")
    write_control(env.mcp_home(identity.id), download_answers=2)

    first, second = await asyncio.gather(manager.launch(identity.id), manager.launch(identity.id))

    assert first.status == second.status == "open"
    assert len([entry for entry in env.record(identity.id) if entry["kind"] == "start"]) == 1
    assert env.event_types().count("browser.identity.launched") == 1

    broken = await manager.create("broken")
    write_control(env.mcp_home(broken.id), fail_open=True)
    outcomes = await asyncio.gather(manager.launch(broken.id), manager.launch(broken.id), return_exceptions=True)

    assert all(isinstance(o, BrowserIdentityError) and o.code == "launch_failed" for o in outcomes)
    assert len([entry for entry in env.record(broken.id) if entry["kind"] == "start"]) == 1
    assert manager.open_count == 1


async def test_a_launch_of_an_identity_that_is_being_deleted_is_not_found(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("going")
    await manager.launch(identity.id)

    deleting = asyncio.create_task(manager.delete(identity.id))
    await asyncio.sleep(0)
    with pytest.raises(BrowserIdentityError) as launch:
        await manager.launch(identity.id)
    with pytest.raises(BrowserIdentityError) as again:
        await manager.delete(identity.id)
    await deleting

    assert launch.value.code == again.value.code == "not_found"
    assert not (env.browsers / identity.id).exists() and manager.get(identity.id) is None
    assert env.event_types().count("browser.identity.deleted") == 1


async def test_a_close_that_raises_still_ends_the_process_and_leaves_the_identity_launchable(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = env.manager()
    identity = await manager.create("fragile")
    await manager.launch(identity.id)
    request = manager._request

    async def failing(session: Any, tool: str, arguments: Any) -> Any:
        if tool == "browser_close":
            raise ConnectionError("the pipe is gone")
        return await request(session, tool, arguments)

    monkeypatch.setattr(manager, "_request", failing)
    await manager.close(identity.id)
    monkeypatch.undo()

    assert not manager.is_open(identity.id)
    assert env.event_types().count("browser.identity.closed") == 1
    assert env.record(identity.id)[-1]["kind"] == "exit"
    await asyncio.wait_for(manager.launch(identity.id), 30)
    assert manager.is_open(identity.id)


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


def _process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def test_a_launch_that_is_cancelled_leaves_nothing_open_and_the_next_one_works(env: Env) -> None:
    manager = env.manager(open_retry_initial_s=0.05, open_retry_max_s=0.05)
    identity = await manager.create("interrupted")
    write_control(env.mcp_home(identity.id), download_answers=1000)

    launching = asyncio.create_task(manager.launch(identity.id))
    # Cancel once the server has answered browser_open, so the launch is inside its retry loop. A fixed
    # sleep cancelled it before the process had started when the machine was loaded.
    def asked() -> bool:
        return any(e["kind"] == "done" and e.get("name") == "browser_open" for e in env.record(identity.id))

    await _until(asked, 30)
    launching.cancel()
    with pytest.raises(asyncio.CancelledError):
        await launching

    assert manager.open_count == 0
    # The process is gone. It is not asked for a clean exit record: the SDK ends a server that is slow to
    # leave after 2 s, which a loaded machine makes slow.
    (pid,) = [e["pid"] for e in env.record(identity.id) if e["kind"] == "start"]
    await _until(lambda: not _process_exists(pid), 30)
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


# ---------------------------------------------------------------------------
# The frame the UI shows
# ---------------------------------------------------------------------------


async def test_a_frame_is_the_jpeg_of_the_servers_watch_and_asks_nothing_else(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("watched")
    await manager.launch(identity.id)

    mime, data = await manager.frame(identity.id)

    assert mime == "image/jpeg"
    assert data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9")
    assert [name for name, _ in env.calls(identity.id)] == ["browser_open", "browser_watch"]
    assert env.calls(identity.id)[-1][1] == {"browser": "main"}


async def test_a_frame_is_not_a_use_so_a_page_that_polls_cannot_keep_a_browser_open(env: Env) -> None:
    manager = env.manager(max_open=2)
    a, b, c = [await manager.create(name) for name in "abc"]
    await manager.launch(a.id)
    await manager.launch(b.id)
    used_before = manager.get(a.id)
    assert used_before is not None and used_before.last_used_at is not None

    for _ in range(3):
        await manager.frame(a.id)
    used_after = manager.get(a.id)
    await manager.launch(c.id)

    # a is still the least recently used, in spite of the frames, so it is the one that closed.
    assert [manager.is_open(i.id) for i in (a, b, c)] == [False, True, True]
    assert used_after is not None and used_after.last_used_at == used_before.last_used_at


async def test_a_frame_of_a_closed_or_unknown_identity_is_refused_and_launches_nothing(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("shut")

    with pytest.raises(BrowserIdentityError) as closed:
        await manager.frame(identity.id)
    with pytest.raises(BrowserIdentityError) as unknown:
        await manager.frame("nobody-abc123")
    with pytest.raises(BrowserIdentityError) as escaping:
        await manager.frame("../x")

    assert closed.value.code == "not_open"
    assert closed.value.message == f"identity {identity.id} is not open; call browser_identity_launch first"
    assert unknown.value.code == escaping.value.code == "not_found"
    assert manager.open_count == 0 and env.record(identity.id) == []


async def test_a_frame_waits_for_the_call_in_flight_only_so_long_and_then_says_busy(env: Env) -> None:
    manager = env.manager(frame_wait_s=0.05)
    identity = await manager.create("occupied")
    await manager.launch(identity.id)

    call = asyncio.create_task(manager.call_tool(identity.id, "browser_navigate", {"url": "slow://x"}))
    await asyncio.sleep(0.1)
    with pytest.raises(BrowserIdentityError) as busy:
        await manager.frame(identity.id)
    await call
    waited = await manager.frame(identity.id)

    assert busy.value.code == "busy"
    assert waited[0] == "image/jpeg"
    names = [name for name, _ in env.calls(identity.id)]
    assert names == ["browser_open", "browser_navigate", "browser_watch"]


async def test_a_frame_does_not_open_a_browser_the_server_lost_and_closes_the_identity_like_a_call(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("lost for the frame")
    write_control(env.mcp_home(identity.id), lose_browser_always=True)
    await manager.launch(identity.id)

    with pytest.raises(BrowserIdentityError) as lost:
        await manager.frame(identity.id)

    assert lost.value.code == "not_open"
    assert [name for name, _ in env.calls(identity.id)] == ["browser_open", "browser_watch"]
    # Not "open" with nothing to show: the identity is closed and says so once, as for a call that finds out.
    assert not manager.is_open(identity.id)
    assert env.event_types() == ["browser.identity.created", "browser.identity.launched", "browser.identity.closed"]
    with pytest.raises(BrowserIdentityError) as again:
        await manager.frame(identity.id)
    assert again.value.code == "not_open"
    assert env.event_types().count("browser.identity.closed") == 1


async def test_a_frame_the_server_cannot_give_is_a_frame_failure_with_its_reason(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("no page")
    write_control(env.mcp_home(identity.id), fail_watch=True)
    await manager.launch(identity.id)

    with pytest.raises(BrowserIdentityError) as failed:
        await manager.frame(identity.id)

    assert failed.value.code == "frame_failed"
    assert "no page to watch" in failed.value.message
    assert manager.is_open(identity.id)


async def test_a_frame_that_is_not_a_jpeg_is_a_frame_failure_and_the_browser_stays_open(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("png frame")
    write_control(env.mcp_home(identity.id), watch_png=True)
    await manager.launch(identity.id)

    with pytest.raises(BrowserIdentityError) as failed:
        await manager.frame(identity.id)

    assert failed.value.code == "frame_failed"
    assert "image/png, not image/jpeg" in failed.value.message
    assert manager.is_open(identity.id)


async def test_a_frame_finds_a_process_that_died_and_closes_the_identity_once(env: Env) -> None:
    manager = env.manager()
    identity = await manager.create("dead for the frame")
    await manager.launch(identity.id)
    [start] = [entry for entry in env.record(identity.id) if entry["kind"] == "start"]
    os.kill(start["pid"], signal.SIGKILL)

    with pytest.raises(BrowserIdentityError) as crashed:
        await manager.frame(identity.id)

    assert crashed.value.code == "crashed"
    assert not manager.is_open(identity.id)
    assert env.event_types().count("browser.identity.closed") == 1
