#!/bin/bash
set -euo pipefail
cd /app
git config --global user.name 'Dot Bench'
git config --global user.email dot@bench.example
git config --global init.defaultBranch main
git config --global alias.last 'log -1 HEAD'
