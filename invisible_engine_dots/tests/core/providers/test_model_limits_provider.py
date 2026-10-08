"""The OpenAI-compatible provider reads each model's limits from the endpoint's list of models (OpenRouter's)."""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator

import pytest
from aiohttp import web

from nanobot.providers.base import ModelLimits
from nanobot.providers.openai_compat_provider import OpenAICompatProvider

MODELS = [
    {"id": "z-ai/glm-5.3-flash", "context_length": 1_048_576, "top_provider": {"context_length": 1_048_575, "max_completion_tokens": 943_717}},
    {"id": "openai/gpt-5-mini", "context_length": 400_000, "top_provider": {"context_length": 400_000, "max_completion_tokens": 128_000}},
    # A router chooses the model per request: OpenRouter publishes no limits for it.
    {"id": "openrouter/auto", "context_length": 2_000_000, "top_provider": {"context_length": None, "max_completion_tokens": None}},
]


class ModelsEndpoint:
    def __init__(self) -> None:
        self.reads = 0

    async def models(self, request: web.Request) -> web.Response:
        self.reads += 1
        return web.json_response({"data": MODELS})


@pytest.fixture
async def served() -> AsyncIterator[tuple[OpenAICompatProvider, ModelsEndpoint]]:
    endpoint = ModelsEndpoint()
    app = web.Application()
    app.router.add_get("/api/v1/models", endpoint.models)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    await web.TCPSite(runner, "127.0.0.1", port).start()
    provider = OpenAICompatProvider(api_key="sk-or-test", api_base=f"http://127.0.0.1:{port}/api/v1", provider_name="openrouter")
    try:
        yield provider, endpoint
    finally:
        await runner.cleanup()


async def test_each_model_has_the_window_and_the_longest_answer_of_its_default_provider(served) -> None:
    provider, endpoint = served

    assert await provider.model_limits("z-ai/glm-5.3-flash") == ModelLimits(context_tokens=1_048_575, answer_tokens=943_717)
    assert await provider.model_limits("openai/gpt-5-mini") == ModelLimits(context_tokens=400_000, answer_tokens=128_000)
    # Read once for every model.
    assert endpoint.reads == 1


async def test_a_router_has_unknown_limits(served) -> None:
    provider, _ = served

    assert await provider.model_limits("openrouter/auto") == ModelLimits()


async def test_a_model_the_endpoint_does_not_list_is_an_error(served) -> None:
    provider, _ = served

    with pytest.raises(LookupError, match="does not list the model no/such-model"):
        await provider.model_limits("no/such-model")
