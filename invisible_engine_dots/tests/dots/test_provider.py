"""The Dot's one provider: OpenRouter, with the key the host pushed to memory."""

from __future__ import annotations

import os
from collections.abc import Callable
from unittest.mock import patch

import pytest

from nanobot.dots.projection import EngineSettings, project
from nanobot.dots.protocol import DotRuntimeConfig
from nanobot.dots.provider import OpenRouterProviders
from nanobot.dots.secrets import KeyHolder
from nanobot.providers.openai_compat_provider import OpenAICompatProvider

MakeConfig = Callable[[dict[str, str]], DotRuntimeConfig]


def settings_of(config: DotRuntimeConfig, base_url: str | None = None) -> EngineSettings:
    return project(config, workspace="/home/dot/workspace", openrouter_base_url=base_url)


def test_the_provider_is_openrouters_with_the_key_the_model_and_the_default_base(make_config: MakeConfig) -> None:
    provider = OpenRouterProviders().current(settings_of(make_config({})), "sk-or-1")

    assert provider.provider_name == "openrouter"
    assert provider.api_key == "sk-or-1"
    assert provider.default_model == "z-ai/glm-5.3-flash"
    assert provider._effective_base == "https://openrouter.ai/api/v1"
    # The Dot's attribution goes to openrouter.ai.
    assert provider._default_headers["HTTP-Referer"] == "https://github.com/feder-cr/invisible_dots"
    assert provider._default_headers["X-Title"] == "invisible_dots"


def test_a_stand_in_base_url_is_used_and_gets_no_attribution(make_config: MakeConfig) -> None:
    provider = OpenRouterProviders().current(settings_of(make_config({}), "http://127.0.0.1:9999/api/v1"), "sk-or-1")

    assert provider._effective_base == "http://127.0.0.1:9999/api/v1"
    assert "HTTP-Referer" not in provider._default_headers and "X-Title" not in provider._default_headers


def test_the_same_key_model_and_base_keep_the_same_provider(make_config: MakeConfig) -> None:
    providers = OpenRouterProviders()
    holder = KeyHolder()
    holder.set("sk-or-1")
    first = providers.current(settings_of(make_config({})), holder.require())

    # The host pushes the same key again at every READY and agent.started: nothing changes.
    assert holder.set("sk-or-1") == "unchanged"
    assert providers.current(settings_of(make_config({"files.read": "allow"})), holder.require()) is first


def test_a_new_key_builds_a_new_provider_and_the_old_one_is_left_to_the_turn_holding_it(
    make_config: MakeConfig,
) -> None:
    providers = OpenRouterProviders()
    first = providers.current(settings_of(make_config({})), "sk-or-1")

    second = providers.current(settings_of(make_config({})), "sk-or-2")

    assert second is not first
    assert (first.api_key, second.api_key) == ("sk-or-1", "sk-or-2")
    assert providers.current(settings_of(make_config({})), "sk-or-2") is second


def test_a_new_model_or_base_builds_a_new_provider(make_config: MakeConfig, config_body: Callable[..., dict]) -> None:
    from nanobot.dots.protocol import parse_runtime_config

    providers = OpenRouterProviders()
    first = providers.current(settings_of(make_config({})), "sk-or-1")
    other_model = parse_runtime_config(config_body(model={"provider": "openrouter", "id": "other/model"}))

    second = providers.current(settings_of(other_model), "sk-or-1")
    third = providers.current(settings_of(other_model, "http://127.0.0.1:9999/api/v1"), "sk-or-1")

    assert second is not first and second.default_model == "other/model"
    assert third is not second


def test_the_key_goes_to_no_environment_variable(make_config: MakeConfig) -> None:
    before = dict(os.environ)

    OpenRouterProviders().current(settings_of(make_config({})), "sk-or-never-in-the-environment")

    assert dict(os.environ) == before
    assert not any("sk-or-never-in-the-environment" in value for value in os.environ.values())


@pytest.mark.parametrize("key", ["", "   "])
def test_a_provider_without_a_key_cannot_be_built(make_config: MakeConfig, key: str) -> None:
    with pytest.raises(ValueError, match="api_key"):
        OpenRouterProviders().current(settings_of(make_config({})), key)


def test_a_provider_is_never_given_a_stand_in_key() -> None:
    with pytest.raises(TypeError):
        OpenAICompatProvider(provider_name="openrouter")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="api_key"):
        OpenAICompatProvider(None, provider_name="openrouter")  # type: ignore[arg-type]


async def test_the_client_is_built_with_the_one_key_the_provider_holds(make_config: MakeConfig) -> None:
    provider = OpenRouterProviders().current(settings_of(make_config({})), "sk-or-1")

    with patch("nanobot.providers.openai_compat_provider.AsyncOpenAI") as client:
        await provider._ensure_client()

    assert client.call_args.kwargs["api_key"] == "sk-or-1"
