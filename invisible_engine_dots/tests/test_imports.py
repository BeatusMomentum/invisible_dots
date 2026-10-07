"""Every module of the engine imports.

A deleted module that something still imports shows up here as a failure that
names the module, instead of as a lazy ImportError in the middle of a turn.
"""

from __future__ import annotations

import importlib
import pkgutil
import sys

import pytest

import nanobot

_PLATFORM_ONLY: dict[str, str] = {}


def _module_names() -> list[str]:
    # walk_packages imports each package to look inside it. A package that
    # fails to import is reported through onerror and kept in the list, so the
    # test below imports it again and fails naming it.
    broken: list[str] = []
    names = {
        info.name
        for info in pkgutil.walk_packages(
            nanobot.__path__, prefix="nanobot.", onerror=broken.append
        )
    }
    names |= set(broken)
    names -= {name for name, platform in _PLATFORM_ONLY.items() if sys.platform != platform}
    return sorted(names)


@pytest.mark.parametrize("module_name", _module_names())
def test_module_imports(module_name: str) -> None:
    try:
        importlib.import_module(module_name)
    except Exception as exc:  # noqa: BLE001 - the failure names the module
        pytest.fail(f"{module_name} does not import: {type(exc).__name__}: {exc}")


def test_package_walk_finds_the_engine() -> None:
    names = _module_names()
    assert "nanobot.agent.runner" in names
    assert "nanobot.cron.service" in names
