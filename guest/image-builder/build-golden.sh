#!/usr/bin/env bash
# Build golden-<version>.qcow2 (architecture section 3.3) from the pinned
# Ubuntu 24.04 cloud image, with plain qemu-system-x86_64 and KVM: no libvirt.
#
#   build-golden.sh [--out-dir DIR] [--version V] [--work-dir DIR]
#                   [--disk-size SIZE] [--memory MIB] [--cpus N] [--timeout SECONDS]
#
# Every option also has an environment variable (GOLDEN_OUT_DIR, GOLDEN_VERSION,
# GOLDEN_WORK_DIR, GOLDEN_DISK_SIZE, GOLDEN_MEMORY_MIB, GOLDEN_CPUS,
# GOLDEN_TIMEOUT). The default version is derived from every pinned input, so
# running the script again with the same pins finds the image already built
# and exits; a golden image is never rewritten once it exists.
set -euo pipefail

SCRIPT_NAME="build-golden"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

out_dir="${GOLDEN_OUT_DIR:-${INVISIBLE_DOTS_STATE_DIR:-/var/lib/invisible-dots}/images}"
version="${GOLDEN_VERSION:-}"
work_dir="${GOLDEN_WORK_DIR:-}"
disk_size="${GOLDEN_DISK_SIZE:-10G}"
memory_mib="${GOLDEN_MEMORY_MIB:-4096}"
cpus="${GOLDEN_CPUS:-2}"
timeout_s="${GOLDEN_TIMEOUT:-3600}"
base_json="${BASE_IMAGE_JSON:-$repo/virtualization/images/base.json}"
pins_json="$here/pins.json"

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --work-dir) work_dir="$2"; shift 2 ;;
    --disk-size) disk_size="$2"; shift 2 ;;
    --memory) memory_mib="$2"; shift 2 ;;
    --cpus) cpus="$2"; shift 2 ;;
    --timeout) timeout_s="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument $1 (try --help)" ;;
  esac
done

need node curl sha256sum qemu-img qemu-system-x86_64 xorriso timeout awk
[ -r "$base_json" ] || die "cannot read $base_json"
[ -e /dev/kvm ] || die "/dev/kvm is missing: the golden image is built with KVM and there is no fallback to emulation"
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm is not accessible to $(id -un): add the user to the kvm group"

# The version names every input, so a change to any pin or to the builder makes a new image.
inputs_digest="$(cat "$base_json" "$pins_json" "$here/builder/user-data.yaml" "$here/builder/provision.sh" | sha256sum | cut -c1-12)"
mkdir -p "$out_dir"
if [ -z "$version" ]; then
  # The control plane gives new Dots the golden image with the highest version,
  # so the default version starts with the UTC build time and sorts by age. The
  # digest suffix is what makes a rerun with unchanged inputs a no-op.
  for existing in "$out_dir"/golden-*-"$inputs_digest".qcow2; do
    if [ -f "$existing" ] && [ -f "${existing%.qcow2}.json" ]; then
      log "$existing already exists for these inputs; nothing to do"
      printf '%s\n' "$existing"
      exit 0
    fi
  done
  version="$(date -u +%Y%m%d%H%M%S)-$inputs_digest"
