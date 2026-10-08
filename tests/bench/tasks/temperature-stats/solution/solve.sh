#!/bin/bash
set -euo pipefail
cd /app
python3 - <<'EOF'
import csv, json, statistics
v = [float(r["celsius"]) for r in csv.DictReader(open("temps.csv")) if r["celsius"]]
json.dump({"median": round(statistics.median(v), 2), "stdev": round(statistics.pstdev(v), 2), "hot_days": sum(t > 25 for t in v)}, open("stats.json", "w"))
EOF
