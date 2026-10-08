"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

s = json.loads(pathlib.Path("/app/stats.json").read_text())
check(abs(float(s["median"]) - 18.4) <= 0.005 + 1e-9, "median")
check(abs(float(s["stdev"]) - 6.225090674252303) <= 0.005 + 1e-9, "population standard deviation")
check(int(s["hot_days"]) == 58, "days above 25")
