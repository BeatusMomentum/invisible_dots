"""A forward proxy with Basic authentication, for the browser smoke's identity with a proxy.

    PROXY_USER=<user> PROXY_PASSWORD=<password> python3 proxy.py <port>

The credentials come by the environment, not the command line, which every user of the machine can read.

It answers 407 to a request without the credentials, tunnels a CONNECT, and forwards a plain
`GET http://host/...` request, which is what the browser's egress lookup and the library's probe of
the exit send. It prints the method and target of each request it accepted (never the credentials) and listens
on 127.0.0.1 only. Standard library only: the container has python3 and
nothing else.
"""

from __future__ import annotations

import asyncio
import base64
import os
import sys
from urllib.parse import urlsplit

PORT = int(sys.argv[1])
EXPECTED = "Basic " + base64.b64encode(f"{os.environ['PROXY_USER']}:{os.environ['PROXY_PASSWORD']}".encode()).decode()


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def refuse(writer: asyncio.StreamWriter, status: str) -> None:
    writer.write(f"HTTP/1.1 {status}\r\nProxy-Authenticate: Basic realm=smoke\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
    await writer.drain()
    writer.close()


async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        method, target, version = lines[0].split(" ", 2)
        headers = {name.lower(): value for name, _, value in (line.partition(": ") for line in lines[1:] if line)}
        if headers.get("proxy-authorization") != EXPECTED:
            await refuse(writer, "407 Proxy Authentication Required")
            return
        print(method, target, flush=True)  # the smoke reads what went through
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            upstream_reader, upstream_writer = await asyncio.open_connection(host, int(port))
            writer.write(f"{version} 200 Connection established\r\n\r\n".encode())
            await writer.drain()
        else:
            url = urlsplit(target)
            upstream_reader, upstream_writer = await asyncio.open_connection(url.hostname, url.port or 80)
            kept = [line for line in lines[1:] if line and not line.lower().startswith(("proxy-", "connection:"))]
            path = (url.path or "/") + (f"?{url.query}" if url.query else "")
            request = f"{method} {path} {version}\r\n" + "\r\n".join(kept) + "\r\nConnection: close\r\n\r\n"
            upstream_writer.write(request.encode("latin-1"))
            await upstream_writer.drain()
        await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer))
    except (OSError, asyncio.IncompleteReadError, ValueError):
        writer.close()


async def main() -> None:
    server = await asyncio.start_server(serve, "127.0.0.1", PORT)
    async with server:
        await server.serve_forever()


asyncio.run(main())
