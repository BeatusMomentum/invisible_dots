"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

root = pathlib.Path("/app/project")
files = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
check(files == ["Makefile", "docs/build.md", "docs/demo.o.txt", "src/a.c", "src/lib/b.c", "src/x.py"], f"only the leftovers are gone (left {files})")
check(not (root / "build").exists() and not any(root.rglob("__pycache__")), "build and __pycache__ are gone")
