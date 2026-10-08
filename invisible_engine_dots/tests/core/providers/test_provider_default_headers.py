"""The Dot's OpenRouter attribution: one owner, sent only to openrouter.ai."""

from nanobot.providers.openai_compat_provider import (
    _DEFAULT_OPENROUTER_HEADERS,
    OpenAICompatProvider,
)
from nanobot.providers.registry import OPENROUTER

_DOT_HEADERS = {
    "HTTP-Referer": "https://github.com/feder-cr/invisible_dots",
    "X-Title": "invisible_dots",
}


def test_attribution_is_the_dots() -> None:
    assert _DEFAULT_OPENROUTER_HEADERS == _DOT_HEADERS


def test_openrouter_base_gets_the_attribution_headers() -> None:
    provider = OpenAICompatProvider(
        api_key="k",
        api_base="https://openrouter.ai/api/v1",
        spec=OPENROUTER,
        provider_name="openrouter",
    )

    for name, value in _DOT_HEADERS.items():
        assert provider._default_headers[name] == value


def test_spec_default_base_is_openrouter_and_gets_the_attribution_headers() -> None:
    provider = OpenAICompatProvider(api_key="k", spec=OPENROUTER, provider_name="openrouter")

    assert provider._effective_base == "https://openrouter.ai/api/v1"
    for name, value in _DOT_HEADERS.items():
        assert provider._default_headers[name] == value


def test_a_local_stand_in_never_receives_the_attribution_headers() -> None:
    provider = OpenAICompatProvider(
        api_key="k",
        api_base="http://127.0.0.1:9999/api/v1",
        spec=OPENROUTER,
        provider_name="openrouter",
    )

    for name in _DOT_HEADERS:
        assert name not in provider._default_headers


def test_a_lookalike_host_never_receives_the_attribution_headers() -> None:
    for base in (
        "https://openrouter.ai.evil.example/api/v1",
        "https://evil.example/openrouter.ai/api/v1",
        "https://notopenrouter.ai/api/v1",
    ):
        provider = OpenAICompatProvider(api_key="k", api_base=base, provider_name="x")

        for name in _DOT_HEADERS:
            assert name not in provider._default_headers, base
