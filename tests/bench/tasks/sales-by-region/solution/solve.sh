#!/bin/bash
set -euo pipefail
cd /app
python3 - <<'EOF'
import csv, collections
t = collections.defaultdict(float)
for r in csv.DictReader(open("sales.csv")):
    t[r["region"]] += int(r["quantity"]) * float(r["unit_price"])
k = max(t, key=t.get)
open("answer.txt", "w").write(f"{k} {t[k]:.2f}\n")
EOF
