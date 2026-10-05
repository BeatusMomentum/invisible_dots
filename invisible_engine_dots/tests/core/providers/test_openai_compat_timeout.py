from unittest.mock import patch, sentinel

from nanobot.providers.openai_compat_provider import OpenAICompatProvider


def _assert_openai_compat_timeout(timeout) -> None:
    assert timeout == 120.0


async def test_openai_compat_provider_defers_sdk_client_until_first_use() -> None:
    with patch("nanobot.providers.openai_compat_provider.AsyncOpenAI") as mock_async_openai:
        provider = OpenAICompatProvider(api_key="test-key", api_base="https://example.com/v1")
        mock_async_openai.assert_not_called()
        await provider._ensure_client()

    kwargs = mock_async_openai.call_args.kwargs
    _assert_openai_compat_timeout(kwargs["timeout"])
    # Cloud endpoints pass http_client=None so the SDK creates its own
    # DefaultAsyncHttpxClient, which already handles proxy env vars,
    # connection limits, and redirects correctly.
    assert kwargs["http_client"] is None


async def test_openai_compat_provider_sets_timeout_on_local_http_client() -> None:
    with (
        patch("nanobot.providers.openai_compat_provider.AsyncOpenAI") as mock_async_openai,
        patch(
            "httpx.AsyncClient",
            return_value=sentinel.http_client,
        ) as mock_http_client,
    ):
        provider = OpenAICompatProvider(api_key="test-key", api_base="http://127.0.0.1:11434/v1")
        mock_async_openai.assert_not_called()
        await provider._ensure_client()

    client_kwargs = mock_http_client.call_args.kwargs
    _assert_openai_compat_timeout(client_kwargs["timeout"])
    assert client_kwargs["limits"].keepalive_expiry == 0

    openai_kwargs = mock_async_openai.call_args.kwargs
    _assert_openai_compat_timeout(openai_kwargs["timeout"])
    assert openai_kwargs["http_client"] is sentinel.http_client


async def test_openai_compat_provider_timeout_is_a_constructor_argument(monkeypatch) -> None:
    # The environment is not a source of configuration: only the argument counts.
    monkeypatch.setenv("NANOBOT_OPENAI_COMPAT_TIMEOUT_S", "45")

    with patch("nanobot.providers.openai_compat_provider.AsyncOpenAI") as mock_async_openai:
        provider = OpenAICompatProvider(
            api_key="test-key",
            api_base="https://example.com/v1",
            request_timeout_s=45.0,
        )
        await provider._ensure_client()
        assert mock_async_openai.call_args.kwargs["timeout"] == 45.0

        monkeypatch.setenv("NANOBOT_OPENAI_COMPAT_TIMEOUT_S", "7")
        other = OpenAICompatProvider(api_key="test-key", api_base="https://example.com/v1")
        await other._ensure_client()
        assert mock_async_openai.call_args.kwargs["timeout"] == 120.0
