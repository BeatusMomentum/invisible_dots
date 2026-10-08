"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

sys.path.insert(0, "/app")
from paginate import paginate
items = list(range(1, 24))
check(paginate(items, 1, 5) == ([1, 2, 3, 4, 5], 5), "page 1 of 23 items by 5")
check(paginate(items, 5, 5) == ([21, 22, 23], 5), "the last, short page")
check(paginate(items, 6, 5) == ([], 5), "a page past the end is empty")
check(paginate(list(range(10)), 2, 5) == ([5, 6, 7, 8, 9], 2), "an exact last page")
check(paginate([], 1, 3) == ([], 0), "no items, no pages")
for bad in ((0, 5), (1, 0)):
    try:
        paginate(items, *bad)
        check(False, f"{bad} raises ValueError")
    except ValueError:
        check(True, f"{bad} raises ValueError")
