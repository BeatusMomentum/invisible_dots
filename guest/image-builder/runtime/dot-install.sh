#!/usr/bin/env bash
# dot-install: installs Ubuntu packages for the Dot, the one thing the model's user (dot) may do as root:
#
#   sudo dot-install <package>...
#
# The model's commands run as dot, which is not root, so that they cannot read the engine's key or the Dot's
# token. A sudo rule for apt itself would undo that (`apt-get -o APT::Update::Pre-Invoke::=/bin/sh` is a root
# shell), so the rule names this script and the script takes package names and nothing else: no option reaches
# apt, and the packages come from the Ubuntu archive the image is configured with, checked by apt's signatures.
# install.sh copies it to /usr/local/sbin, root's, and writes the sudo rule.
set -euo pipefail

usage="usage: sudo dot-install <package>..."
[ "$(id -u)" -eq 0 ] || { echo "dot-install: run it with sudo ($usage)" >&2; exit 2; }
[ $# -ge 1 ] || { echo "$usage" >&2; exit 2; }
for name in "$@"; do
  # A Debian package name: lower case letters, digits, "+", "." and "-", starting with a letter or a digit.
  [[ "$name" =~ ^[a-z0-9][a-z0-9+.-]+$ ]] || { echo "dot-install: \"$name\" is not a package name ($usage)" >&2; exit 2; }
done

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
wait_lock=(-o DPkg::Lock::Timeout=300)
apt-get "${wait_lock[@]}" update -qq
apt-get "${wait_lock[@]}" install -y "$@"
