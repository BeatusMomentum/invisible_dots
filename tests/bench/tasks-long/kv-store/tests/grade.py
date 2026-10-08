"""The checks of this task; any failed check gives the reward 0."""
import json, os, pathlib, re, subprocess, sys, time

def check(condition, what):
    if not condition:
        print("FAIL:", what, flush=True)
        sys.exit(1)
    print("ok:", what, flush=True)

import random, signal, threading, urllib.error, urllib.parse, urllib.request
BASE = "http://127.0.0.1:7070"

def call(method, path, body=None, headers=None):
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def key(k):
    return "/keys/" + urllib.parse.quote(k, safe="")

def kill():
    try:
        pid = int(pathlib.Path("/app/kv/server.pid").read_text().strip())
        os.kill(pid, signal.SIGKILL)
    except (OSError, ValueError):
        pass
    time.sleep(1)

def start():
    r = subprocess.run(["/app/kv/start.sh"], capture_output=True, text=True, timeout=60)
    check(r.returncode == 0, f"start.sh starts the server ({r.stderr[-200:]})")

kill()
start()
check(call("PUT", key("a"), b"1")[0] == 201, "PUT a new key: 201")
check(call("PUT", key("a"), b"2")[0] == 200, "PUT over it: 200")
check(call("GET", key("a")) == (200, b"2"), "GET gives the last value")
check(call("GET", key("missing"))[0] == 404, "GET of a missing key: 404")
check(call("PUT", key("gone"), b"x")[0] == 201 and call("DELETE", key("gone"))[0] == 204, "DELETE: 204")
check(call("DELETE", key("gone"))[0] == 404 and call("GET", key("gone"))[0] == 404, "a deleted key is gone")
odd = "dir/sub file?&=%"
check(call("PUT", key(odd), b"odd")[0] == 201 and call("GET", key(odd)) == (200, b"odd"), "a key with / and spaces")
blob = random.Random(1).randbytes(1_500_000)
check(call("PUT", key("blob"), blob)[0] == 201 and call("GET", key("blob")) == (200, blob), "a 1.5 MB binary value")
for k in ("user:1", "user:2", "item:1"):
    call("PUT", key(k), k.encode())
status, body = call("GET", "/keys?prefix=" + urllib.parse.quote("user:"))
check(status == 200 and json.loads(body) == ["user:1", "user:2"], "prefix listing, sorted")
check(call("PUT", key("short"), b"t", {"X-TTL": "2"})[0] == 201 and call("GET", key("short"))[0] == 200, "a key with a TTL")
time.sleep(3)
check(call("GET", key("short"))[0] == 404, "it expires")
check("short" not in json.loads(call("GET", "/keys?prefix=")[1]), "an expired key is not listed")
errors = []
def writer(t):
    for i in range(50):
        s, _ = call("PUT", key(f"c-{t}-{i}"), f"{t}-{i}".encode())
        if s != 201:
            errors.append((t, i, s))
threads = [threading.Thread(target=writer, args=(t,)) for t in range(20)]
for th in threads: th.start()
for th in threads: th.join()
check(not errors, f"1000 writes from 20 clients at once ({errors[:3]})")
call("PUT", key("last"), b"acked")
kill()
start()
check(call("GET", key("last")) == (200, b"acked"), "the last acknowledged write survives kill -9")
check(all(call("GET", key(f"c-{t}-{i}")) == (200, f"{t}-{i}".encode()) for t in range(20) for i in range(50)), "every concurrent write survives kill -9")
check(call("GET", key("a")) == (200, b"2") and call("GET", key("blob")) == (200, blob), "replaced and binary values survive")
check(call("GET", key("gone"))[0] == 404 and call("GET", key("short"))[0] == 404, "deleted and expired keys stay gone")
status, body = call("GET", "/stats")
check(status == 200 and json.loads(body) == {"keys": 1000 + 7}, f"stats counts the live keys ({body!r})")
kill()
