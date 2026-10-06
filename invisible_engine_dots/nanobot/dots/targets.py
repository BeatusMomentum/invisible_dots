"""What of a tool call `tool.called` may show: one redacted line naming the thing the call acted on.

`tool.called` leaves the guest and reaches the host's event log, the web UI and the channels. The
permission table (permissions.py) says, per tool, which function here states what of the call's
arguments may be seen; nothing else of the arguments travels. A tool that is not in the table has no
target. Each function takes the arguments as the model sent them (validated and cast by the runner),
trusts none of their types, and returns None when there is nothing to name.

A target is a place or a name, never content: a command's first line, a path, a search term, an
action and a name. What a person typed into a program (`exec_session` input, a browser field) is
never one. The command of `exec` can hold a credential, and a command line has no grammar that says
which word is one, so `redact_command` does not look for the shapes a secret takes in free text: it
shows an allowlist of what a command line is made of and masks the rest.

Shown: the program of each command, its plain positional words, a long option and its value when
the option's name does not say it holds a credential, a cluster of up to three short flags (`-rf`),
a URL without its user and password and with the values of its query masked, `host:port` and
`host:/path`.

Masked as `***`: the value of every single-letter option (`-p`, `-u`, `-H`, `-x`: the letter says
nothing of what follows; only a value that is plainly a path stays), a value written against its
flag (`-phunter2`), the value of a long option or assignment named for a credential (`--password`,
`--proxy-user`, `API_KEY=`), a quoted word with spaces, any `user:password` word (a colon followed
by more than a port or a path) and the word after `Bearer` or `Basic`. A header keeps its name
(`Authorization: ***`).

What stays visible is a secret written as a bare positional word (`echo hunter2`) or as a value
that starts like a path, which cannot be told from a name; the full command stays behind the
approval, not here.

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
_MASK = "***"

# A command line cut into words and operators. A word is a run of characters and quoted pieces; an
# unterminated quote is left in the gap between tokens, so what follows it is still a word.
_TOKEN = re.compile(r"""(?:[^\s'"|&;<>()]|'[^']*'|"(?:[^"\\]|\\.)*")+|\|\|?|&&?|;|[<>]+|[()]""")
_BREAKS = frozenset({"|", "||", "&", "&&", ";", "(", ")"})
_QUOTED = re.compile(r"""'([^']*)'|"((?:[^"\\]|\\.)*)\"""")
_PROGRAM = re.compile(r"(?:[A-Za-z]:)?[\w./\\+~-]+")
_ASSIGNMENT = re.compile(r"([A-Za-z_][\w.-]*)=(.*)", re.DOTALL)
_OPTION_NAME = re.compile(r"\w[\w.-]*")
_SHORT_FLAG = re.compile(r"-[A-Za-z]")
_SHORT_CLUSTER = re.compile(r"-[A-Za-z]{2,3}")
_PATH = re.compile(r"(?:/|\./|\.\./|~/)[\w./~-]*")
_PORT_OR_PATH = re.compile(r"[/\\].*|\d+(?:/.*)?")
_HEADER = re.compile(r"([\w-]+):\s+\S")
_URL = re.compile(r"(?i)([a-z][a-z0-9+.-]*://)([^/?#]*)(.*)", re.DOTALL)
_QUERY_VALUE = re.compile(r"([?&;#][^=&#;?/]*=)[^&#;]*")
# What a name says it holds: a part of it (split at - _ .) that contains one of these, or is one of them.
_SECRET_PART = re.compile(
    r"pass|secret|token|credential|key|cookie|bearer|header|^(?:auth|authorization|user|username|login|pw|pwd|jwt)$"
)
_SCHEME_WORDS = frozenset({"bearer", "basic"})


