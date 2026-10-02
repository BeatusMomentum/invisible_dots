#!/usr/bin/env bash
# Host installer of invisible_dots (architecture sections 3.1 and 3.2).
#
#   sudo deploy/install.sh [options]
#
#   --check               only check the host requirements and report what is missing
#   --prefix DIR          where the built tree is installed (default /usr/local/lib/invisible-dots)
#   --database-url URL    use this PostgreSQL instead of starting deploy/docker-compose.yml
#   --build-images        also build the golden image and the runtime ISO (needs KVM; the
#                         golden image takes a while and downloads the pinned Ubuntu image)
#   --no-start            install and enable the units without starting them
#   -h, --help            this help
#
# What it does, in order: checks every requirement and names what is missing;
# copies this checkout to the prefix and builds it there (npm ci, the bundles,
# the web client, the dot-agentd binary); creates the system user
# `invisible-dots`; creates /var/lib/invisible-dots and /etc/invisible-dots with
# master.key, api.token and server.env (existing secrets are kept); starts
# PostgreSQL with docker compose unless --database-url is given; defines the
# libvirt network; installs and starts the systemd units. Running it again
# upgrades the installed code and keeps every secret and every Dot.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

prefix="/usr/local/lib/invisible-dots"
database_url=""
check_only=0
build_images=0
start_units=1

state_dir="${INVISIBLE_DOTS_STATE_DIR:-/var/lib/invisible-dots}"
config_dir="${INVISIBLE_DOTS_CONFIG_DIR:-/etc/invisible-dots}"
service_user="invisible-dots"
units=(invisible-dots-server.service invisible-dots-web.service)

log() { printf 'install: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
usage() { sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=1; shift ;;
    --prefix) prefix="${2:?--prefix needs a directory}"; shift 2 ;;
    --database-url) database_url="${2:?--database-url needs a URL}"; shift 2 ;;
    --build-images) build_images=1; shift ;;
    --no-start) start_units=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument $1 (try --help)" ;;
  esac
done
case "$prefix" in /*) ;; *) die "--prefix must be an absolute path" ;; esac

# version_at_least HAVE WANT: dotted numeric comparison.
version_at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

missing=()
need_cmd() {
  local cmd="$1" hint="$2"
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd ($hint)")
}

check_requirements() {
  [ "$(uname -s)" = "Linux" ] || die "invisible_dots hosts run Linux (this is $(uname -s))"

  [ -e /dev/kvm ] || missing+=("/dev/kvm (enable virtualization in the firmware and load kvm_intel or kvm_amd; there is no fallback to emulation)")
  [ -e /dev/vhost-vsock ] || missing+=("/dev/vhost-vsock (modprobe vhost_vsock, and add it to /etc/modules-load.d)")

  need_cmd virsh "apt install libvirt-daemon-system libvirt-clients"
  need_cmd qemu-img "apt install qemu-utils"
  need_cmd qemu-system-x86_64 "apt install qemu-system-x86"
  need_cmd cloud-localds "apt install cloud-image-utils"
  need_cmd xorriso "apt install xorriso"
  need_cmd curl "apt install curl"
  need_cmd sha256sum "apt install coreutils"
  need_cmd tar "apt install tar"

  if command -v socat >/dev/null 2>&1; then
    local socat_version
    socat_version="$(socat -V 2>/dev/null | sed -n 's/^socat version \([0-9.]*\).*/\1/p' | head -n1)"
    if [ -z "$socat_version" ] || ! version_at_least "$socat_version" 1.7.4; then
      missing+=("socat 1.7.4 or newer for VSOCK-CONNECT (found ${socat_version:-an unknown version})")
    fi
  else
    missing+=("socat (apt install socat; 1.7.4 or newer)")
  fi

  if command -v node >/dev/null 2>&1; then
    local node_version
    node_version="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
    version_at_least "$node_version" 24.0.0 || missing+=("Node 24 or newer (found $node_version; https://nodejs.org)")
  else
    missing+=("node (Node 24 or newer; https://nodejs.org)")
  fi
  need_cmd npm "ships with Node"

  # Go builds dot-agentd for the runtime ISO; the host builds every guest image itself.
  if command -v go >/dev/null 2>&1; then
    local go_version
    go_version="$(go env GOVERSION 2>/dev/null | sed 's/^go//')"
    version_at_least "${go_version:-0}" 1.25 || missing+=("Go 1.25 or newer (found ${go_version:-unknown}; https://go.dev/dl)")
  else
    missing+=("go (Go 1.25 or newer, to build dot-agentd; https://go.dev/dl)")
  fi

  if [ -z "$database_url" ]; then
    if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
      missing+=("docker with the compose plugin, to run deploy/docker-compose.yml (or pass --database-url for a PostgreSQL 16+ of your own)")
    fi
  fi

  if command -v virsh >/dev/null 2>&1 && ! virsh -c qemu:///system uri >/dev/null 2>&1; then
    missing+=("a running libvirt daemon on qemu:///system (systemctl enable --now libvirtd)")
  fi
}

