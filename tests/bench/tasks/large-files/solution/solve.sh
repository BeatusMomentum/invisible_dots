#!/bin/bash
set -euo pipefail
cd /app
cd data && find . -type f -size +1048576c -printf '%s %P\n' | sort -rn > /app/large.txt
