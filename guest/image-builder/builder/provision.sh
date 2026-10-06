#!/usr/bin/env bash
# Runs as root inside the builder VM, from the builder's seed disk (label
# cidata), which also carries pins.env and the Node and uv tarballs. Installs
# everything the golden image carries (architecture section 3.3), then wipes
# the instance state so every Dot boots as a fresh cloud-init instance, and
# powers off.
#
# The serial console is the host's only view of the build. Three kinds of
# lines go there and nowhere else, so each appears once:
#   idots-build: <step>                  progress, shown by `invisible-dots image build`
#   IDOTS-BUILD-COMPONENT: <name>=<v>    what was actually installed, copied into the manifest
#   IDOTS-BUILD-RESULT: ok | failed ...  the verdict the host waits for
set -Eeuo pipefail

payload="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$payload/pins.env"

console() {
  printf '%s\n' "$*" >/dev/ttyS0 2>/dev/null || printf '%s\n' "$*"
}
step() { console "idots-build: $*"; }
component() { console "IDOTS-BUILD-COMPONENT: $1=$2"; }
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

step "installing invisible-playwright-mcp $MCP_VERSION, fetching the browser engine and the GeoIP database as dot"
# The whole environment comes from the hashed lock on the seed and is built as dot by the script the
# seed carries, the one the browser smoke runs too (section 3.3): every package at the version the
# lock names and with a file whose SHA-256 it lists, nothing resolved from the index. The engine is
# fetched with the invisible-playwright of that environment, so the cached engine is the one the
# server's seal expects, and the GeoIP database that a launch with the timezone left to "auto" needs
# is fetched beside it, so a Dot's first launch downloads nothing. Both land in
# ~dot/.cache/invisible-playwright.
as_dot() { sudo -u dot -H env PATH="/home/dot/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }
mcp_env=/home/dot/.local/share/invisible-dots/mcp
bash "$payload/$BROWSER_BUILD" "$payload/$PYTHON_LOCK" "$mcp_env"
# `version` prints the wrapper on its first line and the engine on the line
# that starts with "engine" (tag, Firefox version, BuildID); the engine line
# is the one that says which browser the image carries.
engine_version="$(as_dot "$mcp_env/bin/invisible-playwright" version | sed -n 's/^engine[[:space:]]*//p')"
[ -n "$engine_version" ] || { console "invisible-playwright version printed no engine line"; false; }
# The GeoIP database is named by its release tag (a date), the directory it was cached in.
geoip_database="$(as_dot "$mcp_env/bin/python" -c 'from invisible_core.download import geoip_mmdb_path; print(geoip_mmdb_path().parent.name)')"
[ -n "$geoip_database" ] || { console "no GeoIP database in the cache of invisible-playwright"; false; }

step "installing the engine's Python environment"
# The engine's third-party dependencies come from the hashed lock on the seed,
# wheels only, so no build script of any of them runs as root. The engine's own
# source is not here: it comes on the runtime disk and joins this environment
# through the .pth file the script writes (section 3.3).
engine_venv=/opt/invisible-dots-engine
bash "$payload/$ENGINE_BUILD" "$payload/$ENGINE_LOCK" "$engine_venv" /opt/invisible-dots/engine
engine_python="$("$engine_venv/bin/python" -V)"

step "preparing the dot home"
# The workspace is shared with the engine (user dotengine, in group dot).
install -d -o dot -g dot -m 2775 /home/dot/workspace
install -d -o dot -g dot -m 0755 /home/dot/downloads /home/dot/documents /home/dot/memory
install -d -o dotengine -g dotengine -m 0700 /home/dotengine
install -d -o dot -g dot -m 0700 /home/dot/browsers

step "recording installed versions"
# shellcheck source=/dev/null
. /etc/os-release
component ubuntu "$VERSION_ID"
component kernel "$(uname -r)"
component node "$(/usr/local/bin/node --version)"
component uv "$(/usr/local/bin/uv --version)"
component invisible-playwright-mcp "$MCP_VERSION"
component invisible-playwright "$PLAYWRIGHT_VERSION"
component browser-engine "$engine_version"
component geoip-database "$geoip_database"
component engine-python "$engine_python"

step "cleaning up"
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
rm -f /etc/ssh/ssh_host_*
# The builder seed grants dot nothing, but the cloud image's own defaults
# may have written sudo rules: a Dot's seed appends its single poweroff rule
# to this file, so whatever is left here would still apply in every Dot.
rm -f /etc/sudoers.d/90-cloud-init-users
# --machine-id leaves /etc/machine-id "uninitialized", which is the
# truncation systemd expects: each Dot generates its own id on first boot.
cloud-init clean --logs --machine-id --seed
# Zeroed free blocks keep the converted qcow2 small.
fstrim -av || true
sync

trap - ERR
console "IDOTS-BUILD-RESULT: ok"
systemctl --no-block poweroff