fi
[[ "$version" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid version \"$version\": use letters, digits, '.', '_' and '-'"

golden="$out_dir/golden-$version.qcow2"
manifest="$out_dir/golden-$version.json"
if [ -f "$golden" ] && [ -f "$manifest" ]; then
  log "$golden already exists; nothing to do"
  printf '%s\n' "$golden"
  exit 0
fi
[ -e "$golden" ] && die "$golden exists without its manifest: a previous build was interrupted after the rename; inspect and remove it by hand"
lock_or_die "$out_dir/.build-golden.lock"

if [ -z "$work_dir" ]; then
  work_dir="$(mktemp -d "${TMPDIR:-/var/tmp}/idots-golden.XXXXXX")"
  # Kept after a failure: the console log in it is the only account of what went wrong.
  trap 'status=$?; if [ "$status" -eq 0 ]; then rm -rf "$work_dir"; else log "keeping $work_dir for inspection"; fi' EXIT
fi
mkdir -p "$work_dir"
log "building golden image $version in $work_dir"

base_image="$out_dir/$(json_get "$base_json" 'j.local_name')"
base_url="$(json_get "$base_json" 'j.url')"
base_sha="$(json_get "$base_json" 'j.sha256')"
base_sums_url="$(json_get "$base_json" 'j.sha256sums_url')"
base_entry="$(json_get "$base_json" 'j.sha256sums_entry')"

if [ ! -f "$base_image" ] && command -v gpgv >/dev/null 2>&1 && [ -r /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg ]; then
  sums="$work_dir/SHA256SUMS"
  curl -fsSL --retry 3 -o "$sums" "$base_sums_url" || die "cannot fetch $base_sums_url"
  curl -fsSL --retry 3 -o "$sums.gpg" "$(json_get "$base_json" 'j.sha256sums_signature_url')" || die "cannot fetch the SHA256SUMS signature"
  gpgv --keyring /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg "$sums.gpg" "$sums" 2>/dev/null \
    || die "SHA256SUMS signature does not verify against the Ubuntu cloud image keyring"
  log "SHA256SUMS signature verified"
elif [ ! -f "$base_image" ]; then
  log "gpgv or ubuntu-cloudimage-keyring not installed: relying on the pinned SHA-256 alone"
fi
fetch_verified "$base_url" "$base_image" "$base_sha" "$base_sums_url" "$base_entry"

payload="$work_dir/payload"
cache="$out_dir/.cache"
mkdir -p "$payload" "$cache"
for tool in node uv; do
  url="$(json_get "$pins_json" "j.$tool.url")"
  fetch_verified "$url" "$cache/$(basename "$url")" \
    "$(json_get "$pins_json" "j.$tool.sha256")" \
    "$(json_get "$pins_json" "j.$tool.shasums_url")" \
    "$(json_get "$pins_json" "j.$tool.shasums_entry")"
  cp "$cache/$(basename "$url")" "$payload/"
done
node_url="$(json_get "$pins_json" 'j.node.url')"
uv_url="$(json_get "$pins_json" 'j.uv.url')"
cp "$here/builder/provision.sh" "$payload/provision.sh"
chmod 0755 "$payload/provision.sh"
{
  printf 'NODE_VERSION=%q\n' "$(json_get "$pins_json" 'j.node.version')"
  printf 'NODE_TARBALL=%q\n' "$(basename "$node_url")"
  printf 'UV_VERSION=%q\n' "$(json_get "$pins_json" 'j.uv.version')"
  printf 'UV_TARBALL=%q\n' "$(basename "$uv_url")"
  printf 'MCP_VERSION=%q\n' "$(json_get "$pins_json" 'j.python_packages["invisible-playwright-mcp"]')"
  printf 'PLAYWRIGHT_VERSION=%q\n' "$(json_get "$pins_json" 'j.python_packages["invisible-playwright"]')"
  printf 'APT_PACKAGES=%q\n' "$(json_get "$pins_json" 'j.apt_packages')"
} > "$payload/pins.env"
make_iso IDOTS-BUILD "$work_dir/payload.iso" "$payload"

seed_dir="$work_dir/seed"
mkdir -p "$seed_dir"
cp "$here/builder/user-data.yaml" "$seed_dir/user-data"
printf 'instance-id: idots-golden-%s\nlocal-hostname: idots-golden-builder\n' "$version" > "$seed_dir/meta-data"
if command -v cloud-localds >/dev/null 2>&1; then
  cloud-localds "$work_dir/seed.iso" "$seed_dir/user-data" "$seed_dir/meta-data"
else
  make_iso cidata "$work_dir/seed.iso" "$seed_dir"
fi

disk="$work_dir/disk.qcow2"
log "converting the base image and growing it to $disk_size"
qemu-img convert -O qcow2 "$base_image" "$disk"
qemu-img resize -q "$disk" "$disk_size"

serial_log="$work_dir/serial.log"
log "booting the builder VM (KVM, ${cpus} vCPU, ${memory_mib} MiB, timeout ${timeout_s}s); console in $serial_log"
set +e
timeout --foreground "$timeout_s" qemu-system-x86_64 \
  -enable-kvm -machine q35 -cpu host -smp "$cpus" -m "$memory_mib" \
  -display none -monitor none -no-reboot \
  -serial "file:$serial_log" \
  -drive "file=$disk,if=virtio,format=qcow2,discard=unmap" \
  -drive "file=$work_dir/seed.iso,media=cdrom,format=raw,readonly=on" \
  -drive "file=$work_dir/payload.iso,media=cdrom,format=raw,readonly=on" \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -device virtio-rng-pci
status=$?
set -e
if [ "$status" -eq 124 ]; then
  tail -n 40 "$serial_log" >&2 || true
  die "the builder VM did not power off within ${timeout_s}s (last console lines above)"
fi
[ "$status" -eq 0 ] || die "qemu-system-x86_64 exited with status $status"
if ! grep -aq 'IDOTS-BUILD-RESULT: ok' "$serial_log"; then
  grep -a 'IDOTS-BUILD-RESULT' "$serial_log" >&2 || tail -n 40 "$serial_log" >&2 || true
  die "provisioning failed inside the builder VM; full console log: $serial_log"
fi
log "provisioning finished"

log "writing $golden"
qemu-img convert -O qcow2 "$disk" "$golden.part"
sha="$(sha256_of "$golden.part")"
size="$(stat -c %s "$golden.part")"
M_VERSION="$version" M_FILE="$(basename "$golden")" M_SHA="$sha" M_SIZE="$size" M_DISK_SIZE="$disk_size" \
  M_DIGEST="$inputs_digest" M_BASE="$base_json" M_PINS="$pins_json" \
  node - "$manifest.part" <<'EOF'
const file = process.argv[process.argv.length - 1];
const env = process.env;
const manifest = {
  version: env.M_VERSION,
  built_at: new Date().toISOString(),
  file: env.M_FILE,
  sha256: env.M_SHA,
  size_bytes: Number(env.M_SIZE),
  virtual_size: env.M_DISK_SIZE,
  inputs_digest: env.M_DIGEST,
  base: JSON.parse(require("fs").readFileSync(env.M_BASE, "utf8")),
  pins: JSON.parse(require("fs").readFileSync(env.M_PINS, "utf8")),
};
require("fs").writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
EOF
mv -f "$golden.part" "$golden"
chmod 0444 "$golden"
mv -f "$manifest.part" "$manifest"
log "done: $golden ($sha)"
printf '%s\n' "$golden"
