"""The OpenRouter key does not leave the process in an error: not in a message, not in a chained exception.

Two ways it could: a server or proxy echoes the Authorization header in its error body (that body is the
text of the provider's error), and a key with a character that cannot be sent in a header makes httpx or
h11 raise `Illegal header value b'Bearer <key>'`, which the openai client chains under "Connection error."
and a log of the chain prints. The first is scrubbed where the provider turns an error into text (`LLMProvider.failure_text`, the one
owner, for an error body and for any other exception alike); the second cannot happen, because the holder
refuses such a key.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest
from fakes.scripted_provider import says
from fakes.turn_harness import Harness
from loguru import logger

from nanobot.dots import store as s
from nanobot.dots.secrets import KeyHolder
from nanobot.dots.transcript_outbox import INBOUND_ID
from nanobot.dots.turns import OpeningMessage, TurnUnit
from nanobot.providers.base import REDACTED_KEY, LLMProvider, LLMResponse
from nanobot.providers.openai_compat_provider import OpenAICompatProvider
from nanobot.providers.registry import OPENROUTER

SECRET = "sk-or-v1-0123456789abcdefSECRETTAIL"


@pytest.fixture
async def echo_server() -> AsyncIterator[str]:
    """A server that answers every request with a 400 whose message is the request's Authorization header."""

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            length = next(
                (int(line.split(b":", 1)[1]) for line in head.split(b"\r\n") if line.lower().startswith(b"content-length")),
                0,
            )
            if length:
                await reader.readexactly(length)
            auth = next(
                (line.decode("latin-1") for line in head.split(b"\r\n") if line.lower().startswith(b"authorization")),
                "",
            )
            body = json.dumps({"error": {"message": f"Invalid header: {auth}", "code": 400}}).encode()
            writer.write(
                b"HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: "
                + str(len(body)).encode()
                + b"\r\nconnection: close\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        server.close()
        await server.wait_closed()


def provider_for(base_url: str, key: str = SECRET) -> OpenAICompatProvider:
    return OpenAICompatProvider(
        api_key=key, api_base=base_url, default_model="m", spec=OPENROUTER, provider_name=OPENROUTER.name
    )


MESSAGES: list[dict[str, Any]] = [{"role": "user", "content": "hi"}]


@pytest.mark.parametrize("how", ["chat_stream", "chat_stream_with_retry"])
async def test_a_key_the_server_echoes_is_removed_from_the_error_text(echo_server: str, how: str) -> None:
    response = await getattr(provider_for(echo_server), how)(MESSAGES, max_tokens=10)

    assert response.finish_reason == "error"
    assert "Invalid header" in response.content
    assert SECRET not in response.content
    assert "SECRETTAIL" not in response.content
    assert REDACTED_KEY in response.content


class BodyError(Exception):
    """An error that carries a response body, as the openai client's status errors do."""

    def __init__(self, body: str) -> None:
        super().__init__("status error")
        self.body = body


def longest_shared_run(text: str, key: str) -> int:
    """The length of the longest part of `key` that `text` contains."""
    for size in range(len(key), 0, -1):
        if any(key[i : i + size] in text for i in range(len(key) - size + 1)):
            return size
    return 0


# The error body is cut to 500 characters. A key that straddles the cut must not leave its prefix behind.
@pytest.mark.parametrize("offset", [0, 100, 480, 490, 495, 499, 500, 501])
def test_a_key_echoed_around_the_500_character_cut_leaves_no_part_of_it(offset: int) -> None:
    body = "x" * offset + SECRET + " and what follows the key " + "y" * 600
    provider = provider_for("http://127.0.0.1:1/v1")

    response = provider._handle_error(BodyError(body))

    assert response.finish_reason == "error"
    assert longest_shared_run(response.content, SECRET) < 8, response.content[-60:]
    assert len(response.content) <= len("Error: ") + 500


class FailingProvider(LLMProvider):
    """A provider whose request raises whatever the test says, past any provider-specific handling."""

    def __init__(self, failure: Exception) -> None:
        super().__init__(provider_name="failing", api_key=SECRET)
        self.failure = failure

    async def chat_stream(self, *args: Any, **kwargs: Any) -> LLMResponse:
        raise self.failure

    def get_default_model(self) -> str:
        return "m"


# One place turns a provider's failure into text: an exception that does not come out of the provider's own
# error handling (here a plain one, and one with a body) goes through the same redaction.
@pytest.mark.parametrize(
    "failure",
    [
        RuntimeError(f"upstream said: Bearer {SECRET}"),
        BodyError("x" * 495 + SECRET),
        RuntimeError(f"{SECRET}"),
    ],
    ids=["message", "body-at-the-cut", "message-is-the-key"],
)
async def test_an_exception_the_provider_did_not_handle_is_turned_into_text_without_the_key(
    failure: Exception,
) -> None:
    response = await FailingProvider(failure).chat_stream_with_retry(MESSAGES, max_tokens=10)

    assert response.finish_reason == "error"
    assert longest_shared_run(response.content, SECRET) < 8, response.content


def test_the_two_paths_that_make_error_text_agree_on_what_it_says() -> None:
    failure = RuntimeError(f"upstream said: {SECRET}")
    handled = provider_for("http://127.0.0.1:1/v1")._handle_error(failure)
    unhandled = FailingProvider(failure)._error_response_from_exception(failure)

    assert handled.content == unhandled.content == f"Error calling LLM: upstream said: {REDACTED_KEY}"


async def test_a_turn_that_fails_on_an_echoed_key_leaves_it_in_no_log_no_event_and_no_transcript(
    make_harness: Callable[..., Harness], echo_server: str
) -> None:
    h = make_harness([says("never asked")])
    h.providers.provider = provider_for(echo_server)  # type: ignore[assignment]
    h.keys.set(SECRET)
    h.accept("in1")
    lines: list[str] = []
    sink = logger.add(lines.append, level="TRACE", backtrace=True, diagnose=False)
    try:
        outcome = await h.run(TurnUnit(s.CHAT_SESSION_KEY, None, (OpeningMessage("hello", {INBOUND_ID: "in1"}),)))
    finally:
        logger.remove(sink)

    everything = json.dumps(
        {
            "outcome": [outcome.kind, outcome.reason],
            "logs": "".join(lines),
            "events": h.events(),
            "messages": h.messages(),
        },
        default=str,
    )
    assert SECRET not in everything
    assert "SECRETTAIL" not in everything
    assert REDACTED_KEY in everything  # the error did happen, and was reported without the key


# A newline or a NUL inside a key passes any trim at the ends, and httpx's h11 refuses the request it is in.
@pytest.mark.parametrize("breaker", ["\n", "\r\n", "\x00"])
async def test_a_key_that_makes_httpx_raise_carries_itself_in_the_chain_and_the_holder_refuses_it(
    echo_server: str, breaker: str
) -> None:
    key = f"sk-or-v1-SECRETHEAD{breaker}SECRETTAIL"
    client = await provider_for(echo_server, key)._ensure_client()
    caught: BaseException | None = None
    try:
        await client.with_options(max_retries=0).chat.completions.create(model="m", messages=MESSAGES)  # type: ignore[arg-type]
    except Exception as error:
        caught = error
    assert caught is not None, "this character no longer makes the request fail: drop it from the list"

    chain: list[str] = []
    link: BaseException | None = caught
    while link is not None:
        chain.append(f"{type(link).__name__}: {link}")
        link = link.__cause__ or link.__context__
    # The mechanism: the whole key is in the text of an exception under the one the client raises.
    assert any("SECRETHEAD" in text for text in chain[1:]), chain

    # So such a key never gets to a provider: the holder is where a key becomes one the Dot may hold.
    holder = KeyHolder()
    with pytest.raises(ValueError) as refused:
        holder.set(key)
    assert "SECRET" not in str(refused.value)
    assert holder.configured is False