check_requirements
if [ "${#missing[@]}" -gt 0 ]; then
  log "missing requirements:"
  for item in "${missing[@]}"; do log "  - $item"; done
  exit 1
fi
log "every requirement is present"
[ "$check_only" -eq 1 ] && exit 0
[ "$(id -u)" -eq 0 ] || die "run as root (sudo) to install; --check works as any user"

# 1. The built tree. Extracted to a staging directory and swapped in, so a
# failed build never leaves a half-replaced installation behind.
staging="$prefix.new"
rm -rf "$staging"
mkdir -p "$staging"
log "copying $repo to $staging"
tar -C "$repo" \
  --exclude=./.git --exclude=node_modules --exclude=.next --exclude=dist \
  --exclude=./guest/dot-agentd/bin --exclude=coverage \
  -cf - . | tar -C "$staging" -xf -

log "installing dependencies and building (npm ci, bundles, web client)"
(
  cd "$staging"
  npm ci --no-audit --no-fund
  npm run build --workspace @invisible-dots/api
  npm run build --workspace @invisible-dots/cli
  npm run build --workspace @invisible-dots/invisible-dots-agent
  NEXT_TELEMETRY_DISABLED=1 npm run build --workspace @invisible-dots/web
)
log "building dot-agentd (linux/amd64, static)"
(
  cd "$staging/guest/dot-agentd"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/dot-agentd ./cmd/dot-agentd
)
if [ -d "$prefix" ]; then
  rm -rf "$prefix.old"
  mv "$prefix" "$prefix.old"
fi
mv "$staging" "$prefix"
rm -rf "$prefix.old"
chmod 0755 "$prefix/apps/api/dist/invisible-dots-server.mjs" "$prefix/apps/cli/dist/invisible-dots.mjs"
ln -sfn "$prefix/apps/cli/dist/invisible-dots.mjs" /usr/local/bin/invisible-dots
log "installed to $prefix; the CLI is /usr/local/bin/invisible-dots"

# 2. The service user. libvirt and kvm let it drive qemu:///system.
if ! id "$service_user" >/dev/null 2>&1; then
  useradd --system --home-dir "$state_dir" --no-create-home --shell /usr/sbin/nologin "$service_user"
  log "created system user $service_user"
fi
for group in libvirt kvm; do
  if getent group "$group" >/dev/null 2>&1; then usermod -aG "$group" "$service_user"; fi
done

# 3. Host filesystem (architecture 3.2). The VM directories must stay
# traversable: libvirt opens the disks, the seed and the serial log in them.
install -d -o "$service_user" -g "$service_user" -m 0755 "$state_dir" "$state_dir/images" "$state_dir/vms"
install -d -o "$service_user" -g "$service_user" -m 0750 "$state_dir/snapshots" "$state_dir/artifacts" "$state_dir/backups"
install -d -o root -g "$service_user" -m 0750 "$config_dir"

