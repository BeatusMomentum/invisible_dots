#!/bin/bash
set -euo pipefail
cd /app
cat > summary.py <<'EOF'
import csv, sys, collections
rows = list(csv.reader(open(sys.argv[1])))[1:]
rows = [r for r in rows if r]
print(f"rows: {len(rows)}")
print(f"total: {sum(float(r[2]) for r in rows):.2f}")
s = collections.defaultdict(float)
for r in rows:
    s[r[1]] += float(r[2])
for c in sorted(s):
    print(f"{c}: {s[c]:.2f}")
EOF
