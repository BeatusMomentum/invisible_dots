#!/usr/bin/env bash
# Builds the engine's Python environment (architecture section 3.3): a venv
# from the system Python with every third-party dependency of the engine,
# from the hashed lock and nothing else, and a .pth file that puts the
# engine's own source on the venv's path. provision.sh runs it as root inside
# the golden image's builder VM, and the docker smoke runs it on a plain
# ubuntu:24.04 container, so both build the same thing.
#
#   build-engine-env.sh <lock> <venv directory> <engine source directory>
#
# The engine source is NOT copied: it lives on the runtime disk
# (/opt/invisible-dots/engine), which is not mounted when the golden image is
# built. The .pth names the directory, and Python skips a .pth entry that does
# not exist yet. Only wheels are installed, so no build script of any
# third-party package runs, which is what makes it safe to run as root.
set -Eeuo pipefail

lock="${1:?usage: build-engine-env.sh <lock> <venv directory> <engine source directory>}"
venv="${2:?usage: build-engine-env.sh <lock> <venv directory> <engine source directory>}"
source_dir="${3:?usage: build-engine-env.sh <lock> <venv directory> <engine source directory>}"
[ -f "$lock" ] || { echo "build-engine-env: no lock at $lock" >&2; exit 1; }

uv venv --quiet --python /usr/bin/python3 "$venv"
python="$venv/bin/python"
# --no-cache: the image does not need uv's download cache.
uv pip install --quiet --no-cache --python "$python" --require-hashes --only-binary :all: -r "$lock"

site_packages="$("$python" -c 'import sysconfig; print(sysconfig.get_path("purelib"))')"
printf '%s\n' "$source_dir" > "$site_packages/invisible-dots-engine.pth"
# The copy the engine compares with the runtime disk's at every start.
install -m 0644 "$lock" "$venv/requirements.lock"

# The tokenizer's table, fetched once now so the engine never fetches it.
TIKTOKEN_CACHE_DIR="$venv/share/tiktoken" "$python" -c "import tiktoken; tiktoken.get_encoding('cl100k_base')"

chown -R root:root "$venv"
chmod -R go-w,a+rX "$venv"
"$python" -V
