#!/usr/bin/env bash
# Runs as root inside the builder VM, from the IDOTS-BUILD payload disk.
# Installs everything the golden image carries (architecture section 3.3),
# then wipes the instance state so every Dot boots as a fresh cloud-init
# instance, and powers off. The last line on the serial console says how it
# went: build-golden.sh looks for "IDOTS-BUILD-RESULT: ok".
set -Eeuo pipefail

payload="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$payload/pins.env"

console() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >/dev/ttyS0 2>/dev/null || true
}
step() { console "idots-build: $*"; }
on_error() {
  console "IDOTS-BUILD-RESULT: failed at line $1: $2"
  systemctl --no-block poweroff
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

step "installing packages: $APT_PACKAGES"
# The cloud image may still be running its own apt jobs at first boot: wait for the lock.
apt_wait=(-o DPkg::Lock::Timeout=600)
apt-get "${apt_wait[@]}" update
# shellcheck disable=SC2086
apt-get "${apt_wait[@]}" install -y --no-install-recommends $APT_PACKAGES

step "installing Node $NODE_VERSION"
node_root=/usr/local/lib/nodejs
mkdir -p "$node_root"
tar -xJf "$payload/$NODE_TARBALL" -C "$node_root"
ln -sfn "$node_root/node-v$NODE_VERSION-linux-x64" "$node_root/current"
for bin in node npm npx corepack; do
  ln -sf "$node_root/current/bin/$bin" "/usr/local/bin/$bin"
done
[ "$(/usr/local/bin/node --version)" = "v$NODE_VERSION" ] || { console "node reports $(/usr/local/bin/node --version)"; false; }

step "installing uv $UV_VERSION"
uv_tmp="$(mktemp -d)"
tar -xzf "$payload/$UV_TARBALL" -C "$uv_tmp"
install -m 0755 "$uv_tmp"/uv-x86_64-unknown-linux-gnu/uv "$uv_tmp"/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/
rm -rf "$uv_tmp"
/usr/local/bin/uv --version

id dot >/dev/null 2>&1 || useradd --create-home --shell /bin/bash dot

step "installing invisible-playwright-mcp $MCP_VERSION and fetching the browser engine as dot"
# The engine is fetched with the invisible-playwright that lives inside the
# MCP server's own tool environment, so the cached engine is the one that
# server's seal expects. The cache lands in ~dot/.cache/invisible-playwright.
sudo -u dot -H env \
  PATH="/home/dot/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  MCP_VERSION="$MCP_VERSION" PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" \
  bash -euo pipefail -c '
    uv tool install --force "invisible-playwright-mcp==$MCP_VERSION" --with "invisible-playwright==$PLAYWRIGHT_VERSION"
    tool_bin="$(uv tool dir)/invisible-playwright-mcp/bin"
    [ -x "$tool_bin/invisible-playwright" ] || { echo "no invisible-playwright in $tool_bin" >&2; exit 1; }
    "$tool_bin/invisible-playwright" fetch
    "$tool_bin/invisible-playwright" version
    command -v invisible-playwright-mcp
  '

step "preparing the dot home"
install -d -o dot -g dot -m 0755 /home/dot/workspace /home/dot/downloads /home/dot/documents /home/dot/memory
install -d -o dot -g dot -m 0700 /home/dot/state /home/dot/browsers

step "enabling qemu-guest-agent"
systemctl enable qemu-guest-agent >/dev/null 2>&1 || true

step "cleaning up"
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
rm -f /etc/ssh/ssh_host_*
# --machine-id leaves /etc/machine-id "uninitialized", which is the
# truncation systemd expects: each Dot generates its own id on first boot.
cloud-init clean --logs --machine-id --seed
# Zeroed free blocks keep the converted qcow2 small.
fstrim -av || true
sync

trap - ERR
console "IDOTS-BUILD-RESULT: ok"
systemctl --no-block poweroff
