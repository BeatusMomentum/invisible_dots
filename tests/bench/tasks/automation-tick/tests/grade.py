"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

import datetime
stamps = [datetime.datetime.strptime(l.strip(), "%H:%M:%S") for l in lines("/app/tick.log") if re.fullmatch(r"\d\d:\d\d:\d\d", l.strip())]
check(len(stamps) >= 2, f"at least two lines (got {len(stamps)})")
gaps = [(b - a).total_seconds() % 86400 for a, b in zip(stamps, stamps[1:])]
check(any(40 <= g <= 80 for g in gaps), f"two lines about a minute apart (gaps {gaps})")
