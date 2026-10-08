#!/bin/bash
set -euo pipefail
cd /app
cat > wordfreq <<'EOF'
#!/usr/bin/env python3
import argparse, collections, re
p = argparse.ArgumentParser()
p.add_argument("file")
p.add_argument("-n", type=int, default=10)
a = p.parse_args()
words = re.findall(r"[a-z]+", open(a.file, encoding="utf-8").read().lower())
for w, c in sorted(collections.Counter(words).items(), key=lambda x: (-x[1], x[0]))[:a.n]:
    print(w, c)
EOF
chmod +x wordfreq
