"""Fixtures of the Dot contract tests: a real database file and a valid Dot config."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fakes.dot_config import ALLOW_ALL, runtime_config_body
from fakes.engine_harness import EngineHarness
from fakes.scripted_provider import ScriptEntry
from fakes.turn_harness import Harness

from nanobot.dots.protocol import DotRuntimeConfig, parse_runtime_config
from nanobot.dots.store import DotStore


@pytest.fixture
def config_body() -> Callable[..., dict[str, Any]]:
    return runtime_config_body


@pytest.fixture
def make_config() -> Callable[..., DotRuntimeConfig]:
    """Build a Dot config with the given permission map."""

    def make(permissions: dict[str, str]) -> DotRuntimeConfig:
        return parse_runtime_config(runtime_config_body(permissions=permissions))

    return make


@pytest.fixture
def dot_store(tmp_path: Path) -> Iterator[DotStore]:
    store = DotStore.open(tmp_path / "state" / "engine.sqlite")
    yield store
    store.close()




@pytest.fixture
def make_harness(tmp_path: Path, dot_store: DotStore) -> Callable[..., Harness]:
    """A turn runner on a real store and a scripted model; the permission map defaults to allow-all."""

    def make(
        script: list[ScriptEntry],
        permissions: dict[str, str] | None = None,
        *,
        max_tokens: int = 1000,
        **config_overrides: Any,
    ) -> Harness:
        config = parse_runtime_config(
            runtime_config_body(permissions=ALLOW_ALL if permissions is None else permissions, **config_overrides)
        )
        return Harness(tmp_path, dot_store, config, script, max_tokens=max_tokens)

    return make


@pytest.fixture
async def make_engine(tmp_path: Path, dot_store: DotStore) -> AsyncIterator[Callable[..., EngineHarness]]:
    """An engine on a real store and a scripted model; every engine made is stopped at the end."""
    made: list[EngineHarness] = []

    def make(script: list[ScriptEntry] | None = None, **options: Any) -> EngineHarness:
        harness = EngineHarness(tmp_path, dot_store, script or [], **options)
        made.append(harness)
        return harness

    yield make
    for harness in made:
        for engine in harness.engines:
            await engine.stop()
