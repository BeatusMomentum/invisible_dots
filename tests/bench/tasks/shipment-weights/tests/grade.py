"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

got = lines("/app/answer.txt")
check(got[0].strip() == 'SKU-022', "the heaviest line's SKU")
check(abs(float(re.sub(r"[^0-9.]", "", got[1])) - 3846.3) < 0.051, "the total in kg")
