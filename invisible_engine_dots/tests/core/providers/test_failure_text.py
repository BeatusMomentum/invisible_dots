"""The text a provider failure becomes, which the person reads in the chat ("I could not answer: ...")."""

from __future__ import annotations

import httpx
import openai
import pytest

from nanobot.providers.openai_compat_provider import OpenAICompatProvider
from nanobot.providers.registry import OPENROUTER


def provider() -> OpenAICompatProvider:
    return OpenAICompatProvider(
        api_key="sk-or-v1-0123456789abcdef", api_base="https://example.com/v1",
        default_model="m", spec=OPENROUTER, provider_name=OPENROUTER.name,
    )


def bad_request(body: object) -> openai.BadRequestError:
    request = httpx.Request("POST", "https://example.com/v1/chat/completions")
    return openai.BadRequestError("Error code: 400", response=httpx.Response(400, request=request), body=body)


@pytest.mark.parametrize(
    "body",
    [
        # What OpenRouter answered for a model id that does not exist, as the client parsed it.
        {"message": "no-such-vendor/no-such-model-9 is not a valid model ID", "code": 400},
        {"error": {"message": "no-such-vendor/no-such-model-9 is not a valid model ID", "code": 400}},
    ],
)
def test_a_parsed_error_body_becomes_its_message_not_its_python_repr(body: object) -> None:
    text = provider().failure_text(bad_request(body))

    assert text == "Error: no-such-vendor/no-such-model-9 is not a valid model ID"


def test_a_parsed_body_without_a_message_is_shown_as_json() -> None:
    text = provider().failure_text(bad_request({"code": 400, "detail": "nope"}))

    assert text == 'Error: {"code": 400, "detail": "nope"}'


def test_a_text_body_is_kept_as_it_is() -> None:
    text = provider().failure_text(bad_request("upstream said no"))

    assert text == "Error: upstream said no"
