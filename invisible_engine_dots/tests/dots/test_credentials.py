"""The startup assertion: where credentials are on disk, never what they are."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanobot.dots.credentials import (
    CredentialOnDiskError,
    assert_no_credentials_on_disk,
    find_credentials_on_disk,
)

SECRET = "sk-or-secret-value-1234"


@pytest.fixture
def places(tmp_path: Path) -> tuple[Path, Path]:
    """A state directory and a home directory, both empty."""
    state, home = tmp_path / "state", tmp_path / "home"
    state.mkdir()
    (home / ".nanobot").mkdir(parents=True)
    return state, home


def write(path: Path, text: str) -> Path:
    path.write_bytes(text.encode("utf-8"))
    return path


def test_a_clean_state_passes(places: tuple[Path, Path]) -> None:
    state, home = places
    environ = {"PATH": "/usr/bin", "HOME": str(home), "TIKTOKEN_CACHE_DIR": "/x", "INVISIBLE_DOTS_ENGINE_STATE": str(state)}
    assert find_credentials_on_disk(state, home, environ) == []
    assert_no_credentials_on_disk(state, home, environ)


def test_a_state_that_does_not_exist_yet_passes(tmp_path: Path) -> None:
    assert find_credentials_on_disk(tmp_path / "no-state", tmp_path / "no-home", {}) == []


def test_lists_where_credentials_are_and_never_what_they_are(places: tuple[Path, Path]) -> None:
    state, home = places
    write(state / ".env", f"OPENROUTER_API_KEY={SECRET}\n")
    write(home / ".nanobot" / ".env", f"export OTHER = {SECRET}\n")
    write(home / ".nanobot" / "config.json", json.dumps({"providers": {"openrouter": {"apiKey": SECRET}}}))
    found = find_credentials_on_disk(state, home, {"OPENROUTER_API_KEY": SECRET, "PATH": "/usr/bin"})
    assert found == [
        f"dotenv file {state / '.env'}",
        f"dotenv file {home / '.nanobot' / '.env'}",
        f"config file {home / '.nanobot' / 'config.json'} holds an apiKey at providers.openrouter.apiKey",
        "environment variable OPENROUTER_API_KEY",
    ]
    assert SECRET not in " ".join(found)


def test_the_assertion_refuses_to_start_naming_every_place(places: tuple[Path, Path]) -> None:
    state, home = places
    write(home / ".env", f"TOKEN={SECRET}\n")
    with pytest.raises(CredentialOnDiskError) as caught:
        assert_no_credentials_on_disk(state, home, {"GITHUB_TOKEN": SECRET})
    message = str(caught.value)
    assert message.startswith("refusing to start: a Dot keeps credentials in memory only, and these are on disk: ")
    assert f"dotenv file {home / '.env'}" in message
    assert "environment variable GITHUB_TOKEN" in message
    assert SECRET not in message


def test_a_dotenv_file_counts_only_when_it_holds_an_assignment(places: tuple[Path, Path]) -> None:
    state, home = places
    write(state / ".env", "# nothing here\n\n   \n")
    write(home / ".env", "just words\n")
    assert find_credentials_on_disk(state, home, {}) == []
    write(home / ".env", "# a comment\n  _UNDERSCORE_1 =x\n")
    assert find_credentials_on_disk(state, home, {}) == [f"dotenv file {home / '.env'}"]


def test_an_unreadable_dotenv_path_is_not_a_finding(places: tuple[Path, Path]) -> None:
    state, home = places
    (state / ".env").mkdir()
    assert find_credentials_on_disk(state, home, {}) == []


def test_the_same_dotenv_file_is_named_once_when_the_places_overlap(tmp_path: Path) -> None:
    write(tmp_path / ".env", "A=1\n")
    assert find_credentials_on_disk(tmp_path, tmp_path, {}) == [f"dotenv file {tmp_path / '.env'}"]


@pytest.mark.parametrize(
    ("document", "where"),
    [
        ({"apiKey": SECRET}, "apiKey"),
        ({"api_key": SECRET}, "api_key"),
        ({"providers": {"a": {"apiKey": SECRET}, "b": {"apiKey": SECRET}}}, "providers.a.apiKey, providers.b.apiKey"),
        ({"list": [{"x": 1}, {"apiKey": SECRET}]}, "list[1].apiKey"),
    ],
)
def test_a_config_file_counts_when_an_api_key_is_anywhere_in_it(
    places: tuple[Path, Path], document: object, where: str
) -> None:
    state, home = places
    path = write(home / ".nanobot" / "config.json", json.dumps(document))
    assert find_credentials_on_disk(state, home, {}) == [f"config file {path} holds an apiKey at {where}"]


@pytest.mark.parametrize(
    "document",
    [{}, [], {"apiKey": ""}, {"apiKey": "   "}, {"apiKey": None}, {"apiKey": {"ref": "memory"}}, {"model": "x", "apiBase": SECRET}],
)
def test_a_config_file_without_a_non_empty_api_key_passes(places: tuple[Path, Path], document: object) -> None:
    state, home = places
    write(home / ".nanobot" / "config.json", json.dumps(document))
    assert find_credentials_on_disk(state, home, {}) == []


def test_a_config_file_that_is_not_json_is_refused_because_it_cannot_be_checked(places: tuple[Path, Path]) -> None:
    state, home = places
    path = write(home / ".nanobot" / "config.json", f'{{"apiKey": "{SECRET}"')
    found = find_credentials_on_disk(state, home, {})
    assert found == [f"config file {path} (not valid JSON, so it cannot be checked)"]
    assert SECRET not in found[0]


@pytest.mark.parametrize(
    "name",
    ["OPENROUTER_API_KEY", "GITHUB_TOKEN", "CLIENT_SECRET", "DB_PASSWORD", "openrouter_api_key", "Some_Token", "KEY"],
)
def test_a_credential_named_variable_with_a_value_is_a_finding(places: tuple[Path, Path], name: str) -> None:
    state, home = places
    assert find_credentials_on_disk(state, home, {name: SECRET}) == [f"environment variable {name}"]


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("OPENROUTER_API_KEY", ""),
        ("OPENROUTER_API_KEY", "  "),
        ("TOKEN_COUNT", "5"),
        ("KEY_FILE", "/x"),
        ("PATH", "/usr/bin"),
        ("SSH_AUTH_SOCK", "/tmp/s"),
        ("TIKTOKEN_CACHE_DIR", "/x"),
    ],
)
def test_other_variables_are_not(places: tuple[Path, Path], name: str, value: str) -> None:
    state, home = places
    assert find_credentials_on_disk(state, home, {name: value}) == []


def test_the_variables_are_named_in_a_stable_order(places: tuple[Path, Path]) -> None:
    state, home = places
    assert find_credentials_on_disk(state, home, {"Z_TOKEN": "1", "A_TOKEN": "1", "M_KEY": "1"}) == [
        "environment variable A_TOKEN",
        "environment variable M_KEY",
        "environment variable Z_TOKEN",
    ]
