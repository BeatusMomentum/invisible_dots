#!/bin/bash
set -euo pipefail
cd /app
sed -E 's/^\[[0-9:]+\] //' meeting.txt | awk -F': ' '{n[$1] += split($2, w, " ")} END {for (k in n) print n[k], k}' | sort -rn | head -1 | awk '{print $2}' > answer.txt
