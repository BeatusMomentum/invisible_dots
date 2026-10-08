#!/bin/bash
set -euo pipefail
cd /app
cd Downloads
for f in *; do
  [ -f "$f" ] || continue
  case "${f##*.}" in
    pdf|docx|txt) d=documents ;; jpg|png) d=images ;; mp3) d=audio ;; zip) d=archives ;; *) d=other ;;
  esac
  [ "$f" = "${f##*.}" ] && d=other
  mkdir -p "$d" && mv "$f" "$d/"
done
