#!/usr/bin/env bash
# Build runtime-<version>.iso (architecture section 3.3), volume label IDOTS-RT,
# mounted read-only at /opt/invisible-dots in every Dot:
#
#   /install.sh                    the hook the seed runs on every boot
#   /VERSION                       this runtime's version
#   /invisible-dots-agent.mjs      the bundled agent
#   /bin/dot-agentd                the computer daemon (linux/amd64)
#   /bin/dot-desktop               ExecStart of dot-desktop.service
#   /units/*.service               the guest systemd units
#
#   build-runtime.sh [--out-dir DIR] [--version V] [--agent FILE] [--agentd FILE]
#
# Environment: RUNTIME_OUT_DIR, RUNTIME_VERSION, AGENT_BUNDLE, DOT_AGENTD_BIN.
# The default version is a digest of the ISO's contents, so building the same
# code twice finds the ISO already there and exits.
set -euo pipefail

SCRIPT_NAME="build-runtime"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

out_dir="${RUNTIME_OUT_DIR:-${INVISIBLE_DOTS_STATE_DIR:-/var/lib/invisible-dots}/images}"
version="${RUNTIME_VERSION:-}"
agent="${AGENT_BUNDLE:-$repo/guest/invisible-dots-agent/dist/invisible-dots-agent.mjs}"
agentd="${DOT_AGENTD_BIN:-$repo/guest/dot-agentd/bin/dot-agentd}"

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --agent) agent="$2"; shift 2 ;;
    --agentd) agentd="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument $1 (try --help)" ;;
  esac
done

need xorriso sha256sum find sort
[ -f "$agent" ] || die "agent bundle $agent not found: build it first (npm run build --workspace guest/invisible-dots-agent)"
[ -f "$agentd" ] || die "dot-agentd binary $agentd not found: build it first (cd guest/dot-agentd && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/dot-agentd ./cmd/dot-agentd)"
if command -v file >/dev/null 2>&1; then
  file -b "$agentd" | grep -q 'ELF 64-bit.*x86-64' || die "$agentd is not a linux/amd64 executable ($(file -b "$agentd"))"
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/idots-runtime.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/units"
install -m 0644 "$agent" "$stage/invisible-dots-agent.mjs"
install -m 0755 "$agentd" "$stage/bin/dot-agentd"
install -m 0755 "$here/runtime/dot-desktop.sh" "$stage/bin/dot-desktop"
install -m 0755 "$here/runtime/install.sh" "$stage/install.sh"
for unit in "$here"/units/*.service; do
  install -m 0644 "$unit" "$stage/units/"
done

# Digest of names, modes and contents: the same inputs give the same version.
content_digest="$(cd "$stage" && find . -type f -print0 | LC_ALL=C sort -z \
  | xargs -0 sh -c 'for f; do printf "%s %s %s\n" "$(stat -c %a "$f")" "$(sha256sum "$f" | cut -d" " -f1)" "$f"; done' sh \
  | sha256sum | cut -c1-12)"
mkdir -p "$out_dir"
if [ -z "$version" ]; then
  # Every start attaches the runtime ISO with the highest version, so the
  # default version starts with the UTC build time and sorts by age. The digest
  # suffix is what makes rebuilding unchanged code a no-op.
  for existing in "$out_dir"/runtime-*-"$content_digest".iso; do
    if [ -f "$existing" ]; then
      log "$existing already holds this code; nothing to do"
      printf '%s\n' "$existing"
      exit 0
    fi
  done
  version="$(date -u +%Y%m%d%H%M%S)-$content_digest"
fi
[[ "$version" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid version \"$version\": use letters, digits, '.', '_' and '-'"
printf '%s\n' "$version" > "$stage/VERSION"

iso="$out_dir/runtime-$version.iso"
if [ -f "$iso" ]; then
  log "$iso already exists; nothing to do"
  printf '%s\n' "$iso"
  exit 0
fi
lock_or_die "$out_dir/.build-runtime.lock"

log "writing $iso"
make_iso IDOTS-RT "$iso" "$stage"
chmod 0444 "$iso"
log "done: $iso ($(sha256_of "$iso"))"
printf '%s\n' "$iso"
