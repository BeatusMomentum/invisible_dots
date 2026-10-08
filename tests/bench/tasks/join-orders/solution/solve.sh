#!/bin/bash
set -euo pipefail
cd /app
python3 - <<'EOF'
import csv, collections
cust = {r["customer_id"]: r["country"] for r in csv.DictReader(open("customers.csv"))}
agg = collections.defaultdict(lambda: [0, 0.0]); un = 0
for r in csv.DictReader(open("orders.csv")):
    c = cust.get(r["customer_id"])
    if c is None: un += 1; continue
    agg[c][0] += 1; agg[c][1] += float(r["amount"])
with open("by_country.csv", "w") as f:
    f.write("country,orders,amount\n")
    for c in sorted(agg): f.write(f"{c},{agg[c][0]},{agg[c][1]:.2f}\n")
open("unmatched.txt", "w").write(f"{un}\n")
EOF
