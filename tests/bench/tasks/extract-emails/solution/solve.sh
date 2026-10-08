#!/bin/bash
set -euo pipefail
cd /app
grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' inbox | tr 'A-Z' 'a-z' | sed 's/\.$//' | sort -u > emails.txt
