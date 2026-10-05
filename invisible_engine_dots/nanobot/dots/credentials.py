"""Credentials live in memory only (invisible_dots architecture 4.3).

The OpenRouter key is pushed by the host into the KeyHolder (secrets.py).
Nothing may write a credential to disk, and the engine refuses to start when it
finds one anyway: a dotenv file that holds an assignment, a nanobot config file
that holds an API key, or a credential-named variable in its own environment.
Every finding says WHERE, never WHAT.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

# A dotenv line that assigns a variable (a comment or a blank line does not).
_DOTENV_ASSIGNMENT = re.compile(r"^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=", re.MULTILINE)
# A variable whose name says it holds a secret.
_CREDENTIAL_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)$", re.IGNORECASE)
# The field names nanobot's config uses for an API key (the file's own spelling, and the loader's).
_API_KEY_FIELDS = ("apiKey", "api_key")


class CredentialOnDiskError(RuntimeError):
    """A credential was found outside memory."""


def _read_text(path: Path) -> str | None:
    """The text of a file, or None when this process cannot read it (then it cannot use it either)."""
    try:
        return path.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return None


def _dotenv_with_assignment(path: Path) -> bool:
    text = _read_text(path)
    return text is not None and _DOTENV_ASSIGNMENT.search(text) is not None


def _api_key_paths(value: Any, prefix: str = "") -> list[str]:
    """The paths in a parsed JSON document where an API key field holds a non-empty string."""
    found: list[str] = []
    if isinstance(value, Mapping):
        for name, child in value.items():
            where = f"{prefix}.{name}" if prefix else str(name)
            if name in _API_KEY_FIELDS and isinstance(child, str) and child.strip():
                found.append(where)
            else:
                found.extend(_api_key_paths(child, where))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(_api_key_paths(child, f"{prefix}[{index}]"))
    return found


def _config_file_finding(path: Path) -> str | None:
    text = _read_text(path)
    if text is None:
        return None
    try:
        paths = _api_key_paths(json.loads(text))
    except json.JSONDecodeError:
        # A file this check cannot parse might still hold a key: refuse it.
        return f"config file {path} (not valid JSON, so it cannot be checked)"
    return f"config file {path} holds an apiKey at {', '.join(paths)}" if paths else None


def find_credentials_on_disk(state_dir: str | Path, home: str | Path, environ: Mapping[str, str]) -> list[str]:
    """Every credential found, described without its value."""
    state_dir, home = Path(state_dir), Path(home)
    found: list[str] = []
    dotenv_files = dict.fromkeys([state_dir / ".env", home / ".env", home / ".nanobot" / ".env"])
    found.extend(f"dotenv file {path}" for path in dotenv_files if _dotenv_with_assignment(path))
    config_finding = _config_file_finding(home / ".nanobot" / "config.json")
    if config_finding is not None:
        found.append(config_finding)
    found.extend(
        f"environment variable {name}"
        for name, value in sorted(environ.items())
        if _CREDENTIAL_NAME.search(name) and value.strip()
    )
    return found


def assert_no_credentials_on_disk(state_dir: str | Path, home: str | Path, environ: Mapping[str, str]) -> None:
    """Raises, naming where (never what), when a credential is on disk."""
    found = find_credentials_on_disk(state_dir, home, environ)
    if found:
        raise CredentialOnDiskError(
            f"refusing to start: a Dot keeps credentials in memory only, and these are on disk: {'; '.join(found)}"
        )
