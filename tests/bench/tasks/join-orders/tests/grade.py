"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

import csv
rows = list(csv.DictReader(open("/app/by_country.csv")))
expected = [('DE', 35, 8302.62), ('ES', 48, 13614.97), ('FR', 35, 10101.26), ('IT', 17, 4451.31)]
check([r["country"] for r in rows] == [e[0] for e in expected], "one row per country, sorted")
for r, (c, n, a) in zip(rows, expected):
    check(int(r["orders"]) == n and abs(float(r["amount"]) - a) < 0.011, f"{c}: {n} orders, {a}")
check(int(pathlib.Path("/app/unmatched.txt").read_text().strip()) == 15, "the orders with an unknown customer")
