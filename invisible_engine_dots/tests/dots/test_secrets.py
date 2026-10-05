"""The OpenRouter key holder: memory only, quiet about its value."""

from __future__ import annotations

import os
import re

import pytest
from loguru import logger

from nanobot.dots.protocol import OPENROUTER_KEY_RULE
from nanobot.dots.secrets import KeyHolder


def test_holds_the_key_and_says_whether_it_was_received_replaced_or_the_same() -> None:
    holder = KeyHolder()
    assert holder.configured is False
    assert holder.set("sk-or-a") == "received"
    assert holder.set("sk-or-a") == "unchanged"
    assert holder.set("sk-or-b") == "replaced"
    assert holder.configured is True
    assert holder.require() == "sk-or-b"


def test_an_empty_key_is_refused_and_changes_nothing() -> None:
    holder = KeyHolder()
    holder.set("sk-or-a")
    for blank in ("", "   ", "\n"):
        with pytest.raises(ValueError, match="the key is empty"):
            holder.set(blank)
    assert holder.require() == "sk-or-a"


def test_the_key_is_not_in_its_text_form_nor_in_what_it_logs(capfd: pytest.CaptureFixture[str]) -> None:
    messages: list[str] = []
    sink = logger.add(messages.append, level="TRACE")
    try:
        holder = KeyHolder()
        holder.set("sk-or-the-secret-value")
        assert "sk-or-the-secret-value" not in repr(holder)
        assert "sk-or-the-secret-value" not in str(holder)
    finally:
        logger.remove(sink)
    out, err = capfd.readouterr()
    assert messages == []
    assert "sk-or-the-secret-value" not in out + err


def test_the_key_is_not_put_in_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    before = dict(os.environ)
    KeyHolder().set("sk-or-the-secret-value")
    assert dict(os.environ) == before
    assert not any("sk-or-the-secret-value" in value for value in os.environ.values())


def test_the_holder_has_no_dictionary_to_leak_through() -> None:
    holder = KeyHolder()
    holder.set("sk-or-the-secret-value")
    assert not hasattr(holder, "__dict__")


def test_require_hands_the_key_to_the_one_caller_that_needs_it_and_refuses_when_there_is_none() -> None:
    holder = KeyHolder()
    with pytest.raises(RuntimeError, match="has not been received"):
        holder.require()
    holder.set("sk-or-a")
    assert holder.require() == "sk-or-a"


@pytest.mark.parametrize("bad", ["sk-or-a\nb", "sk-or-a\r\n", "sk-or-a\x00b", "sk-or-a\tb", "sk-or-a b", "sk-or-\u00fc", " sk-or-a", "sk-or-a\x7f", "sk-or-a\x1f"])
def test_a_key_that_cannot_travel_in_a_header_is_refused_and_changes_nothing(bad: str) -> None:
    # The rule is the host's (packages/shared), the text it refuses with is the one the host's 400 carries.
    holder = KeyHolder()
    holder.set("sk-or-a")
    with pytest.raises(ValueError, match=re.escape(OPENROUTER_KEY_RULE)) as refused:
        holder.set(bad)
    assert bad not in str(refused.value)
    assert holder.require() == "sk-or-a"
