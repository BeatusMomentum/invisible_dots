"""What of a tool call `tool.called` may show: one redacted line naming the thing the call acted on.

`tool.called` leaves the guest and reaches the host's event log, the web UI and the channels. The
permission table (permissions.py) says, per tool, which function here states what of the call's
arguments may be seen; nothing else of the arguments travels. A tool that is not in the table has no
target. Each function takes the arguments as the model sent them (validated and cast by the runner),
trusts none of their types, and returns None when there is nothing to name.

A target is a place or a name, never content: a command's first line, a path, a search term, an
action and a name. What a person typed into a program (`exec_session` input, a browser field) is
never one. The command of `exec` can hold a credential, so it goes through `redact_command`, a
best-effort mask of the forms a credential takes in a command line; a command that hides a secret in
another form is shown as it is, which is why the full command stays behind the approval, not here.

`permissions.tool_target` cuts every target at `TOOL_TARGET_MAX` characters (the host's schema refuses
more); `exec` cuts earlier, at `EXEC_TARGET_MAX`.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

# The longest first line of a command shown, the ellipsis included.
EXEC_TARGET_MAX = 120

_ELLIPSIS = "…"
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")

# A credential in a command line, in the forms people and tools write it: the user and password of a
# URL; a Bearer or Basic credential; an Authorization, API key, cookie or token header; an assignment
# or `--flag=value` whose name says what it holds; `--password value`.
_URL_USERINFO = re.compile(r"(?i)(\b[a-z][a-z0-9+.-]*://)[^\s/@'\"]*@")
_SCHEME_CREDENTIAL = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+")
_HEADER = re.compile(
    r"(?i)\b((?:proxy-)?authorization|x-[\w-]*(?:api-key|auth-token|token)|api-key|cookie|set-cookie)(\s*:\s*)[^'\"\r\n]+"
)
_SECRET_NAME = r"[\w.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|credential|private[_-]?key)[\w.-]*"
_ASSIGNMENT = re.compile(rf"(?i)\b({_SECRET_NAME})=(\"[^\"]*\"|'[^']*'|[^\s'\"]+)")
_FLAG_VALUE = re.compile(rf"(?i)(--{_SECRET_NAME})(\s+)(\"[^\"]*\"|'[^']*'|[^\s'\"-][^\s'\"]*)")
_MASK = "***"


def redact_command(line: str) -> str:
    """The line with the credentials it carries replaced by `***` (best effort, see the module doc)."""
    line = _URL_USERINFO.sub(r"\1", line)
    line = _SCHEME_CREDENTIAL.sub(lambda m: f"{m.group(1)} {_MASK}", line)
    line = _HEADER.sub(lambda m: f"{m.group(1)}{m.group(2)}{_MASK}", line)
    line = _ASSIGNMENT.sub(lambda m: f"{m.group(1)}={_MASK}", line)
    return _FLAG_VALUE.sub(lambda m: f"{m.group(1)}{m.group(2)}{_MASK}", line)


def clip(text: str, limit: int) -> str:
    """The text on one line, at most `limit` characters, cut with an ellipsis."""
    text = _CONTROL.sub(" ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + _ELLIPSIS


def _string(params: Mapping[str, Any], *names: str) -> str:
    """The first of the named arguments that is a non-blank string, stripped; "" when none is."""
    for name in names:
        value = params.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def exec_target(params: Mapping[str, Any]) -> str | None:
    command = _string(params, "command", "cmd")
    if not command:
        return None
    return clip(redact_command(command.splitlines()[0]), EXEC_TARGET_MAX)


def path_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "path") or None


def find_files_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "query", "glob", "path") or None


def grep_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "pattern") or None


def apply_patch_target(params: Mapping[str, Any]) -> str | None:
    edits = params.get("edits")
    paths = [
        edit["path"].strip()
        for edit in (edits if isinstance(edits, list) else [])
        if isinstance(edit, Mapping) and isinstance(edit.get("path"), str) and edit["path"].strip()
    ]
    if not paths:
        return None
    if len(paths) == 1:
        return paths[0]
    return f"{len(paths)} files, first {paths[0]}"


def memory_search_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "query") or None


def memory_get_target(params: Mapping[str, Any]) -> str | None:
    return _string(params, "name") or None


def cron_target(params: Mapping[str, Any]) -> str | None:
    action = _string(params, "action")
    if not action:
        return None
    return f"{action} {_string(params, 'name', 'job_id')}".strip()


def exec_session_target(params: Mapping[str, Any]) -> str | None:
    session_id = _string(params, "session_id")
    if not session_id:
        return None
    if params.get("terminate") is True:
        return f"terminate {session_id}"
    if params.get("input") is not None:
        return f"input to {session_id}"
    return f"output of {session_id}"


def no_target(params: Mapping[str, Any]) -> str | None:
    """For a tool that acts on nothing in particular (it lists)."""
    return None
