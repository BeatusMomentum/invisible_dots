"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

def get(key):
    return subprocess.run(["git", "config", "--global", "--get", key], capture_output=True, text=True).stdout.strip()
check(get("user.name") == "Dot Bench", "user.name")
check(get("user.email") == "dot@bench.example", "user.email")
check(get("init.defaultBranch") == "main", "init.defaultBranch")
check(get("alias.last").replace("git ", "") == "log -1 HEAD", "alias.last")
