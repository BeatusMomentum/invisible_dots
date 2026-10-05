"""Background initialization of the fallback token counter.

The vocabulary cache location is left to the environment (``TIKTOKEN_CACHE_DIR``);
when the encoding cannot be loaded, token counts fall back to UTF-8 byte estimates.
"""

from threading import Lock, Thread

import tiktoken
from loguru import logger

_encoding: tiktoken.Encoding | None = None
_warmup_thread: Thread | None = None
_warmup_lock = Lock()


def _load_encoding() -> None:
    global _encoding
    try:
        _encoding = tiktoken.get_encoding("cl100k_base")
    except Exception as exc:
        logger.warning(
            "Token encoding unavailable ({}); using UTF-8 byte estimates until restart.", exc,
        )


def warmup_token_encoding() -> None:
    """Start one process-wide load; tiktoken reuses its persistent vocabulary cache."""
    global _warmup_thread
    with _warmup_lock:
        if _warmup_thread is not None:
            return
        # A stalled upstream download must not hold up asyncio's executor shutdown.
        _warmup_thread = Thread(target=_load_encoding, name="nanobot-tokenizer", daemon=True)
        try:
            _warmup_thread.start()
        except Exception as exc:
            logger.warning(
                "Token encoding unavailable ({}); using UTF-8 byte estimates until restart.", exc,
            )


def get_token_encoding() -> tiktoken.Encoding | None:
    """Return immediately, using byte estimates while loading or after failure."""
    if _warmup_thread is None:
        warmup_token_encoding()
    return _encoding
