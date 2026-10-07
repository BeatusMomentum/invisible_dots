"""Cross-suite test infrastructure."""

from __future__ import annotations

from threading import Thread

import pytest


@pytest.fixture(autouse=True)
def _isolate_tokenizer_warmup(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep tests deterministic and out of the user's tokenizer cache and network."""
    monkeypatch.setattr("nanobot.utils.token_encoding._encoding", None)
    monkeypatch.setattr("nanobot.utils.token_encoding._warmup_thread", Thread())
