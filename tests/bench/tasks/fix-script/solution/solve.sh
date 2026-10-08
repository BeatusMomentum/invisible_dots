#!/bin/bash
set -euo pipefail
cd /app
cat > backup.sh <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
count=0
while IFS= read -r -d '' f; do
  rel=${f#notes/}
  mkdir -p "backup/$(dirname "$rel")"
  cp "$f" "backup/$rel"
  count=$((count + 1))
done < <(find notes -name '*.txt' -print0)
echo "backed up $count files"
EOF
chmod +x backup.sh
