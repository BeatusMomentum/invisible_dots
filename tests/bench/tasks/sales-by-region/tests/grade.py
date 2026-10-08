"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

region, value = pathlib.Path("/app/answer.txt").read_text().split()[:2]
check(region == 'North', "the region")
check(abs(float(value) - 38154.04) < 0.011, "its revenue")
