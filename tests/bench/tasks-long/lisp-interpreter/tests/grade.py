"""The checks of this task; any failed check gives the reward 0."""
import json, os, pathlib, re, subprocess, sys, time

def check(condition, what):
    if not condition:
        print("FAIL:", what, flush=True)
        sys.exit(1)
    print("ok:", what, flush=True)

import tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lisp_cases import CASES
check(os.access("/app/lisp", os.X_OK), "/app/lisp is executable")
passed = 0
for name, program, stdout, code, err in CASES:
    f = tempfile.NamedTemporaryFile("w", suffix=".scm", delete=False); f.write(program); f.close()
    try:
        r = subprocess.run(["/app/lisp", f.name], capture_output=True, text=True, timeout=120)
        ok = r.stdout == stdout and r.returncode == code and err.lower() in r.stderr.lower()
        detail = f"stdout {r.stdout[:120]!r} exit {r.returncode}"
    except subprocess.TimeoutExpired:
        ok, detail = False, "timed out"
    print(("ok" if ok else "FAIL") + ":", name, "" if ok else detail, flush=True)
    passed += ok
check(passed == len(CASES), f"{passed} of {len(CASES)} programs")