def redact_command(line: str) -> str:
    """The line with everything that may be a credential replaced by `***` (the allowlist is in the module doc)."""
    out: list[str] = []
    last = 0
    at_program = True
    take_value = False
    previous = ""
    for match in _TOKEN.finditer(line):
        raw = match.group()
        out.append(line[last : match.start()])
        last = match.end()
        is_word = raw not in _BREAKS and raw[0] not in "<>"
        if not is_word:
            if raw in _BREAKS:
                at_program = True
            take_value, previous = False, ""
            out.append(raw)
            continue
        if at_program:
            assignment = _ASSIGNMENT.fullmatch(raw)
            if assignment:
                out.append(_assigned(*assignment.groups()))
                continue
            out.append(raw if _PROGRAM.fullmatch(raw) else _MASK)
            at_program = False
        elif raw.startswith("--"):
            name, equals, value = raw[2:].partition("=")
            take_value = False
            if not name and not equals:
                # `--` ends the options.
                out.append(raw)
            elif not _OPTION_NAME.fullmatch(name):
                out.append(_MASK)
            elif equals:
                out.append(f"--{name}={_assigned_value(name, value)}")
            else:
                out.append(raw)
                take_value = _secret_named(name)
        elif raw.startswith("-") and len(raw) > 1 and not raw[1:].isdigit():
            if _SHORT_FLAG.fullmatch(raw):
                out.append(raw)
                take_value = True
            else:
                # Flags run together are shown; a value written against its flag is not.
                take_value = False
                if _SHORT_CLUSTER.fullmatch(raw):
                    out.append(raw)
                else:
                    out.append(f"{raw[:2]}{_MASK}" if raw[1].isalnum() else _MASK)
        elif previous in _SCHEME_WORDS:
            out.append(_mask_word(raw))
            take_value = False
        elif take_value:
            out.append(raw if _PATH.fullmatch(raw) else _mask_word(raw))
            take_value = False
        else:
            out.append(_shown_word(raw))
        previous = _unquoted(raw).lower()
    out.append(line[last:])
    return "".join(out)


def _secret_named(name: str) -> bool:
    return any(_SECRET_PART.search(part) for part in re.split(r"[-_.]+", name.lower()))


def _assigned(name: str, value: str) -> str:
    return f"{name}={_assigned_value(name, value)}"


def _assigned_value(name: str, value: str) -> str:
    return _MASK if _secret_named(name) else _shown_word(value)


def _unquoted(word: str) -> str:
    quoted = _QUOTED.fullmatch(word)
    if quoted is None:
        return word
    return quoted.group(1) if quoted.group(1) is not None else quoted.group(2)


def _mask_word(word: str) -> str:
    """`***`; a quoted header keeps its name and its quotes: `'Authorization: ***'`."""
    header = _HEADER.match(_unquoted(word)) if _QUOTED.fullmatch(word) else None
    return f"{word[0]}{header.group(1)}: {_MASK}{word[0]}" if header else _MASK


def _shown_word(word: str) -> str:
    """A word nothing said to mask: as it is when its shape is a plain one, masked when it may hold a credential."""
    if not word:
        return word
    assignment = _ASSIGNMENT.fullmatch(word)
    if assignment:
        return _assigned(*assignment.groups())
    quoted = _QUOTED.fullmatch(word) is not None
    if not quoted and ("'" in word or '"' in word):
        return _MASK
    inner = _unquoted(word)
    if any(char.isspace() for char in inner):
        return _mask_word(word)
    quote = word[0] if quoted else ""
    url = _URL.fullmatch(inner)
    if url:
        scheme, authority, rest = url.groups()
        shown = scheme + authority.rpartition("@")[2] + _QUERY_VALUE.sub(lambda m: m.group(1) + _MASK, rest)
        return f"{quote}{shown}{quote}"
    _, colon, after = inner.partition(":")
    if colon and after and not _PORT_OR_PATH.fullmatch(after):
        return _mask_word(word)
    return word


def clip(text: str, limit: int) -> str:
    """The text on one line, at most `limit` characters (code points), cut with an ellipsis.

    The unit is the one the host's schema counts: zod 4 measures a string in code points, so a
    character outside the BMP is one, here and there.
    """
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


def exec_starts_terminal(params: Mapping[str, Any]) -> bool:
    """Whether the call asks `exec` for a terminal session (`tty`): the one thing `tool.called` says of a call
    besides what it acted on, because a client shows "started a terminal session" and not "ran a command"."""
    return params.get("tty") is True


def never_starts_terminal(params: Mapping[str, Any]) -> bool:
    return False


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
