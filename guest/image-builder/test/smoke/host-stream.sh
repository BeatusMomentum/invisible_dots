#!/usr/bin/env bash
# The fake host's event reader: what the control plane does (architecture 5.3
# and 4.3). It reads /v1/agent/events/stream after the last seq it saved,
# reconnects with ?after= when the stream drops (a crash, a restart), and on
# every agent.started pushes the key and the config again.
#   host-stream.sh <token> <output file> <push command>
token=$1 out=$2 push=$3
: > "$out"
last=0
while true; do
  curl -sS -N -H "Authorization: Bearer $token" "http://127.0.0.1:1024/v1/agent/events/stream?after=$last" 2>/dev/null |
    while IFS= read -r line; do
      case "$line" in
        "id: "*) echo "$line" >> "$out" ;;
        "data: "*)
          echo "$line" >> "$out"
          echo >> "$out"
          if [[ "$line" == *'"type":"agent.started"'* ]]; then bash -c "$push" >/dev/null 2>&1 & fi
          ;;
      esac
    done
  saved=$(grep '^id: ' "$out" | tail -1 | sed 's/^id: //')
  last=${saved:-0}
  sleep 1
done
