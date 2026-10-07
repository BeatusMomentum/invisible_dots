#!/usr/bin/env bash
# ExecStart of dot-desktop.service: Xvfb on $DISPLAY, then an XFCE session on
# it. Exits non-zero as soon as either one exits, so systemd restarts both.
set -euo pipefail

display="${DISPLAY:-:0}"
screen="${DOT_SCREEN:-1920x1080x24}"
number="${display#:}"
socket="/tmp/.X11-unix/X$number"

log() { printf 'dot-desktop: %s\n' "$*" >&2; }

# A system service has no login session; lingering (set by install.sh) gives
# dot a /run/user/<uid>, which XFCE and D-Bus expect.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

Xvfb "$display" -nolisten tcp -screen 0 "$screen" &
xvfb_pid=$!
session_pid=""
cleanup() {
  [ -n "$session_pid" ] && kill "$session_pid" 2>/dev/null || true
  kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  [ -S "$socket" ] && break
  kill -0 "$xvfb_pid" 2>/dev/null || { log "Xvfb exited before $display was ready"; exit 1; }
  sleep 0.1
done
[ -S "$socket" ] || { log "Xvfb did not create $socket within 10 s"; exit 1; }
log "Xvfb ready on $display ($screen)"

dbus-launch --exit-with-session xfce4-session &
session_pid=$!

set +e
wait -n "$xvfb_pid" "$session_pid"
status=$?
set -e
log "a desktop process exited with status $status; stopping"
exit 1
