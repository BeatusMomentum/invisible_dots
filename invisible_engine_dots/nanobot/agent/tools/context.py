"""Per-request context the runner binds for the tools it runs."""
from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass

_CURRENT_REQUEST_CONTEXT: ContextVar["RequestContext | None"] = ContextVar(
    "nanobot_tool_request_context",
    default=None,
)


@dataclass(frozen=True)
class RequestContext:
    """What the tools of one turn read about it: the session it belongs to."""
    session_key: str | None = None
    log_content: bool = True


def bind_request_context(ctx: RequestContext) -> Token[RequestContext | None]:
    return _CURRENT_REQUEST_CONTEXT.set(ctx)


def reset_request_context(token: Token[RequestContext | None]) -> None:
    _CURRENT_REQUEST_CONTEXT.reset(token)


def current_request_context() -> RequestContext | None:
    return _CURRENT_REQUEST_CONTEXT.get()


def tool_log_content_allowed() -> bool:
    """Whether diagnostics may include content from the current tool request."""
    ctx = current_request_context()
    return ctx is None or ctx.log_content


def current_request_session_key() -> str | None:
    ctx = current_request_context()
    return ctx.session_key if ctx else None
