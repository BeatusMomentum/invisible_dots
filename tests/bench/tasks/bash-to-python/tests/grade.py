"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

import random, tempfile
r = random.Random(5)
files = ["/app/expenses.csv"]
for k in range(2):
    f = tempfile.NamedTemporaryFile("w", delete=False, suffix=".csv")
    f.write("date,category,amount\n" + "".join(f"2026-11-{d:02d},{r.choice(['zeta', 'alpha', 'mid'])},{r.uniform(0, 999):.2f}\n" for d in range(1, 15 + k * 10)))
    f.close(); files.append(f.name)
check(os.path.exists("/app/summary.sh"), "summary.sh is kept")
for f in files:
    want = subprocess.run(["bash", "/app/summary.sh", f], capture_output=True, text=True).stdout
    got = subprocess.run(["python3", "/app/summary.py", f], capture_output=True, text=True, timeout=30).stdout
    if got != want:
        import difflib
        print("".join(difflib.unified_diff(want.splitlines(True), got.splitlines(True), "summary.sh", "summary.py")))
    check(got == want, f"same output for {os.path.basename(f)}")
