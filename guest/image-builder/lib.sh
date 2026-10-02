# Helpers shared by build-golden.sh and build-runtime.sh. Sourced, not run.
# shellcheck shell=bash

log() { printf '%s: %s\n' "${SCRIPT_NAME:-image-builder}" "$*" >&2; }
die() { log "error: $*"; exit 1; }

need() {
  local missing=()
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  [ "${#missing[@]}" -eq 0 ] || die "missing commands: ${missing[*]} (see architecture section 3.1)"
}

# json_get FILE EXPR: print a value of a JSON file. EXPR is a JavaScript
# expression over `j`, e.g. 'j.node.url'. Node is a host requirement anyway.
json_get() {
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = eval(process.argv[2]);
    if (v === undefined || v === null) { console.error("missing " + process.argv[2] + " in " + process.argv[1]); process.exit(1); }
    console.log(Array.isArray(v) ? v.join(" ") : String(v));
  ' "$1" "$2"
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# download URL DEST: fetch to DEST.part, then rename, so an interrupted
# download never looks finished.
download() {
  local url="$1" dest="$2"
  log "downloading $url"
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 3 --retry-delay 5 --connect-timeout 30 -o "$dest.part" "$url" || die "download failed: $url"
  mv -f "$dest.part" "$dest"
}

# checksum_from_sums SUMS_FILE ENTRY: the SHA-256 a SHA256SUMS-style file
# lists for ENTRY (accepts "hash  name" and "hash *name").
checksum_from_sums() {
  awk -v want="$2" '{ name = $2; sub(/^\*/, "", name); if (name == want) { print $1; exit } }' "$1"
}

# fetch_verified URL DEST SHA256 [SUMS_URL SUMS_ENTRY]: make DEST exist with
# exactly SHA256. With SUMS_URL the published checksum list must agree with
# the pin too, so a pin typo and an upstream change both stop the build.
fetch_verified() {
  local url="$1" dest="$2" want="$3" sums_url="${4:-}" entry="${5:-}"
  if [ -f "$dest" ]; then
    if [ "$(sha256_of "$dest")" = "$want" ]; then
      log "cached $(basename "$dest") matches its pin"
      return 0
    fi
    log "cached $(basename "$dest") does not match its pin; downloading again"
    rm -f "$dest"
  fi
  if [ -n "$sums_url" ]; then
    local sums published
    sums="$(mktemp)"
    curl -fsSL --retry 3 -o "$sums" "$sums_url" || { rm -f "$sums"; die "cannot fetch $sums_url"; }
    published="$(checksum_from_sums "$sums" "$entry")"
    rm -f "$sums"
    [ -n "$published" ] || die "$sums_url has no line for $entry"
    [ "$published" = "$want" ] || die "$sums_url lists $published for $entry but the pin is $want: refusing to continue"
  fi
  download "$url" "$dest"
  local got
  got="$(sha256_of "$dest")"
  if [ "$got" != "$want" ]; then
    rm -f "$dest"
    die "$(basename "$dest") hashes to $got, expected $want"
  fi
  log "verified $(basename "$dest") ($want)"
}

# make_iso LABEL OUTPUT DIR: an ISO 9660 image with Joliet and Rock Ridge
# (so file modes survive) of the contents of DIR.
make_iso() {
  local label="$1" output="$2" dir="$3"
  xorriso -as mkisofs -quiet -o "$output.part" -V "$label" -J -r "$dir" || die "xorriso failed to write $output"
  mv -f "$output.part" "$output"
}

# lock_or_die FILE: hold an exclusive lock for the rest of the script, so two
# builds into the same directory cannot interleave.
lock_or_die() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$1"
    flock -n 9 || die "another build holds $1"
  fi
}
