#!/bin/bash
set -euo pipefail
cd /app
python3 -c "import json; print(sum(r['vegetarian'] and r['minutes'] < 30 for r in json.load(open('recipes.json'))))" > answer.txt
