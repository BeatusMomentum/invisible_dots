"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

import collections, tempfile
def expected(text, n):
    words = re.findall(r"[a-z]+", text.lower())
    return [f"{w} {c}" for w, c in sorted(collections.Counter(words).items(), key=lambda x: (-x[1], x[0]))[:n]]
texts = ["Apple banana apple, Cherry! banana apple? cherry date.", "z y x z y z w w w w", pathlib.Path("/app/sample.txt").read_text()]
for i, text in enumerate(texts):
    f = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt"); f.write(text); f.close()
    for n in (3, None):
        args = ["/app/wordfreq", f.name] + (["-n", str(n)] if n else [])
        out = subprocess.run(args, capture_output=True, text=True, timeout=30)
        got = [" ".join(l.split()) for l in out.stdout.splitlines() if l.strip()]
        check(got == expected(text, n or 10), f"text {i}, -n {n}: {got[:4]}")
