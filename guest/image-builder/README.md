# image-builder

`@invisible-dots/image-builder` builds the two guest images of architecture
section 3.3 on the host, with the same code on Linux and Windows. It is what
`invisible-dots image build` runs. Neither image is ever published: every host
builds its own from public sources.

Both images land in `INVISIBLE_DOTS_HOME/images`, each with a manifest next to
it (`golden-<v>.json`, `runtime-<v>.json`) that records what went in and the
image's SHA-256; `invisible-dots doctor` checks an image against it with
`verifyImage()`.

## Golden image

`buildGoldenImage({ qemu, accelerator, runner })`:

1. Downloads the Ubuntu 24.04 cloud image pinned in
   `virtualization/images/base.json`, and the Node and uv tarballs pinned in
   `pins.json`, with Node's fetch. Each published checksum list (`SHA256SUMS`,
   `SHASUMS256.txt`, uv's `.sha256`) must name the pinned hash before the
   download starts, and the downloaded bytes must hash to it (Node crypto).
   Cached copies are re-hashed before every build.
2. Copies the cloud image and grows it with `qemu-img resize` (default 10G;
   each Dot's overlay is larger and cloud-init grows the filesystem).
3. Writes the builder seed with `@invisible-dots/iso`: one ISO labelled
   `cidata` holding `user-data`, `meta-data`, `provision.sh`, `pins.env`,
   `mcp-requirements.lock` and both tarballs.
4. Boots it once with the QEMU the host runs Dots with, on the accelerator
   the vm-manager chose (`-accel kvm` or `-accel whpx`, never emulation), the
   same machine, CPU model and devices as a Dot (its command line is built
   from the vm-manager's `machineArgs()`). `provision.sh` installs the
   apt packages (Xvfb, a minimal XFCE, the browser's libraries, ImageMagick
   for dot-agentd's screenshots), Node, uv, then as user `dot` a virtual
   environment in `~/.local/share/invisible-dots/mcp` filled with
   `uv pip install --require-hashes -r mcp-requirements.lock`, links its
   `invisible-playwright-mcp` into `~/.local/bin`, and runs
   `invisible-playwright fetch` from that environment, so the cached browser
   engine is the one the MCP server expects. It removes any sudo rule the
   image had (the builder seed gives `dot` none; each Dot's seed adds its own
   single poweroff rule), cleans the instance state and powers off.
5. Follows the serial console while the VM runs: `idots-build:` lines are
   progress, `IDOTS-BUILD-COMPONENT:` lines go into the manifest as what was
   installed, and `IDOTS-BUILD-RESULT: ok` is the verdict. A VM that does not
   power off within the timeout (default one hour) is killed.
6. Converts the disk into `golden-<version>.qcow2`, writes the manifest first
   and then the image, read-only.

`builder/mcp-requirements.lock` is the MCP server's whole Python environment:
every package at an exact version with the SHA-256 of its files, so nothing is
resolved from the index at build time and a dependency missing from it fails
the build. It is the one place the versions of `invisible-playwright-mcp` and
`invisible-playwright` are written (`pins.env` and the manifest read them from
it), and its header has the command that regenerates it. A new
`invisible-playwright-mcp` version also needs a new capture of its tool list,
`guest-runtime/browser-manager/test/fixtures/mcp-tools.json`, which the
browser tests hold the fake MCP server to.

The default version is `<UTC build time>-<digest of every input>`, the lock
included. The control
plane gives a new Dot the golden image with the highest version, so the time
prefix makes the newest build win, and a second run with the same inputs finds
the image with that digest and stops. On failure the work directory
(`images/.golden-<version>.work`, with the disk and `serial.log`) is kept and
named in the error.

## Runtime ISO

`buildRuntimeIso()` packs, with label `IDOTS-RT`:

| on the ISO | from |
|---|---|
| `install.sh` | `runtime/install.sh` |
| `VERSION` | the version |
| `invisible-dots-agent.mjs` | `guest/invisible-dots-agent/dist/` (`npm run build --workspace guest/invisible-dots-agent`) |
| `bin/dot-agentd` | `guest/dot-agentd/bin/` (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/dot-agentd ./cmd/dot-agentd`), refused unless it is a linux/amd64 ELF |
| `bin/dot-desktop` | `runtime/dot-desktop.sh` |
| `units/*.service` | `units/` |

The version is `<UTC build time>-<digest of the contents>`: every VM start
attaches the ISO with the highest version, and rebuilding unchanged code finds
the ISO with that digest and does nothing. The ISO has no Rock Ridge, so Linux
shows every file on it as readable and executable by everyone; no permission
bit has to survive a Windows host.

Each Dot's seed mounts the ISO by label at `/opt/invisible-dots` and runs
`install.sh` on every boot. The hook copies the units into
`/etc/systemd/system`, creates `/run/invisible-dots` through tmpfiles, enables
lingering for `dot`, then enables and starts the units (restarting any whose
unit file changed).

## Guest units

| unit | runs |
|---|---|
| `dot-desktop.service` | `Xvfb :0 -nolisten tcp` and `xfce4-session` under `dbus-launch` |
| `dot-agentd.service` | `/opt/invisible-dots/bin/dot-agentd`, on TCP port 1024 of every guest address (QEMU's user-mode NAT delivers the host's forward to 10.0.2.15) |
| `invisible-dots-agent.service` | `node --disable-sigusr1 /opt/invisible-dots/invisible-dots-agent.mjs` (no process of the same user can open its inspector and read the OpenRouter key, architecture section 4.3) |

All run as `dot` with `DISPLAY=:0` and `PATH` starting with
`/home/dot/.local/bin`, where the provisioner linked `invisible-playwright-mcp`. The guest
enables no firewall: X listens on no TCP port, and port 1024 must stay
reachable from the NAT; every request to it needs the Dot's token.

## Files

Every file under `builder/`, `runtime/` and `units/` runs inside the guest. They
must stay LF-only ASCII (`.gitattributes` keeps them so on a Windows checkout,
and the builder refuses a CRLF file instead of shipping it).
