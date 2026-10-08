"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

import shutil
shutil.rmtree("/app/backup", ignore_errors=True)
out = subprocess.run(["./backup.sh"], cwd="/app", capture_output=True, text=True, timeout=60)
check(out.returncode == 0, f"./backup.sh exits 0 (got {out.returncode}: {out.stderr[-300:]})")
check(out.stdout.strip() == "backed up 4 files", f"it says it backed up 4 files (said {out.stdout.strip()!r})")
names = sorted(str(p.relative_to("/app/backup")) for p in pathlib.Path("/app/backup").rglob("*") if p.is_file())
expected = [["a.txt", "b.txt", "work/meeting notes.txt", "work/todo.txt"], ["notes/a.txt", "notes/b.txt", "notes/work/meeting notes.txt", "notes/work/todo.txt"]]
check(names in expected, f"the four .txt files, structure kept (got {names})")
check(not any(n.endswith(".md") for n in names), "the .md file is not copied")
