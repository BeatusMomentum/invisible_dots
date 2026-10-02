#!/usr/bin/env bash
# Starts virtlogd and libvirtd inside the development container, defines the
# invisible-dots network when the repository is mounted at /src, then runs the
# command (default: sleep forever, so `docker exec` can be used).
set -euo pipefail

log() { printf 'idots-dev: %s\n' "$*" >&2; }

[ -e /dev/kvm ] || log "warning: /dev/kvm is missing; pass --device /dev/kvm (there is no fallback to emulation)"
[ -e /dev/vhost-vsock ] || log "warning: /dev/vhost-vsock is missing; run 'modprobe vhost_vsock' on the host and pass --device /dev/vhost-vsock"

mkdir -p /run/libvirt /var/lib/invisible-dots/images /var/lib/invisible-dots/vms /run/invisible-dots
virtlogd --daemon
libvirtd --daemon

for _ in $(seq 1 50); do
  virsh -c qemu:///system uri >/dev/null 2>&1 && break
  sleep 0.2
done
virsh -c qemu:///system uri >/dev/null 2>&1 || { log "libvirtd did not come up"; exit 1; }
log "libvirtd is running"

if [ -x /src/virtualization/networking/ensure-network.sh ] || [ -f /src/virtualization/networking/ensure-network.sh ]; then
  bash /src/virtualization/networking/ensure-network.sh
else
  log "the repository is not mounted at /src; define the network with virtualization/networking/ensure-network.sh"
fi

exec "$@"