# new_secret FILE COMMAND: create FILE (0600, owned by the service user) from
# COMMAND's output, unless it already exists. Secrets are never rotated here:
# a new master.key would make every stored secret unreadable.
new_secret() {
  local file="$1"; shift
  if [ -s "$file" ]; then
    log "keeping existing $file"
  else
    (umask 077; "$@" > "$file.tmp")
    mv -f "$file.tmp" "$file"
    log "created $file"
  fi
  chown "$service_user:$service_user" "$file"
  chmod 0600 "$file"
}
new_secret "$config_dir/master.key" head -c 32 /dev/urandom
new_secret "$config_dir/api.token" sh -c 'od -An -tx1 -N32 /dev/urandom | tr -d " \n"; echo'

# 4. PostgreSQL.
if [ -z "$database_url" ]; then
  new_secret "$config_dir/postgres.env" sh -c 'printf "POSTGRES_PASSWORD=%s\n" "$(od -An -tx1 -N24 /dev/urandom | tr -d " \n")"'
  chown root:root "$config_dir/postgres.env"
  password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$config_dir/postgres.env")"
  log "starting PostgreSQL with docker compose"
  docker compose --env-file "$config_dir/postgres.env" -f "$prefix/deploy/docker-compose.yml" up -d --wait
  database_url="postgres://invisible_dots:${password}@127.0.0.1:5432/invisible_dots"
fi

# 5. server.env, the systemd EnvironmentFile. Rewritten only when missing or
# when --database-url names a different database.
server_env="$config_dir/server.env"
if [ ! -s "$server_env" ] || ! grep -qxF "DATABASE_URL=$database_url" "$server_env"; then
  [ -s "$server_env" ] && cp -p "$server_env" "$server_env.bak" && log "previous server.env saved as $server_env.bak"
  (
    umask 077
    {
      echo "# invisible-dots-server settings (architecture 3.2). The API token and the"
      echo "# master key are files next to this one: api.token and master.key."
      echo "DATABASE_URL=$database_url"
      echo "INVISIBLE_DOTS_STATE_DIR=$state_dir"
      echo "INVISIBLE_DOTS_CONFIG_DIR=$config_dir"
      echo "INVISIBLE_DOTS_RUN_DIR=/run/invisible-dots"
      echo "INVISIBLE_DOTS_LISTEN=127.0.0.1:8787"
    } > "$server_env.tmp"
  )
  mv -f "$server_env.tmp" "$server_env"
  log "wrote $server_env"
fi
chown "$service_user:$service_user" "$server_env"
chmod 0600 "$server_env"

# 6. The NAT network every Dot's NIC joins.
LIBVIRT_DEFAULT_URI=qemu:///system bash "$prefix/virtualization/networking/ensure-network.sh"

# 7. Images. Both are built from public sources on this host and never downloaded prebuilt.
if [ "$build_images" -eq 1 ]; then
  INVISIBLE_DOTS_STATE_DIR="$state_dir" bash "$prefix/guest/image-builder/build-golden.sh"
  INVISIBLE_DOTS_STATE_DIR="$state_dir" bash "$prefix/guest/image-builder/build-runtime.sh"
fi
shopt -s nullglob
goldens=("$state_dir"/images/golden-*.qcow2)
runtimes=("$state_dir"/images/runtime-*.iso)
shopt -u nullglob
if [ "${#goldens[@]}" -eq 0 ] || [ "${#runtimes[@]}" -eq 0 ]; then
  log "note: no golden image or runtime ISO in $state_dir/images yet; Dots cannot start until both exist."
  log "      build them with: sudo $prefix/deploy/install.sh --build-images"
fi

# 8. systemd units, pointed at the prefix.
for unit in "${units[@]}"; do
  sed "s#/usr/local/lib/invisible-dots#$prefix#g" "$prefix/deploy/systemd/$unit" > "/etc/systemd/system/$unit.tmp"
  mv -f "/etc/systemd/system/$unit.tmp" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable "${units[@]}" >/dev/null 2>&1
if [ "$start_units" -eq 1 ]; then
  systemctl restart "${units[@]}"
  log "started ${units[*]}"
  log "API: http://127.0.0.1:8787 (token in $config_dir/api.token), web client: http://127.0.0.1:3000"
else
  log "units installed and enabled, not started (--no-start)"
fi
log "next: store the OpenRouter key, read from stdin: sudo invisible-dots secret openrouter"
