#!/bin/bash
set -euo pipefail
cd /app
python3 - <<'EOF'
import csv
rows = list(csv.DictReader(open("shipment.csv")))
top = max(rows, key=lambda r: int(r["quantity"]) * float(r["unit_weight_lb"]))["sku"]
kg = sum(int(r["quantity"]) * float(r["unit_weight_lb"]) for r in rows) * 0.45359237
open("answer.txt", "w").write(f"{top}\n{kg:.1f}\n")
EOF
