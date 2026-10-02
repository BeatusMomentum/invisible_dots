#!/usr/bin/env bash
# Define, autostart and start the libvirt network "invisible-dots" from
# virtualization/libvirt/network.xml. Safe to run again: an existing network is
# left as it is (its definition is compared and a difference is reported).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
network_xml="${NETWORK_XML:-$here/../libvirt/network.xml}"
uri="${LIBVIRT_DEFAULT_URI:-qemu:///system}"
name="invisible-dots"

log() { printf 'ensure-network: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

command -v virsh >/dev/null 2>&1 || die "virsh not found: install libvirt-clients"
[ -r "$network_xml" ] || die "cannot read $network_xml"

if virsh -c "$uri" net-info "$name" >/dev/null 2>&1; then
  log "network $name already defined"
  # Only the subnet matters for routing; a hand-edited network is reported, never replaced.
  wanted_ip="$(grep -o "<ip address='[^']*'" "$network_xml" | head -n1)"
  if ! virsh -c "$uri" net-dumpxml "$name" | grep -q "$wanted_ip"; then
    log "warning: the defined network differs from $network_xml ($wanted_ip); not touching it"
  fi
else
  log "defining network $name from $network_xml"
  virsh -c "$uri" net-define "$network_xml" >/dev/null
fi

virsh -c "$uri" net-autostart "$name" >/dev/null
if virsh -c "$uri" net-info "$name" | grep -Eq '^Active:[[:space:]]+yes'; then
  log "network $name is active"
else
  log "starting network $name"
  virsh -c "$uri" net-start "$name" >/dev/null
fi
