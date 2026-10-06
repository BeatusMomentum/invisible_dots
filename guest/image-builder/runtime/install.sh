#!/usr/bin/env bash
# The runtime ISO's install hook. cloud-init runs it as root on every boot
# (a per-boot script written by the seed), after the ISO is mounted at
# /opt/invisible-dots. It installs the guest units and starts them.
#
# The units are COPIED into /etc/systemd/system rather than linked: a linked
# unit lives on the ISO, which is not mounted yet when systemd loads units at
# early boot, so it would be "not found" on every boot after the first.
set -euo pipefail

runtime="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
units=(dot-desktop.service dot-agentd.service invisible-dots-agent.service)

log() { printf 'invisible-dots-runtime: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
id dot >/dev/null 2>&1 || die "user dot does not exist (is this a golden image?)"
id dotagentd >/dev/null 2>&1 || die "user dotagentd does not exist (a golden image from before dot-agentd had its own user): build a new golden image"
id dotengine >/dev/null 2>&1 || die "user dotengine does not exist (a golden image from before the engine had its own user)"
[ -x /opt/invisible-dots-engine/bin/python ] || die "the golden image has no engine environment (a golden image from before the nanobot engine): build a new golden image"
version="$(cat "$runtime/VERSION" 2>/dev/null || echo unknown)"
log "installing runtime $version from $runtime"

# The two sockets (architecture 4.2), each in a directory its server owns and
# only the other side may enter, setgid so the socket gets that side's group:
# /run/invisible-dots/agentd.sock, dot-agentd's (dotagentd), reached by the
# engine (group dotengine); /run/invisible-dots-agent/agent.sock, the engine's
# (dotengine), reached by dot-agentd (group dotagentd). dot, whose processes
# are the model's, is in neither group: it cannot enter either directory, so
# it cannot talk to the engine, and nothing of its can take the place of the
# socket the host pushes the key to.
# tmpfiles recreates both on every boot before the units start.
tmpfiles=/etc/tmpfiles.d/invisible-dots.conf
printf 'd /run/invisible-dots 2750 dotagentd dotengine -\nd /run/invisible-dots-agent 2750 dotengine dotagentd -\n' > "$tmpfiles.new"
mv -f "$tmpfiles.new" "$tmpfiles"
systemd-tmpfiles --create "$tmpfiles"

# The workspace is shared with the engine, which reads the Dot's memory notes
# and works in it: group dot, setgid, group-writable. The engine's own state
# (its database and its cron jobs) is closed to everyone else.
install -d -o dot -g dot -m 2775 /home/dot/workspace
install -d -o dot -g dot -m 0755 /home/dot/downloads /home/dot/documents /home/dot/memory
install -d -o dot -g dot -m 0700 /home/dot/browsers
# The home of each browser identity's MCP server (architecture 4.2), outside /home/dot on purpose: the server
# saves the proxy of its browser, password included, in a session file under its home, and the host's file
# routes read /home/dot and nothing else. dot owns it: the server runs as dot.
install -d -o root -g root -m 0755 /var/lib/invisible-dots
install -d -o dot -g dot -m 0700 /var/lib/invisible-dots/mcp
install -d -o dotengine -g dotengine -m 0700 /home/dotengine
install -d -o dotengine -g dotengine -m 0700 /home/dotengine/state

# The Dot's VM proxy (config.json "proxy", root-only, written by cloud-init from the seed): when it is set, the
# whole VM goes out through it. hev-socks5-tunnel carries TCP, UDP and DNS into the SOCKS5 proxy over tun0, and a
# small nftables table lets nothing else leave: if the tunnel is down, nothing goes out at all. Without a proxy the
# VM goes out directly, as before. The units below start after this, so the Dot's first request already uses it.
proxy_dir=/run/dot-vmproxy
if [ -n "$(python3 -c 'import json;print(json.load(open("/etc/invisible-dots/config.json")).get("proxy") or "")' 2>/dev/null)" ]; then
  install -d -o root -g root -m 0700 "$proxy_dir"
  # Writes hev.yml (0600) and env (the proxy's address and the uplink, for the routes); answers 1 for a value that
  # is not socks5://[user:password@]host:port.
  if ! python3 - "$proxy_dir" <<'PY'
import json, os, socket, subprocess, sys
from urllib.parse import unquote, urlsplit
out = sys.argv[1]
url = urlsplit(json.load(open("/etc/invisible-dots/config.json"))["proxy"].strip())
if url.scheme != "socks5" or not url.hostname or not url.port:
    sys.exit(1)
address = socket.getaddrinfo(url.hostname, url.port, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
route = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True).stdout.split()
gateway, device = route[route.index("via") + 1], route[route.index("dev") + 1]
q = lambda value: json.dumps(value)
lines = [
    "tunnel:", "  name: tun0", "  mtu: 8500", "  ipv4: 198.18.0.1", "  post-up-script: /run/dot-vmproxy/up.sh",
    "socks5:", f"  address: {q(address)}", f"  port: {url.port}", "  udp: 'udp'",
]
if url.username:
    lines += [f"  username: {q(unquote(url.username))}", f"  password: {q(unquote(url.password or ''))}"]
lines += ["mapdns:", "  address: 198.18.0.2", "  port: 53", "  network: 100.64.0.0", "  netmask: 255.192.0.0", "  cache-size: 10000"]
def write(name, text, mode):
    fd = os.open(os.path.join(out, name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(text.encode())
write("hev.yml", "\n".join(lines) + "\n", 0o600)
write("up.sh", "#!/bin/sh\n"
      f"ip route replace {address}/32 via {gateway} dev {device}\n"
      "ip route replace default dev tun0 metric 1\n"
      "resolvectl dns tun0 198.18.0.2 && resolvectl domain tun0 '~.' && resolvectl default-route tun0 yes\n"
      f"resolvectl default-route {device} no || true\n", 0o700)
write("allow.nft", "table inet dot_vmproxy {\n chain out {\n  type filter hook output priority 0; policy drop;\n"
      "  oifname { \"lo\", \"tun0\" } accept\n  ct state established,related accept\n"
      f"  ip daddr {address} tcp dport {url.port} accept\n  ip daddr {address} udp accept\n"
      "  ip daddr 10.0.2.0/24 accept\n  udp dport 67 accept\n }\n}\n", 0o600)
PY
  then
    log "error: the Dot's proxy is not socks5://[user:password@]host:port; nothing goes out until it is fixed"
    printf 'table inet dot_vmproxy {\n chain out {\n  type filter hook output priority 0; policy drop;\n  oifname "lo" accept\n  ct state established,related accept\n  ip daddr 10.0.2.0/24 accept\n }\n}\n' > "$proxy_dir/allow.nft"
  fi
  sysctl -q -w net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1
  nft delete table inet dot_vmproxy 2>/dev/null || true
  nft -f "$proxy_dir/allow.nft"
  if [ -f "$proxy_dir/hev.yml" ]; then
    systemctl stop dot-vmproxy.service 2>/dev/null || true
    systemd-run --quiet --unit=dot-vmproxy --property=Restart=always --property=RestartSec=2 \
      /usr/local/bin/hev-socks5-tunnel "$proxy_dir/hev.yml"
    log "the VM goes out through its proxy"
  fi
fi

# A /run/user/<uid> for the desktop session without anyone logging in.
loginctl enable-linger dot || log "warning: could not enable lingering for dot; the desktop runs without XDG_RUNTIME_DIR"

changed=()
for unit in "${units[@]}"; do
  src="$runtime/units/$unit"
  dst="/etc/systemd/system/$unit"
  [ -f "$src" ] || die "the runtime ISO has no $unit"
  if ! cmp -s "$src" "$dst"; then
    install -m 0644 "$src" "$dst.new"
    mv -f "$dst.new" "$dst"
    changed+=("$unit")
  fi
done

systemctl daemon-reload
systemctl enable "${units[@]}" >/dev/null 2>&1
for unit in "${units[@]}"; do
  if [[ " ${changed[*]-} " == *" $unit "* ]] && systemctl is-active --quiet "$unit"; then
    log "restarting $unit (its unit file changed)"
    systemctl restart "$unit"
  else
    # A no-op for a unit that is already running.
    systemctl start "$unit"
  fi
done
log "runtime $version installed; units: ${units[*]}"
