"""The reference key-value server of the kv-store task: a log of every change, fsynced before the answer."""
import base64
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
LOG = os.path.join(DATA, "log.jsonl")
os.makedirs(DATA, exist_ok=True)
store: dict[str, tuple[bytes, float | None]] = {}
lock = threading.Lock()

if os.path.exists(LOG):
    with open(LOG, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                break  # a record cut by a crash: everything before it was acknowledged
            if rec["op"] == "put":
                store[rec["key"]] = (base64.b64decode(rec["value"]), rec["expires"])
            else:
                store.pop(rec["key"], None)
log = open(LOG, "a", encoding="utf-8")


def append(rec):
    log.write(json.dumps(rec) + "\n")
    log.flush()
    os.fsync(log.fileno())


def alive(key, now):
    item = store.get(key)
    if item is None:
        return None
    value, expires = item
    if expires is not None and expires <= now:
        return None
    return value


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body=b"", content_type="application/octet-stream"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def key(self):
        path = urlparse(self.path).path
        return unquote(path[len("/keys/"):]) if path.startswith("/keys/") and len(path) > len("/keys/") else None

    def do_GET(self):
        url = urlparse(self.path)
        now = time.time()
        if url.path == "/keys":
            prefix = parse_qs(url.query).get("prefix", [""])[0]
            with lock:
                keys = sorted(k for k in store if k.startswith(prefix) and alive(k, now) is not None)
            return self.reply(200, json.dumps(keys).encode(), "application/json")
        if url.path == "/stats":
            with lock:
                n = sum(1 for k in store if alive(k, now) is not None)
            return self.reply(200, json.dumps({"keys": n}).encode(), "application/json")
        key = self.key()
        if key is None:
            return self.reply(404)
        with lock:
            value = alive(key, now)
        if value is None:
            return self.reply(404)
        self.reply(200, value)

    def do_PUT(self):
        key = self.key()
        if key is None:
            return self.reply(400)
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        ttl = self.headers.get("X-TTL")
        expires = time.time() + float(ttl) if ttl else None
        with lock:
            existed = alive(key, time.time()) is not None
            append({"op": "put", "key": key, "value": base64.b64encode(body).decode(), "expires": expires})
            store[key] = (body, expires)
        self.reply(200 if existed else 201)

    def do_DELETE(self):
        key = self.key()
        if key is None:
            return self.reply(400)
        with lock:
            if alive(key, time.time()) is None:
                return self.reply(404)
            append({"op": "delete", "key": key})
            store.pop(key, None)
        self.reply(204)


ThreadingHTTPServer(("127.0.0.1", 7070), Handler).serve_forever()
