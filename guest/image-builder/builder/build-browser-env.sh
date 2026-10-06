#!/usr/bin/env bash
# Builds the Dot's browser (architecture sections 3.3 and 6), as user dot: the Python
# environment of invisible-playwright-mcp from the hashed lock, the command on dot's PATH,
# the browser engine the wrapper's seal expects, and the GeoIP database that a launch with
# the timezone left to "auto" needs. provision.sh runs it as root inside the golden image's
# builder VM, and the browser smoke runs it on a plain ubuntu:24.04 container, so both build
# the same thing. The Dot's browser is this server and nothing else (owner's rule).
#
#   build-browser-env.sh <lock> <environment directory> <GeoIP zip> <GeoIP release tag> <GeoIP sha256>
#
# The command is linked into ~dot/.local/bin, which the units put on the PATH of dot-agentd and
# of the engine.
#
# The lock is a hashed list of every package at an exact version (uv pip install
# --require-hashes), so a file that changed on the index, or a dependency missing from the
# lock, fails the build instead of entering the image. The engine is fetched with the
# invisible-playwright of that environment, so the cached engine is the one the server's seal
# expects; it and the GeoIP file land in ~dot/.cache/invisible-playwright. The GeoIP file is the
# release of daijro/geoip-all-in-one that pins.json names: whoever runs this (the image builder on
# the host, the smoke on its own) fetches it and checks its SHA-256, and it is checked against the
# same hash here again before it is unpacked into the cache directory the browser reads. A launch
# may later fetch a newer release by itself and keeps this one when it cannot reach GitHub (the
# README says so).
set -Eeuo pipefail

usage="usage: build-browser-env.sh <lock> <environment directory> <GeoIP zip> <GeoIP release tag> <GeoIP sha256>"
lock="${1:?$usage}"
env_dir="${2:?$usage}"
geoip_zip="${3:?$usage}"
geoip_tag="${4:?$usage}"
geoip_sha256="${5:?$usage}"
bin_dir=/home/dot/.local/bin
[ -f "$lock" ] || { echo "build-browser-env: no lock at $lock" >&2; exit 1; }
[ -f "$geoip_zip" ] || { echo "build-browser-env: no GeoIP archive at $geoip_zip" >&2; exit 1; }
echo "$geoip_sha256  $geoip_zip" | sha256sum --check --status - || { echo "build-browser-env: $geoip_zip is not the GeoIP release pinned as $geoip_tag (sha256 $geoip_sha256)" >&2; exit 1; }
id dot >/dev/null 2>&1 || { echo "build-browser-env: user dot does not exist" >&2; exit 1; }

as_dot() { sudo -u dot -H env PATH="/home/dot/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

# dot reads the lock from a file of its own reach.
dot_lock="$(mktemp)"
dot_geoip="$(mktemp)"
trap 'rm -f "$dot_lock" "$dot_geoip"' EXIT
install -m 0644 "$lock" "$dot_lock"
install -m 0644 "$geoip_zip" "$dot_geoip"

as_dot mkdir -p "$bin_dir" "$(dirname "$env_dir")"
as_dot uv venv --quiet --python /usr/bin/python3 "$env_dir"
as_dot uv pip install --python "$env_dir/bin/python" --require-hashes -r "$dot_lock"
[ -x "$env_dir/bin/invisible-playwright" ] || { echo "build-browser-env: no invisible-playwright in $env_dir/bin" >&2; exit 1; }
[ -x "$env_dir/bin/invisible-playwright-mcp" ] || { echo "build-browser-env: no invisible-playwright-mcp in $env_dir/bin" >&2; exit 1; }
as_dot ln -sfn "$env_dir/bin/invisible-playwright-mcp" "$bin_dir/invisible-playwright-mcp"
as_dot "$env_dir/bin/invisible-playwright" fetch
# The pinned database goes where the browser looks for it (invisible_core's cache, one directory per
# release tag), as dot, and the browser's own lookup has to find exactly that file: a layout that
# moved fails here, not at a launch.
as_dot "$env_dir/bin/python" - "$dot_geoip" "$geoip_tag" <<'PYTHON'
import sys
import zipfile

from invisible_core.constants import GEOIP_MMDB_NAME
from invisible_core.download import cache_root, geoip_mmdb_path

archive, tag = sys.argv[1], sys.argv[2]
target = cache_root() / "geoip" / tag
with zipfile.ZipFile(archive) as bundle:
    if bundle.namelist() != [GEOIP_MMDB_NAME]:
        raise SystemExit(f"build-browser-env: {archive} holds {bundle.namelist()}, not just {GEOIP_MMDB_NAME}")
    target.mkdir(parents=True, exist_ok=True)
    bundle.extract(GEOIP_MMDB_NAME, target)
if geoip_mmdb_path() != target / GEOIP_MMDB_NAME:
    raise SystemExit(f"build-browser-env: the browser finds {geoip_mmdb_path()}, not the pinned {target / GEOIP_MMDB_NAME}")
print(geoip_mmdb_path())
PYTHON
as_dot sh -c 'command -v invisible-playwright-mcp' >/dev/null || { echo "build-browser-env: invisible-playwright-mcp is not on the PATH of dot" >&2; exit 1; }
