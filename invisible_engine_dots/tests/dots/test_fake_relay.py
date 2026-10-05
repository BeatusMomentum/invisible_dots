"""The fake relay parses the flags the way guest/dot-agentd/cmd/dot-agentd/relay.go does."""

from __future__ import annotations

import pytest

from fakes.fake_relay import parse_relay_args


def test_flags_then_the_program_after_the_separator() -> None:
    parsed = parse_relay_args(
        ["--socket", "/s.sock", "--tty", "--cwd", "/w", "--env", "A=1", "--env", "B=2=3", "--", "ls", "-la"]
    )

    assert parsed == {
        "socket": "/s.sock",
        "cwd": "/w",
        "tty": True,
        "env": ["A=1", "B=2=3"],
        "program": ["ls", "-la"],
    }


def test_the_program_keeps_flags_that_look_like_relay_flags() -> None:
    parsed = parse_relay_args(["--", "grep", "--cwd", "x"])

    assert parsed["program"] == ["grep", "--cwd", "x"]
    assert parsed["cwd"] == ""


def test_the_first_argument_that_is_not_a_flag_starts_the_program() -> None:
    assert parse_relay_args(["--cwd", "/w", "echo", "hi"])["program"] == ["echo", "hi"]


def test_go_flag_spellings_are_accepted() -> None:
    parsed = parse_relay_args(["-socket=/s", "-tty=false", "--cwd=/w", "--", "true"])

    assert parsed["socket"] == "/s"
    assert parsed["tty"] is False
    assert parsed["cwd"] == "/w"


@pytest.mark.parametrize(
    "args",
    [
        [],
        ["--socket", "/s"],
        ["--unknown", "--", "true"],
        ["--env", "NOEQUALS", "--", "true"],
        ["--cwd"],
    ],
)
def test_a_bad_invocation_is_refused(args: list[str]) -> None:
    with pytest.raises(ValueError):
        parse_relay_args(args)
