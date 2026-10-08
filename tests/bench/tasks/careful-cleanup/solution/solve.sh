#!/bin/bash
set -euo pipefail
cd /app
cd project && find . -name '*.o' -type f -delete && rm -rf build && find . -name __pycache__ -type d -prune -exec rm -rf {} +
