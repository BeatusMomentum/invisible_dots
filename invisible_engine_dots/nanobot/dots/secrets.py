"""Where `POST /secrets` puts the OpenRouter key: the memory of this process, and nowhere else.

invisible_dots architecture 4.3: a Dot keeps credentials in memory only. The
host pushes the key at every READY and every agent.started; the holder keeps
it for the provider to read and never logs it, writes it or puts it in an
environment.
"""

from __future__ import annotations

import re
from typing import Literal

from nanobot.dots.protocol import OPENROUTER_KEY_PATTERN, OPENROUTER_KEY_RULE

KeyChange = Literal["received", "replaced", "unchanged"]

# What a key is made of is the host's rule (protocol.OPENROUTER_KEY_PATTERN, from packages/shared), which the
# host applies when the user enters the key; this is the guest's own check of what arrives. Anything else (a
# newline inside it, a control character, a non-ASCII letter) makes httpx or h11 refuse the request with an
# exception whose text is the whole header, `Illegal header value b'Bearer <key>'`, and the openai client
# chains it under its own "Connection error", where any log of the chain prints it.
_KEY_FORMAT = re.compile(OPENROUTER_KEY_PATTERN)


class KeyHolder:
    """The OpenRouter key, in memory."""

    __slots__ = ("_key",)

    def __init__(self) -> None:
        self._key: str | None = None

    @property
    def configured(self) -> bool:
        return self._key is not None

    def require(self) -> str:
        """The key, for the one place that builds a provider with it; raises when none was received.

        The key travels as an expression, never as a local variable of a long-lived
        caller: a traceback logged with variable values would print it.
        """
        if self._key is None:
            raise RuntimeError("the OpenRouter key has not been received")
        return self._key

    def set(self, key: str) -> KeyChange:
        """Hold `key`, and say whether it was received, replaced or is the one already held.

        The host pushes the same key at every READY and agent.started. The same
        key again changes nothing: rebuilding the provider for it would swap it
        under the turns already running.
        """
        if not key.strip():
            raise ValueError("the key is empty")
        if _KEY_FORMAT.fullmatch(key) is None:
            raise ValueError(OPENROUTER_KEY_RULE)
        previous = self._key
        if previous == key:
            return "unchanged"
        self._key = key
        return "received" if previous is None else "replaced"

    def __repr__(self) -> str:
        return f"KeyHolder(configured={self.configured})"
