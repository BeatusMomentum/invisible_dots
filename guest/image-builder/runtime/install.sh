#!/usr/bin/env bash
# The runtime ISO's install hook. cloud-init runs it as root on every boot
# (a per-boot script written by the seed), after the ISO is mounted at
# /opt/invisible-dots. It installs the guest units and starts them.
#
# The units are COPIED into /etc/systemd/system rather than linked: a linked
# unit lives on the ISO, which is not mounted yet when systemd loads units at
# early boot, so it would be "not found" on every boot after the first.
set -euo pipefail

runtime="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
units=(dot-desktop.service dot-agentd.service invisible-dots-agent.service)

log() { printf 'invisible-dots-runtime: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
id dot >/dev/null 2>&1 || die "user dot does not exist (is this a golden image?)"
id dotagentd >/dev/null 2>&1 || die "user dotagentd does not exist (a golden image from before dot-agentd had its own user): build a new golden image"
id dotengine >/dev/null 2>&1 || die "user dotengine does not exist (a golden image from before the engine had its own user)"
[ -x /opt/invisible-dots-engine/bin/python ] || die "the golden image has no engine environment (a golden image from before the nanobot engine): build a new golden image"
version="$(cat "$runtime/VERSION" 2>/dev/null || echo unknown)"
log "installing runtime $version from $runtime"

# The two sockets (architecture 4.2), each in a directory its server owns and
# only the other side may enter, setgid so the socket gets that side's group:
# /run/invisible-dots/agentd.sock, dot-agentd's (dotagentd), reached by the
# engine (group dotengine); /run/invisible-dots-agent/agent.sock, the engine's
# (dotengine), reached by dot-agentd (group dotagentd). dot, whose processes
# are the model's, is in neither group: it cannot enter either directory, so
# it cannot talk to the engine, and nothing of its can take the place of the
# socket the host pushes the key to.
# tmpfiles recreates both on every boot before the units start.
tmpfiles=/etc/tmpfiles.d/invisible-dots.conf
printf 'd /run/invisible-dots 2750 dotagentd dotengine -\nd /run/invisible-dots-agent 2750 dotengine dotagentd -\n' > "$tmpfiles.new"
mv -f "$tmpfiles.new" "$tmpfiles"
systemd-tmpfiles --create "$tmpfiles"

# The workspace is shared with the engine, which reads the Dot's memory notes
# and works in it: group dot, setgid, group-writable. The engine's own state
# (its database and its cron jobs) is closed to everyone else.
install -d -o dot -g dot -m 2775 /home/dot/workspace
install -d -o dot -g dot -m 0755 /home/dot/downloads /home/dot/documents /home/dot/memory
install -d -o dot -g dot -m 0700 /home/dot/browsers
# The home of each browser identity's MCP server (architecture 4.2), outside /home/dot on purpose: the server
# saves the proxy of its browser, password included, in a session file under its home, and the host's file
# routes read /home/dot and nothing else. dot owns it: the server runs as dot.
install -d -o root -g root -m 0755 /var/lib/invisible-dots
install -d -o dot -g dot -m 0700 /var/lib/invisible-dots/mcp
install -d -o dotengine -g dotengine -m 0700 /home/dotengine
install -d -o dotengine -g dotengine -m 0700 /home/dotengine/state

# A /run/user/<uid> for the desktop session without anyone logging in.
loginctl enable-linger dot || log "warning: could not enable lingering for dot; the desktop runs without XDG_RUNTIME_DIR"

changed=()
for unit in "${units[@]}"; do
  src="$runtime/units/$unit"
  dst="/etc/systemd/system/$unit"
  [ -f "$src" ] || die "the runtime ISO has no $unit"
  if ! cmp -s "$src" "$dst"; then
    install -m 0644 "$src" "$dst.new"
    mv -f "$dst.new" "$dst"
    changed+=("$unit")
  fi
done

systemctl daemon-reload
systemctl enable "${units[@]}" >/dev/null 2>&1
for unit in "${units[@]}"; do
  if [[ " ${changed[*]-} " == *" $unit "* ]] && systemctl is-active --quiet "$unit"; then
    log "restarting $unit (its unit file changed)"
    systemctl restart "$unit"
  else
    # A no-op for a unit that is already running.
    systemctl start "$unit"
  fi
done
log "runtime $version installed; units: ${units[*]}"
