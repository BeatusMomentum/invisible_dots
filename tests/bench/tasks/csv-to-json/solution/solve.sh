#!/bin/bash
set -euo pipefail
cd /app
python3 - <<'EOF'
import csv, json
rows = [dict(r, id=int(r["id"]), age=int(r["age"]), member=r["member"] == "yes") for r in csv.DictReader(open("people.csv"))]
json.dump(rows, open("people.json", "w"), indent=2)
EOF
