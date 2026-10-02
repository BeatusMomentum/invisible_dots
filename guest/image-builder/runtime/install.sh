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
version="$(cat "$runtime/VERSION" 2>/dev/null || echo unknown)"
log "installing runtime $version from $runtime"

# /run/invisible-dots holds agentd.sock and agent.sock (architecture 4.2);
# tmpfiles recreates it on every boot before the units start.
tmpfiles=/etc/tmpfiles.d/invisible-dots.conf
printf 'd /run/invisible-dots 0755 dot dot -\n' > "$tmpfiles.new"
mv -f "$tmpfiles.new" "$tmpfiles"
systemd-tmpfiles --create "$tmpfiles"

install -d -o dot -g dot -m 0755 /home/dot/workspace /home/dot/downloads /home/dot/documents /home/dot/memory
install -d -o dot -g dot -m 0700 /home/dot/state /home/dot/browsers

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
