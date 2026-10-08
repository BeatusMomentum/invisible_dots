#!/bin/bash
set -euo pipefail
cd /app
python3 - <<'EOF'
import json, glob, collections
t = collections.defaultdict(float)
for f in glob.glob("invoices/*.json"):
    inv = json.load(open(f))
    t[inv["client"]] += sum(i["quantity"] * i["unit_price"] for i in inv["items"])
rows = sorted(t.items(), key=lambda r: -r[1])
with open("report.md", "w") as out:
    out.write("| Client | Total |\n|---|---|\n")
    for c, v in rows:
        out.write(f"| {c} | {v:.2f} |\n")
    out.write(f"| TOTAL | {sum(t.values()):.2f} |\n")
EOF
