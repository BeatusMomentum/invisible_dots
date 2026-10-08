"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

check(os.path.exists("/app/top_ips.txt"), "top_ips.txt exists")
got = [" ".join(l.split()) for l in lines("/app/top_ips.txt")]
check(got == ['10.0.0.205 75', '10.0.4.249 64', '10.0.6.127 60'], "the three IPs and counts, in order")
