# image-builder

Builds the two guest images of architecture section 3.3 on the host. Neither
image is ever published: every host builds its own from public sources.

## Golden image

```sh
guest/image-builder/build-golden.sh [--out-dir /var/lib/invisible-dots/images]
```

1. Downloads the Ubuntu 24.04 cloud image pinned in
   `virtualization/images/base.json` and checks it three ways: the published
   `SHA256SUMS` must list the pinned hash, the file must hash to it, and when
   `gpgv` and `ubuntu-cloudimage-keyring` are installed `SHA256SUMS` must carry
   a valid Ubuntu signature.
2. Downloads Node and uv (pinned in `pins.json`) and checks each against the
   pin and against the checksum file its project publishes.
3. Converts the cloud image to qcow2, grows it (`--disk-size`, default 10G;
   each Dot's overlay is larger and cloud-init grows the filesystem on boot),
   and boots it once with `qemu-system-x86_64 -enable-kvm` (no libvirt) with
   two CDs: a NoCloud seed (`builder/user-data.yaml`) and a payload disk
   labelled `IDOTS-BUILD` carrying `builder/provision.sh`, the tarballs and
   `pins.env`.
4. `provision.sh` installs the apt packages, Node, uv, then as user `dot`
   `uv tool install invisible-playwright-mcp==<pin> --with invisible-playwright==<pin>`
   and `invisible-playwright fetch` from that tool environment, so the cached
   browser engine is exactly the one the MCP server expects. It then runs
   `cloud-init clean --logs --machine-id --seed` and powers off, printing
   `IDOTS-BUILD-RESULT: ok` (or `failed ...`) on the serial console.
5. The host waits (`--timeout`, default 3600 s), checks the marker, and
   writes `golden-<version>.qcow2` (mode 0444) plus `golden-<version>.json`
   with the hashes and every pin.

The default version is `<UTC build time>-<digest of all pinned inputs>`. The
control plane gives a new Dot the golden image with the highest version, so the
time prefix makes the newest build win, and a second run with the same pins
finds the image with that digest and exits at once. An existing golden image is never
rewritten: new pins give a new version. On failure the work directory, with
the console log, is kept and its path printed.

## Runtime ISO

```sh
guest/image-builder/build-runtime.sh [--out-dir DIR] [--agent FILE] [--agentd FILE]
```

Packs `guest/invisible-dots-agent/dist/invisible-dots-agent.mjs`,
`guest/dot-agentd/bin/dot-agentd` (linux/amd64), `runtime/dot-desktop.sh`,
`runtime/install.sh` and `units/*.service` into `runtime-<version>.iso`,
volume label `IDOTS-RT`. The version defaults to `<UTC build time>-<digest of
the contents>`: every VM start attaches the ISO with the highest version, and
rebuilding unchanged code finds the ISO with that digest and does nothing.

Each Dot's seed mounts the ISO by label at `/opt/invisible-dots` and runs
`install.sh` on every boot. The hook copies the units into
`/etc/systemd/system`, creates `/run/invisible-dots` through tmpfiles, enables
lingering for `dot`, then enables and starts the units (restarting any whose
unit file changed).

## Guest units

| unit | runs |
|---|---|
| `dot-desktop.service` | `Xvfb :0 -nolisten tcp` and `xfce4-session` under `dbus-launch` |
| `dot-agentd.service` | `/opt/invisible-dots/bin/dot-agentd` |
| `invisible-dots-agent.service` | `node /opt/invisible-dots/invisible-dots-agent.mjs` |

All run as `dot` with `DISPLAY=:0` and `PATH` starting with
`/home/dot/.local/bin`, where uv put `invisible-playwright-mcp`.
