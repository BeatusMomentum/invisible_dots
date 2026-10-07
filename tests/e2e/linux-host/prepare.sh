#!/usr/bin/env bash
# Runs inside the linux-host container (tests/e2e/README.md): copies the
# read-only checkout at /src to /work/dots, installs the workspace's
# dependencies for Linux, and builds what the run needs. TEST HARNESS ONLY.
#
# A copy, not the mount itself: npm ci writes Linux native packages into
# node_modules, and the checkout's own node_modules belongs to its host.
set -euo pipefail

src=/src
dest=/work/dots

rm -rf "$dest"
mkdir -p "$dest"
# Everything a clone has (the engine's source included: the image build packs
# it onto the runtime ISO), plus guest/dot-agentd/bin/dot-agentd, which is
# built with Go before the run (the image builder packs it). Host build
# output and dependency trees are left behind.
tar -C "$src" \
  --exclude=./node_modules --exclude='./*/node_modules' --exclude='./*/*/node_modules' \
  --exclude=.next --exclude=./tmp --exclude=.git \
  --exclude=./apps/cli/dist --exclude=./invisible_engine_dots/.venv \
  --exclude=./apps/web/test-results --exclude=./apps/web/playwright-report.xml \
  -cf - . | tar -C "$dest" -xf -

cd "$dest"
# The npm cache lives on the work volume, so a second preparation is quick.
export npm_config_cache=/work/.npm-cache
npm ci --no-audit --no-fund
npm run build --workspace @invisible-dots/cli
# The web client, which `invisible-dots server` serves too (the run checks it; E2E_WEB=0 skips it and this build).
npm run build --workspace @invisible-dots/web
