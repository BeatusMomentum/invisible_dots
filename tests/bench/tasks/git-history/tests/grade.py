"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

check(pathlib.Path("/app/bad_commit.txt").read_text().strip() == pathlib.Path("/app/.bad").read_text().strip(), "the commit that introduced the bug")
out = subprocess.run(["python3", "calc.py"], cwd="/app/project", capture_output=True, text=True).stdout.strip()
check(out == "6", f"calc.py prints 6 (prints {out!r})")
head = pathlib.Path("/app/.head").read_text().strip()
anc = subprocess.run(["git", "merge-base", "--is-ancestor", head, "HEAD"], cwd="/app/project").returncode
check(anc == 0, "the old history is kept, the fix is on top")
dirty = subprocess.run(["git", "status", "--porcelain", "--", "calc.py"], cwd="/app/project", capture_output=True, text=True).stdout.strip()
check(dirty == "", "the fix is committed")
