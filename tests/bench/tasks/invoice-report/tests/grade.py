"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

rows = []
for l in lines("/app/report.md"):
    cells = [c.strip().strip("*") for c in l.strip().strip("|").split("|")]
    if len(cells) == 2 and not set(cells[0]) <= set("-: "):
        rows.append(cells)
check(rows[0][0].lower() == "client" and rows[0][1].lower() == "total", "the header is Client | Total")
body = [(c, round(float(v.replace(",", "")), 2)) for c, v in rows[1:]]
expected = [('Bianchi SpA', 6835.2), ('Verdi & Co', 6782.15), ('Rossi Srl', 3946.06)] + [("TOTAL", 17563.41)]
check(len(body) == len(expected), f"{len(expected)} rows")
for (c, v), (ec, ev) in zip(body, expected):
    check(c == ec and abs(v - ev) < 0.011, f"{ec} totals {ev} (got {c} {v})")
