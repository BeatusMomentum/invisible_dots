#!/bin/bash
set -euo pipefail
cd /app
cat > daily.sh <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
python3 - <<'PY'
import gzip, glob, collections, statistics
days = collections.defaultdict(list)
for f in glob.glob("logs/app.log*"):
    op = gzip.open if f.endswith(".gz") else open
    for line in op(f, "rt"):
        if line.strip():
            p = line.split()
            days[p[0][:10]].append((p[1], int(line.rsplit("ms=", 1)[1])))
with open("daily.csv", "w") as out:
    out.write("day,lines,errors,p95_ms\n")
    for d in sorted(days):
        ms = [m for _, m in days[d]]
        p = statistics.quantiles(ms, n=100, method="inclusive")[94]
        out.write(f"{d},{len(ms)},{sum(l == 'ERROR' for l, _ in days[d])},{p:.1f}\n")
PY
EOF
chmod +x daily.sh && ./daily.sh
