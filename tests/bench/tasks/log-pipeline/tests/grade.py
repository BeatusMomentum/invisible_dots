"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

import csv, shutil
expected = {'2026-10-01': (88, 1, 2864.55), '2026-10-02': (110, 4, 2950.7), '2026-10-03': (85, 4, 2882.4), '2026-10-04': (149, 9, 2948.8), '2026-10-05': (138, 3, 2814.9), '2026-10-06': (134, 4, 2856.7), '2026-10-07': (123, 6, 2842.6)}
def verify(what):
    rows = list(csv.DictReader(open("/app/daily.csv")))
    check([r["day"] for r in rows] == sorted(expected), f"{what}: one row per day, oldest first")
    for r in rows:
        n, e, p = expected[r["day"]]
        check(int(r["lines"]) == n and int(r["errors"]) == e and abs(float(r["p95_ms"]) - p) <= 0.05 + 1e-9, f"{what}: {r['day']} is {n},{e},{p} (got {r['lines']},{r['errors']},{r['p95_ms']})")
verify("daily.csv")
os.remove("/app/daily.csv")
out = subprocess.run(["bash", "/app/daily.sh"], cwd="/app", capture_output=True, text=True, timeout=120)
check(out.returncode == 0, f"daily.sh runs ({out.stderr[-300:]})")
verify("daily.sh's daily.csv")
