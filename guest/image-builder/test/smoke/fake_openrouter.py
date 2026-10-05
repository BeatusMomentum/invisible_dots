#!/usr/bin/env python3
"""A stand-in for OpenRouter's chat completions API, for the smoke test.

It answers by looking at the conversation (the last non-system message and the
last user text, substring matches):
- the last message a tool result: a final answer quoting it;
- a user message with RUN-EXEC <cmd>: a call of the exec tool with <cmd>;
- a user message with SAY-RUN-EXEC <text> :: <cmd>: the same call with <text> written beside it;
- a user message with "interrupted by a restart": a final answer;
- an approval's continuation: the approved call again, or "rejection noted";
- anything else: "hello from the stand-in".

Every request is appended to /tmp/fake-requests.jsonl; every request with a
body is appended whole (messages, system prompt included, and the tools with
their descriptions and schemas) to /tmp/fake-full.jsonl, and summed up (tool
names, roles, the last user text) in /tmp/fake-tools.jsonl.

    fake_openrouter.py <port> <key>

The key is the smoke script's (smoke.sh owns it) and arrives on the command
line, not in the environment: the smoke asserts that no process environment
holds the key. Without both arguments the stand-in refuses to start.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = ""  # set by main() from the command line
REQUESTS = "/tmp/fake-requests.jsonl"
FULL = "/tmp/fake-full.jsonl"
TOOLS = "/tmp/fake-tools.jsonl"

_lock = threading.Lock()
_counter = 0


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") if isinstance(part, dict) and isinstance(part.get("text"), str) else "" for part in content)
    return ""


def append(path: str, line: object) -> None:
    with _lock, open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(line) + "\n")


def decide(messages: list[dict]) -> dict:
    conversation = [m for m in messages if m.get("role") not in ("system", "developer")]
    last = conversation[-1] if conversation else {}
    if last.get("role") == "tool":
        return {"text": f"done: {text_of(last.get('content'))[:200]}"}
    last_user = next((m for m in reversed(conversation) if m.get("role") == "user"), None)
    said = text_of(last_user.get("content")) if last_user else ""
    if "interrupted by a restart" in said:
        return {"text": "resumed and finished"}
    # The engine's continuations after an approval (nanobot/dots/engine.py).
    if "[The user rejected your" in said:
        return {"text": "rejection noted"}
    granted = re.search(r"\[The user approved your (\w+) call .* it will run once: (\{.*\})\]", said, re.S)
    if granted:
        return {"tool": {"name": granted.group(1), "args": json.loads(granted.group(2))}}
    if "KILL-SESSION" in said:
        # Terminate the exec session the last RUN-SESSION started: its id is in that call's result.
        for message in reversed(conversation):
            found = re.search(r"session_id: (\S+)", text_of(message.get("content"))) if message.get("role") == "tool" else None
            if found:
                return {"tool": {"name": "exec_session", "args": {"session_id": found.group(1), "terminate": True}}}
        return {"text": "no session to kill"}
    session = re.search(r"RUN-SESSION (.+)$", said, re.M)
    if session:
        # exec as a background session: it answers after 200 ms with a session id while the command runs on.
        return {"tool": {"name": "exec", "args": {"command": session.group(1).strip(), "yield_time_ms": 200}}}
    narrated = re.search(r"SAY-RUN-EXEC (.+?) :: (.+)$", said, re.M)
    if narrated:
        return {"text": narrated.group(1).strip(), "tool": {"name": "exec", "args": {"command": narrated.group(2).strip()}}}
    run = re.search(r"RUN-EXEC (.+)$", said, re.M)
    if run:
        return {"tool": {"name": "exec", "args": {"command": run.group(1).strip()}}}
    return {"text": "hello from the stand-in"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002
        return

    def _send_json(self, status: int, body: object) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _handle(self) -> None:
        global _counter
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        append(
            REQUESTS,
            {
                "method": self.command,
                "url": self.path,
                "auth": "present" if self.headers.get("authorization") else "absent",
                "referer": self.headers.get("http-referer"),
                "title": self.headers.get("x-title"),
            },
        )
        if self.command == "POST" and body:
            try:
                parsed = json.loads(body)
            except ValueError:
                parsed = None
            if isinstance(parsed, dict):
                append(FULL, parsed)
                tools = [(t.get("function") or t).get("name") for t in parsed.get("tools") or []]
                messages = parsed.get("messages") or []
                last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
                append(
                    TOOLS,
                    {
                        "model": parsed.get("model"),
                        "tools": tools,
                        "roles": [m.get("role") for m in messages],
                        "lastUser": text_of(last_user.get("content") if last_user else None)[-400:],
                    },
                )
        if self.command == "GET" and "/models" in self.path:
            self._send_json(
                200,
                {
                    "data": [
                        {
                            "id": "openai/gpt-4o-mini",
                            "name": "stand-in",
                            "context_length": 128000,
                            "pricing": {"prompt": "0", "completion": "0"},
                            "supported_parameters": ["tools", "tool_choice"],
                        }
                    ]
                },
            )
            return
        if "/chat/completions" not in self.path:
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        if self.headers.get("authorization") != f"Bearer {KEY}":
            self._send_json(401, {"error": {"message": "bad key", "code": 401}})
            return
        request = json.loads(body or "{}")
        answer = decide(request.get("messages") or [])
        with _lock:
            _counter += 1
            number = _counter
        completion_id = f"chatcmpl-{number}"
        model = request.get("model") or "openai/gpt-4o-mini"
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0}
        tool = answer.get("tool")
        # Every call of every response is "call_0", as with the models behind OpenRouter that number
        # their calls from zero each time: the engine must tell calls apart by more than the id.
        call_id = "call_0"
        finish = "tool_calls" if tool else "stop"
        now = int(time.time())
        if not request.get("stream"):
            message = (
                {
                    "role": "assistant",
                    "content": answer.get("text"),
                    "tool_calls": [
                        {"id": call_id, "type": "function", "function": {"name": tool["name"], "arguments": json.dumps(tool["args"])}}
                    ],
                }
                if tool
                else {"role": "assistant", "content": answer["text"]}
            )
            self._send_json(
                200,
                {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": now,
                    "model": model,
                    "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                    "usage": usage,
                },
            )
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def chunk(delta: dict, finish_reason: str | None = None, extra: dict | None = None) -> None:
            frame = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": now,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
                **(extra or {}),
            }
            self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode("utf-8"))

        chunk({"role": "assistant"})
        if tool:
            if answer.get("text"):
                chunk({"content": answer["text"]})
            chunk({"tool_calls": [{"index": 0, "id": call_id, "type": "function", "function": {"name": tool["name"], "arguments": ""}}]})
            chunk({"tool_calls": [{"index": 0, "function": {"arguments": json.dumps(tool["args"])}}]})
        else:
            chunk({"content": answer["text"]})
        chunk({}, finish)
        usage_frame = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": now,
            "model": model,
            "choices": [],
            "usage": usage,
        }
        self.wfile.write(f"data: {json.dumps(usage_frame)}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True

    do_GET = _handle
    do_POST = _handle


def main() -> None:
    global KEY
    if len(sys.argv) != 3 or not sys.argv[2]:
        sys.exit("usage: fake_openrouter.py <port> <key>: the key is the smoke script's, there is no default")
    port = int(sys.argv[1])
    KEY = sys.argv[2]
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print(f"fake openrouter on {port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
