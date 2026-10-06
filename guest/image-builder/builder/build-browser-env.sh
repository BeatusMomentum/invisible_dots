#!/usr/bin/env bash
# Builds the Dot's browser (architecture sections 3.3 and 6): the Python environment of
# invisible-playwright-mcp from the hashed lock (as user dot), the command on dot's PATH, the browser
# engine the wrapper's seal expects, and the GeoIP database that a launch with the timezone left to
# "auto" needs. provision.sh runs it as root inside the golden image's builder VM, and the browser
# smoke runs it on a plain ubuntu:24.04 container, so both build the same thing. The Dot's browser is
# this server and nothing else (owner's rule).
#
#   build-browser-env.sh <lock> <environment directory> <GeoIP zip> <GeoIP sha256>
#
# The command is linked into ~dot/.local/bin, which the units put on the PATH of dot-agentd and
# of the engine.
#
# The lock is a hashed list of every package at an exact version (uv pip install
# --require-hashes), so a file that changed on the index, or a dependency missing from the
# lock, fails the build instead of entering the image. The engine is fetched with the
# invisible-playwright of that environment, so the cached engine is the one the server's seal
# expects, in ~dot/.cache/invisible-playwright.
#
# The GeoIP file is the release of daijro/geoip-all-in-one that pins.json names: whoever runs this
# (the image builder on the host, the smoke on its own) fetches it and checks its SHA-256, and it is
# checked against the same hash here again before it is unpacked. It is installed at one fixed path,
# root's and read-only (/usr/local/share/invisible-dots/geoip-aio-all.mmdb, GUEST_PATHS.geoipDatabase),
# and the engine starts the browser's server with the library's own knob STEALTHFOX_GEOIP_MMDB pointing
# at it. With that knob invisible_core uses the file as it is: it never asks GitHub for a newer release,
# never downloads one and never prunes the pinned one, which is what its default does at every launch
# (it pins nothing on purpose). Nothing here writes into the library's own cache layout.
set -Eeuo pipefail

usage="usage: build-browser-env.sh <lock> <environment directory> <GeoIP zip> <GeoIP sha256>"
lock="${1:?$usage}"
env_dir="${2:?$usage}"
geoip_zip="${3:?$usage}"
geoip_sha256="${4:?$usage}"
bin_dir=/home/dot/.local/bin
geoip_database=/usr/local/share/invisible-dots/geoip-aio-all.mmdb
[ -f "$lock" ] || { echo "build-browser-env: no lock at $lock" >&2; exit 1; }
[ -f "$geoip_zip" ] || { echo "build-browser-env: no GeoIP archive at $geoip_zip" >&2; exit 1; }
echo "$geoip_sha256  $geoip_zip" | sha256sum --check --status - || { echo "build-browser-env: $geoip_zip is not the pinned GeoIP release (sha256 $geoip_sha256)" >&2; exit 1; }
id dot >/dev/null 2>&1 || { echo "build-browser-env: user dot does not exist" >&2; exit 1; }

as_dot() { sudo -u dot -H env PATH="/home/dot/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

# dot reads the lock and the archive from files of its own reach, and unpacks the archive in a directory of its own.
dot_lock="$(mktemp)"
dot_geoip="$(mktemp)"
dot_unpacked="$(mktemp -d)"
trap 'rm -rf "$dot_lock" "$dot_geoip" "$dot_unpacked"' EXIT
install -m 0644 "$lock" "$dot_lock"
install -m 0644 "$geoip_zip" "$dot_geoip"
chown dot "$dot_unpacked"

as_dot mkdir -p "$bin_dir" "$(dirname "$env_dir")"
as_dot uv venv --quiet --python /usr/bin/python3 "$env_dir"
as_dot uv pip install --python "$env_dir/bin/python" --require-hashes -r "$dot_lock"
[ -x "$env_dir/bin/invisible-playwright" ] || { echo "build-browser-env: no invisible-playwright in $env_dir/bin" >&2; exit 1; }
[ -x "$env_dir/bin/invisible-playwright-mcp" ] || { echo "build-browser-env: no invisible-playwright-mcp in $env_dir/bin" >&2; exit 1; }
as_dot ln -sfn "$env_dir/bin/invisible-playwright-mcp" "$bin_dir/invisible-playwright-mcp"
as_dot "$env_dir/bin/invisible-playwright" fetch
# The archive holds the database and nothing else; its name is the library's.
as_dot "$env_dir/bin/python" - "$dot_geoip" "$dot_unpacked" <<'PYTHON'
import sys
import zipfile

from invisible_core.constants import GEOIP_MMDB_NAME

archive, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive) as bundle:
    if bundle.namelist() != [GEOIP_MMDB_NAME]:
        raise SystemExit(f"build-browser-env: {archive} holds {bundle.namelist()}, not just {GEOIP_MMDB_NAME}")
    bundle.extract(GEOIP_MMDB_NAME, target)
PYTHON
install -D -m 0644 -o root -g root "$dot_unpacked/geoip-aio-all.mmdb" "$geoip_database"
# What the browser's server will do with it, as dot and with the knob it is started with: the library hands
# back this very file with no lookup, and reads it as a database. A library whose name or knob moved fails here,
# not at a launch.
as_dot env STEALTHFOX_GEOIP_MMDB="$geoip_database" "$env_dir/bin/python" - "$geoip_database" <<'PYTHON'
import sys

import maxminddb
from invisible_core import ensure_geoip_mmdb

expected = sys.argv[1]
found = str(ensure_geoip_mmdb())
if found != expected:
    raise SystemExit(f"build-browser-env: the browser finds {found}, not the pinned {expected}")
maxminddb.open_database(found).close()
print(found)
PYTHON
! as_dot test -w "$geoip_database" || { echo "build-browser-env: dot can write $geoip_database" >&2; exit 1; }
as_dot sh -c 'command -v invisible-playwright-mcp' >/dev/null || { echo "build-browser-env: invisible-playwright-mcp is not on the PATH of dot" >&2; exit 1; }
