"""
invisible_dots engine: a hard fork of nanobot (see UPSTREAM.md).
"""

import tomllib
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
from pathlib import Path

_DISTRIBUTION = "invisible-dots-engine"


def _read_pyproject_version() -> str | None:
    """Read the source-tree version when package metadata is unavailable."""
    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    if not pyproject.exists():
        return None
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    return data.get("project", {}).get("version")


def _resolve_version() -> str:
    try:
        return _pkg_version(_DISTRIBUTION)
    except PackageNotFoundError:
        # The engine runs from a source tree on the runtime ISO, without dist-info.
        return _read_pyproject_version() or "0.1.0"


__version__ = _resolve_version()
