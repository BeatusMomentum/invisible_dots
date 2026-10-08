"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

import urllib.request, urllib.error
pid = int(pathlib.Path("/app/server.pid").read_text().strip())
check(os.path.exists(f"/proc/{pid}"), f"the process {pid} of server.pid runs")
body = urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=10).read()
check(json.loads(body) == {"status": "ok"}, "/health answers {'status': 'ok'}")
try:
    urllib.request.urlopen("http://127.0.0.1:8765/nope", timeout=10)
    check(False, "/nope answers 404")
except urllib.error.HTTPError as e:
    check(e.code == 404, "/nope answers 404")
