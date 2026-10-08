#!/bin/bash
set -euo pipefail
cd /app
cd project
git rev-parse HEAD~1 > /app/bad_commit.txt
sed -i 's/return a + b - 1/return a + b/' calc.py
git -c user.email=dot@example.com -c user.name=Dot commit -qam 'fix add'
