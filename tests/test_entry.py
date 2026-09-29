"""`dots` is the interface of the pinned invisible-playwright-mcp, and only that.

These tests are what a bump of the pin is judged by: the package's command
group is not a published API, so the day it changes shape is the day one of
these goes red.
"""
from __future__ import annotations

import importlib.metadata
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

import dots.cli

ROOT = Path(__file__).resolve().parents[1]


def _run(*args: str, cwd: Path, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "dots", *args],
        cwd=cwd, env=env, capture_output=True, text=True, timeout=120,
    )


def _clean_env(home: Path) -> dict:
    """This environment without a model key, and with its own data directory."""
    env = {k: v for k, v in os.environ.items()
           if k.upper() not in {"OPENROUTER_API_KEY", "OPENAI_API_KEY"}}
    env["INVISIBLE_MCP_HOME"] = str(home)
    env["PYTHONPATH"] = str(ROOT / "src")
    return env


@pytest.mark.unit
def test_the_group_is_called_with_ui_in_front(monkeypatch):
    # Through the GROUP, because the group is what reads `.env`. A `dots` that
    # called the `ui` command on its own would pass every other test here and
    # never find a key kept in a file.
    seen = {}

    def group(*, args, prog_name):
        seen["args"], seen["prog_name"] = args, prog_name

    monkeypatch.setattr("invisible_playwright_mcp.cli.main", group)
    dots.cli.main(["--port", "9000", "--headed"])
    assert seen == {"args": ["ui", "--port", "9000", "--headed"], "prog_name": "dots"}


@pytest.mark.integration
def test_help_is_the_interface_help(tmp_path):
    done = _run("--help", cwd=tmp_path, env=_clean_env(tmp_path / "home"))
    assert done.returncode == 0, done.stderr
    assert "Usage: dots" in done.stdout
    for option in ("--openrouter-key", "--model", "--proxy", "--seed", "--profile-dir"):
        assert option in done.stdout


@pytest.mark.integration
def test_without_a_key_it_refuses_before_starting_anything(tmp_path):
    done = _run(cwd=tmp_path, env=_clean_env(tmp_path / "home"))
    assert done.returncode != 0
    assert "OpenRouter" in done.stdout + done.stderr


@pytest.mark.unit
def test_the_installed_package_is_the_pinned_one():
    # An editable install of a sibling checkout would make every test above
    # judge code that `uvx` never delivers.
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    (line,) = [d for d in pyproject["project"]["dependencies"]
               if d.startswith("invisible-playwright-mcp")]
    pinned = re.fullmatch(r"invisible-playwright-mcp==(\S+)", line).group(1)
    assert importlib.metadata.version("invisible-playwright-mcp") == pinned
