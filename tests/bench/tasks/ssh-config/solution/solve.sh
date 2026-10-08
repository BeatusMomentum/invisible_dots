#!/bin/bash
set -euo pipefail
cd /app
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/buildbox_ed25519
cat >> ~/.ssh/config <<'EOF'
Host buildbox
  HostName 10.20.30.40
  Port 2222
  User deploy
  IdentityFile ~/.ssh/buildbox_ed25519
EOF
chmod 600 ~/.ssh/config
cp ~/.ssh/buildbox_ed25519.pub /app/buildbox.pub
