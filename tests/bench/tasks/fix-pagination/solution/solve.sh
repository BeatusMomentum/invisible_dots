#!/bin/bash
set -euo pipefail
cd /app
cat > paginate.py <<'EOF'
def paginate(items, page, per_page):
    """Return (the items of page `page`, starting at 1, the number of pages)."""
    if page < 1 or per_page < 1:
        raise ValueError("page and per_page start at 1")
    pages = -(-len(items) // per_page)
    start = (page - 1) * per_page
    return items[start:start + per_page], pages
EOF
