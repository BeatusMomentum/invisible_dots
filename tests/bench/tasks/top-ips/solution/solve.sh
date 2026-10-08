#!/bin/bash
set -euo pipefail
cd /app
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -3 | awk '{print $2" "$1}' > top_ips.txt
