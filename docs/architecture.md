# invisible_dots architecture

This document is the contract every part of the repository is written against.
When code and this document disagree, one of them is a bug: fix the code or
change the document in the same commit.

## 1. What a Dot is

A Dot is a persistent agent that owns a computer. Every Dot has:

- a configuration (name, goal, instructions, model, permissions, resources),
- its own QEMU virtual machine (hardware accelerated) with a persistent qcow2 disk,
- inside that VM, its own agent runtime, which calls models through OpenRouter,
- its own memory, conversation and task state, stored inside the VM,
- zero or more browser identities, each one a separate browser profile with
  its own cookies, storage, logins and fingerprint.

The control plane on the host manages infrastructure: the Dot registry, VM
lifecycle, task dispatch, events, approvals. It never decides what a Dot does
step by step. The reasoning happens inside the Dot's VM.

### 1.1 One mechanism on every host

invisible_dots runs on Linux and on Windows with the SAME code path: the same
QEMU command line, the same networking, the same host to guest channel, the
same way of starting, watching and stopping QEMU, the same database, the same
data directory layout, the same commands. A
difference between the two is allowed only where the operating system makes
sameness impossible, and every such difference lives in ONE function that a
test covers. The complete list today:

| what | Linux | Windows | where |
|---|---|---|---|
| QEMU accelerator | `-accel kvm` | `-accel whpx` | `apps/vm-manager/src/host.ts` `accelerator()` |
| how `doctor` (the CLI's and `GET /api/doctor`'s) reads the accelerator before probing it | `/dev/kvm` opens read-write | the `HypervisorPlatform` feature state through `Get-CimInstance` | `apps/vm-manager/src/accelerator-access.ts` `checkAcceleratorAccess()`, given the host's platform by `hostAccessDeps()` in the same file |
| how `invisible-dots setup` installs QEMU and enables the accelerator | `sudo apt-get install` (or the distribution's equivalent, printed) | one UAC prompt: enables the Windows Hypervisor Platform feature and runs the official QEMU installer silently | `apps/cli/src/setup/install.ts` `installHostPrerequisites()`, given the host's platform by `hostAccessDeps()` of `apps/vm-manager/src/accelerator-access.ts` |
| `setup` run as root | refused: it would check `/dev/kvm` as root and add root to the `kvm` group, not the person who runs the server; it calls `sudo` itself | there is no root; setup always runs as the normal user and elevates its one step | `apps/cli/src/setup/install.ts` `setupRefusal()` |
| a file or directory private to the user (`config/`, `master.key`, `api.token`, `db/`, the data directory) | mode `0600` / `0700` | an ACL that no account but the current user can use, inheritance removed (`icacls`), because Windows ignores the mode bits and a directory under a drive root inherits "Authenticated Users: Modify"; SYSTEM and the local Administrators may stay, as root does on Linux, since some machines grant them explicitly on every new directory | `packages/shared/src/files.ts` `permissionBitsEnforced()` and `restrictToOwner()` |

One more branch exists only to let tests run on a Windows developer host:
`packages/shared/src/sockets.ts` `testSocketPath()` hands out a named pipe
there, because Node cannot serve a unix socket on Windows. The guest
code that serves sockets decides from the path (`socketIsAFile()`), never
from the platform. dot-agentd ships for linux/amd64 only, and the build
constraints of eight of its files let its package compile and its tests run on a
Windows developer host; no shipped binary contains the `!unix` or `!linux` side:

- `setProcessGroup`: `guest/dot-agentd/internal/agentd/exec_unix.go`, `guest/dot-agentd/internal/agentd/exec_other.go`
- `listenUnixPrivate`: `guest/dot-agentd/internal/agentd/listen_unix.go`, `guest/dot-agentd/internal/agentd/listen_other.go`
- `diskUsage`: `guest/dot-agentd/internal/agentd/platform_unix.go`, `guest/dot-agentd/internal/agentd/platform_other.go`
- the process route and its relay (`startProc`, `killGroup`, `TerminalSize`, `MakeRaw`, `WatchTerminalSize`, `ForwardedSignals`; pseudo-terminals are Linux ioctls): `guest/dot-agentd/internal/agentd/proc_linux.go`, `guest/dot-agentd/internal/agentd/proc_other.go`

`tests/repo/platform-branches.test.ts` reads every product source file
(TypeScript and JavaScript, the build scripts, the guest's shell scripts and
dot-agentd's Go) and fails on a platform check outside this list: Node's
platform and OS probes, `getuid`, the Windows path module, a platform name
as a string, Go's `runtime.GOOS`, build constraints and platform file name
suffixes. The engine under `invisible_engine_dots/` (section 2) is Python and
the test does not read it: it runs only inside the Linux guest, uses unix
sockets and process groups, and has no platform branch (the Windows, macOS and
service-manager code of the nanobot it was forked from is gone).

QEMU has no monitor (no QMP, no HMP) on either host. The control plane sees a
VM's QEMU only as a process, through `process.kill(pid, 0)` and the guest
port its user networking listens on, and reaches the guest only through
dot-agentd (section 5.1); both behave the same on Linux and Windows. That is
what removed the one host-side branch a monitor needed: Node has no AF_UNIX
client on Windows, QEMU's `pipe` chardev there blocks the start until a client
connects and serves one client for the life of the process, and a monitor on
TCP would be reachable from every guest (section 3.6).

Never fall back silently: when the accelerator is missing, starting a VM fails
with a message that says which command fixes it. Software emulation (TCG) is
never used. macOS is not supported in this version: it needs an arm64 guest
image and an arm64 browser build, which are not wired.

## 2. Repository layout

```text
apps/
  api/             control-plane HTTP API + SSE, and the control plane composed as one process (`invisible-dots server` runs it)
  scheduler/       task dispatcher, wake on work, sleep on idle
  vm-manager/      QEMU driver: overlays, seed and runtime ISOs, QEMU argv, port forwards, the guest client, the host's one process runner, the doctor report (section 11.1)
  web/             Next.js web client
  cli/             `invisible-dots`: setup, doctor, image build, server, and the API client commands
packages/
  shared/          types and schemas shared by host and guest: config, protocol, events, states
  database/        PostgreSQL schema (PGlite embedded or an external server), migrations, repositories, durable queue
  iso/             ISO 9660 + Joliet writer in plain TypeScript (seed and runtime disks)
  events/          event types, the host event log and its fan-out to SSE subscribers
  channels/        the messaging channel hub and the Telegram and WhatsApp adapters (section 9.8): pairing, who may talk, the messages between a chat and its Dot; runs inside the control plane process
  sdk/             typed HTTP client for the API (used by cli and web)
guest/
  dot-agentd/             the computer daemon (Go): the guest endpoint, exec, files, screenshots
  image-builder/          golden image and runtime disk builders (TypeScript), guest systemd units
invisible_engine_dots/
                   the Dot's engine, run by `python -I -B -m nanobot` in the guest: a hard fork of
                   nanobot (HKUDS/nanobot, MIT, commit f75470e7), Python 3.11 or newer, provenance
                   and everything removed since the import in invisible_engine_dots/UPSTREAM.md.
                   Import package `nanobot`, distribution `invisible-dots-engine`. Only
                   the engine core is kept: no channel, web UI, TUI, audio, pairing, skill,
                   subagent, web tool or CLI (the one entry point answers `--version` and refuses
                   every other command). What it carries: nanobot's tool-calling turn runner,
                   chat completions to OpenRouter and no other provider, the tools of the
                   permission table (section 8.8), nanobot's cron service and its MCP client
                   (no server is configured). The Dot's own layer, the contract of sections 5.3
                   to 5.4, is `nanobot/dots/`. Its own pytest suite runs in CI's `engine` job
                   (`.github/workflows/tests.yml`, Linux only: unix sockets)
virtualization/
  qemu/            the pinned QEMU version for Windows setup (installer URL + SHA-256) and argv notes
  cloud-init/      NoCloud templates
  images/          pinned base image metadata
tests/
  repo/            checks over the whole repository (the platform branches of section 1.1)
docs/
```

There is no host installer script, no service unit and no container: the host
needs Node 24 and QEMU, and `invisible-dots setup` gets QEMU (section 11).

Everything under `apps/`, `packages/` and `guest/image-builder/` is TypeScript in one
npm workspace. `invisible_engine_dots/` is not part of it: it is a Python project
(`pyproject.toml`, pytest) of its own, and this repository's TypeScript project,
vitest run and npm workspaces all leave `invisible_engine_dots/` out
(`tests/repo/vendored-nanobot.test.ts` checks it). It is a hard fork: it is
changed in place and upstream changes are never merged. `dot-agentd`
is a Go module. Node 24 or newer for the TypeScript (the earlier guest agent
uses the built-in `node:sqlite`). Go 1.25 or newer. Python 3.11 or newer for
the engine; the guest runs it on Ubuntu 24.04's CPython 3.12.

The control plane runs as ONE process (`invisible-dots server`) that composes
`api`, `scheduler` and `vm-manager`. They are separate packages so that each
can be tested alone, not separate daemons. It runs in the foreground the same
way on every host; running it as a service is left to the person.

## 3. Host

### 3.1 Requirements

Linux or Windows on x86-64, Node 24, and QEMU 8.2 or newer (Ubuntu 24.04's
own package; the number lives in `MIN_QEMU_VERSION`, `apps/vm-manager/src/host.ts`)
(`qemu-system-x86_64` and `qemu-img`) with its hardware accelerator usable:
`/dev/kvm` readable and writable by the user on Linux, the Windows Hypervisor
Platform feature enabled on Windows. No administrator rights are needed at run
time. `invisible-dots doctor` checks each item and names the command that fixes
it; `invisible-dots setup` performs those commands (section 11). Building the
golden image boots a builder VM with 2 vCPUs and 4 GiB of memory by default
(`GOLDEN_DEFAULTS` in `guest/image-builder/src/golden.ts`).

QEMU is found in `INVISIBLE_DOTS_QEMU_DIR` alone when that is set (a QEMU from
there mixed with a `qemu-img` from somewhere else would run two versions on the
same disks); otherwise first in the default install location of the official
Windows installer, `%ProgramW6432%\qemu` (read from the variable Windows sets,
so a Program Files on another drive is found; Linux has no such variable and
nothing to check), then on `PATH`. The installer's directory comes first so
the QEMU `setup` just installed wins over an older one on `PATH`; when the
installer reused an earlier install directory, `setup` prints the
`INVISIBLE_DOTS_QEMU_DIR` line that points at it. QEMU is always invoked by
absolute path once found, with the server's home as its working directory
(a Windows process holds its working directory open, so inheriting the
directory the server was started from would keep that directory from being
moved or deleted while any Dot runs).

### 3.2 Host filesystem

One directory, `INVISIBLE_DOTS_HOME`, default `~/.invisible-dots` on every
host (`%USERPROFILE%\.invisible-dots` on Windows):

```text
~/.invisible-dots/
  config/
    master.key                          32 random bytes: encrypts secrets in the database
    api.token                           bearer token for the API (its first line)
  db/                                   the embedded PostgreSQL (PGlite) data directory
  server.lock                           { pid, host_uptime_s } of the one server running on this home
  images/
    noble-server-cloudimg-amd64.img     pinned by SHA-256 (virtualization/images/base.json)
    golden-<version>.qcow2              immutable, read-only
    golden-<version>.json               its manifest: inputs, versions, SHA-256
    runtime-<version>.iso               our code: agent bundle + dot-agentd + units
    runtime-<version>.json              its manifest
    .cache/                             verified downloads (re-hashed on every build)
    .golden-<version>.work/             a golden build in progress, kept when it fails
    .golden-build.lock .runtime-build.lock
  vms/<dot_id>/
    disk.qcow2                          overlay, backing file = a golden image
    seed.iso                            NoCloud seed
    qemu.json                           pid file of the running VM: { pid, guest_port, host_uptime_s }, written at spawn
    serial.log                          the guest serial console, truncated at each start
  logs/
    qemu-<dot_id>.log                   QEMU's own output
```

Both hosts use the same layout and the same names; only the root differs, and
only because home directories differ. `<version>` is `<UTC build time>-<digest
of the inputs>`, so the newest build sorts last and rebuilding unchanged inputs
is a no-op; `packages/shared/src/paths.ts` is the one place that names these
files. A path under `INVISIBLE_DOTS_HOME` that contains a comma or any
character outside plain ASCII is refused (`qemuPathProblem()`,
`apps/vm-manager/src/qemu-args.ts`), and `doctor` reports such a home before a
build or a Dot fails on it: QEMU's option syntax cannot carry a comma in every
flag, and the pinned Windows QEMU 11.1, measured, cannot open a `-drive` file
whose path holds a non-ASCII character (an accented Latin letter as much as a
Cyrillic one). Linux would accept UTF-8, but the default home sits under the
account name, and a home that works on one host and not on the other is the
divergence section 1.1 rules out. Nothing under it is a unix socket, so its
length is not limited.

The data directory, `config/` and `db/` are private to the user who runs the
server, and so are `master.key` and `api.token` (section 1.1 says how on each
host); every start brings an existing directory back to that.

`server.lock`, the two build locks and every `qemu.json` record the host's
uptime when they were written (`host_uptime_s`). It only grows within one boot
and starts from zero at the next, so a record from before a host restart is
recognized as stale without trusting a pid, which the operating system may
have handed to another process since. (Windows Fast Startup keeps counting
across a shutdown; such a record falls back to the pid checks of section 3.4.)
The locks are one helper, `acquirePidLock()` in `packages/shared/src/process.ts`:
a lock is taken over only when it is stale (the host restarted, or its pid and
the child process it records are gone, or it names this process's own pid,
which can only be an earlier holder's), only by the one process that creates
`<lock>.takeover` first, and only after reading the lock again unchanged; it is
released only by its holder. The golden build records its builder VM as that
child, so a build killed outright never has its work directory deleted under
a QEMU that still runs. A refusal names the holder and the file to remove.

`qemu.json` is written by the vm-manager (to a temporary name, then renamed)
right after it spawns QEMU, from the spawned process's pid and the guest port
it passed to QEMU. It is the one record of which process and which port belong
to the Dot: QEMU's own `-pidfile` is not used, and the `computers` row (section
9.1) is corrected from it on reconciliation, never the other way round. A file
that does not parse makes the VM's state ERROR, never STOPPED, because a second
QEMU on the same disk would corrupt it.

### 3.3 Two images, two lifetimes

- The **golden image** carries the operating system and third-party software:
  Ubuntu 24.04, Xvfb and a minimal XFCE session, the libraries
  the browser needs, Node 24, `uv`, `invisible-playwright-mcp` in its own
  Python environment, the browser engine already downloaded, and the Python
  environment of the Dot's engine (`/opt/invisible-dots-engine`). It changes
  rarely. It is never modified once a VM uses it: a new one gets a new version
  in its name.
- The engine's environment holds its third-party packages and not its code.
  `builder/build-engine-env.sh` makes a venv from Ubuntu's own
  `/usr/bin/python3` (CPython 3.12) and installs into it, with
  `uv pip install --require-hashes --only-binary :all:`, every package of
  `guest/image-builder/builder/engine-requirements.lock`: exact versions with
  the SHA-256 of their files, transitive packages included, wheels only, so no
  build script of a third-party package runs as root in the builder VM. The
  lock is the one place the engine's dependency versions are fixed (a test
  checks that every dependency `invisible_engine_dots/pyproject.toml` declares
  is in it), and it is part of the inputs digest, so a changed package is a new
  image. The build also prefetches tiktoken's `cl100k_base` table into
  `share/tiktoken` (the engine never fetches it), keeps a copy of the lock at
  `/opt/invisible-dots-engine/requirements.lock`, and leaves the whole venv
  owned by root and writable by nobody else.
- The engine's own code is on the runtime disk, at `/opt/invisible-dots/engine`
  (its `nanobot` package, the lock, `LICENSE` and `UPSTREAM.md`), and a `.pth`
  file in the venv's site-packages puts that directory on the venv's path. Our
  code is ours to change often, so a change to it is a new ISO and not an hour
  of golden build (the engine's source is not an input of the golden digest).
  The two halves are tied together at every start: the engine refuses to run
  when the lock on the runtime disk differs from the venv's copy ("the golden
  image's Python environment was built from another requirements lock: build a
  new golden image"), so a runtime disk that needs another dependency never
  runs on an older golden image.
- Every input of the golden image is pinned by content: the cloud image, Node
  and `uv` by SHA-256 (`virtualization/images/base.json`,
  `guest/image-builder/pins.json`), and the whole Python environment of
  `invisible-playwright-mcp`, transitive packages included, by
  `guest/image-builder/builder/mcp-requirements.lock`, every package at an
  exact version with the SHA-256 of its files. The builder installs it with
  `uv pip install --require-hashes`, so nothing is resolved from the index at
  build time; the lock is the one place the two top-level versions are
  written, and it is part of the inputs digest, so a changed transitive
  package is a new image. apt packages are not pinned by version; apt checks
  their signatures.
- The **runtime disk** (`runtime-<version>.iso`, attached read-only to every VM
  and mounted at `/opt/invisible-dots`) carries our code: the engine's source,
  the `dot-agentd` binary and the systemd units. A new
  version of our code is a new ISO and a VM restart, not a new golden image and
  not a rebuilt overlay.

Neither image is ever published by this project: the host builds both from
public sources (`invisible-dots image build`, code in `guest/image-builder/`),
with the same QEMU it runs Dots with and the same machine: the builder VM's
command line is built from the vm-manager's `machineArgs()`, drive and device
functions, the ones `qemuArgs()` uses, plus only what a builder needs, so a
golden image is provisioned on the machine type, accelerator and CPU model a
Dot boots it on. The seed and runtime ISO labels are each defined once, in
`apps/vm-manager/src/seed.ts`. Both ISOs are written by
`packages/iso`, so no ISO tool is needed on any host.

### 3.4 VM definition

One QEMU process per running Dot, started by the vm-manager with an argument
array (never a shell) built by ONE function, `qemuArgs()`, the same on every
host apart from the accelerator:

```text
qemu-system-x86_64
  -name invisible-dot-<dot_id>
  -machine q35 -accel <kvm|whpx> -cpu host
  -smp <cpu> -m <memory MiB>
  -drive if=virtio,file=<vms/id/disk.qcow2>,format=qcow2,discard=unmap
  -drive media=cdrom,file=<vms/id/seed.iso>,readonly=on
  -drive media=cdrom,file=<images/runtime-<v>.iso>,readonly=on
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:<guest_port>-:1024
  -device virtio-net-pci,netdev=net0
  -device virtio-rng-pci
  -serial file:<vms/id/serial.log>
  -display none
```

- No monitor and nothing that pauses: no `-qmp`, no `-monitor`, no `-S`, no
  `-no-shutdown`. QEMU starts running the guest at once and exits when the
  guest powers off. A test fails on any of these flags.
- No fallback: if `-accel` fails, the start fails and the error names the
  fix. If `-cpu host` is rejected by an accelerator, the error says so; it is
  not replaced by a guessed model without an explicit decision recorded here.
- Start: spawn QEMU detached (so the control plane can restart without
  stopping Dots), with an allowlist of the server's environment
  (`allowlistedEnvironment()`, `packages/shared/src/environment.ts`: what a
  program needs to start and find its files, never `INVISIBLE_DOTS_TOKEN` or a
  `DATABASE_URL`, which a QEMU that outlives the server would otherwise keep),
  write `qemu.json`, then wait until QEMU listens on the guest
  port and is still running 1 s later. The listening port means QEMU parsed
  its command line, opened the accelerator and set up networking; the second
  look catches what fails just after (QEMU checks the CPU model when it builds
  the machine). A QEMU that exits is reported with what it wrote to
  `logs/qemu-<dot_id>.log` during this start; one that never listens within
  30 s is killed and reported the same way.
- A QEMU that starts but never brings the guest up (a vCPU the accelerator
  stopped, a guest stuck in its firmware or kernel) is caught by the READY
  procedure (section 9.3): waiting for `GET /v1/health` fails after its timeout
  with the end of `logs/qemu-<dot_id>.log` and of `vms/<dot_id>/serial.log` in
  the error, and at once when QEMU exits meanwhile.
- State: STOPPED when there is no `qemu.json`, its process is gone, or it was
  written before the host last restarted; RUNNING when its process is this
  Dot's QEMU (the rule below); ERROR when a live pid cannot be proven to be (it
  is reported and never killed). Whether the guest inside is up is guest
  health, which the READY procedure checks; the state of a Dot is both
  (section 9.3).
- Which process may be killed, the one rule: a process this control plane
  spawned and whose exit Node has not reported (Node holds that process, so
  its pid cannot be recycled meanwhile), or a pid from a `qemu.json` written
  in this boot that is alive and this user's (`process.kill(pid, 0)`
  succeeds; EPERM means another user's process, and a QEMU this control plane
  spawned always runs as its own user) AND whose guest port from the same file
  accepts a TCP connection on 127.0.0.1. QEMU's user networking listens on that
  port from the moment it is set up until the process exits, whether or not the
  guest is up; a process that inherited a recycled pid after a crash or a host
  restart does not listen on that one port. The rule is checked again right
  before every kill. Anything else is never killed. A listener that passes it
  is still not trusted with the Dot's token: the guest must prove it holds the
  token first (section 5.1).
- Stop: `POST /v1/system/poweroff` through the guest channel with the Dot's
  token (section 5.2), then wait up to 60 s for QEMU to exit, then kill it
  (SIGKILL on Linux, TerminateProcess on Windows, both through
  `process.kill`) and wait up to 10 s for it to go. A guest that does not
  accept the poweroff (it is not up, or the request fails) cannot power itself
  off, so its QEMU is killed at once. Destroy kills without a poweroff: the
  disk goes too. The VM's files are rewritten or removed right after its QEMU
  stopped (the seed at the next start, everything at a destroy) through one
  retry while a file is in use (`retryWhileInUse()`,
  `packages/shared/src/replace-file.ts`, which also replaces every file this
  repository writes atomically, through `replaceFile()`): Windows can report a process gone before
  its handles are closed, and an antivirus may hold a file for a moment; on
  Linux the first try succeeds.
- Reboot is a stop and a start, not a reset: a reset skips the guest's
  shutdown and would not apply a new runtime ISO, CPU count or memory size.
  The guest port changes on reboot.
- Reconciliation, the one path for it: reading a VM's state (the vm-manager's
  `state()`, which the control plane's recovery after a restart calls for
  every Dot) removes a `qemu.json` whose process is gone the moment it reads
  it, under the Dot's lock, so a pid recycled later cannot make it look alive.
  A VM whose process is its QEMU is adopted with the pid and port from the
  file, and the READY procedure then checks its guest.
- The seed is rewritten at every start. Its cloud-init instance-id is
  `iid-<dot_id>-<digest of the seed>`, so cloud-init re-runs its per-instance
  steps only when the seed's content changes.
- Measured with QEMU 8.2.2 (Ubuntu 24.04) and KVM: this argv starts, the
  forward listens about 0.2 s after the spawn, and a taken port exits with
  `Could not set up host forwarding rule`, the message the start retries on.
- OPEN: measured on QEMU 11.1 with the Windows Hypervisor Platform feature
  disabled, `-accel whpx -cpu host` starts and then pauses the VM with
  `WHPX: Unexpected VP exit code 4` (QEMU keeps running, so the start succeeds
  and READY fails with that line from QEMU's log); `-cpu qemu64` ran the whole
  lifecycle. Whether `-cpu host` works once `invisible-dots setup` has enabled
  the feature is not measured yet. If it does not, the CPU model under WHPX
  needs a decision recorded here.

### 3.5 Port forwards

`<guest_port>` is a free TCP port on 127.0.0.1, chosen at each start (bind to
port 0, read it, release it, pass it to QEMU; retried if QEMU reports the port
taken) and recorded in the `computers` table. A port is never a credential:
every request to a guest carries the Dot's token (section 5.1).

### 3.6 Networking and its limits

QEMU user-mode networking gives every Dot its own NAT with no bridge, no
administrator rights and the same behaviour on every host. Dots cannot reach
each other's guest addresses. A guest CAN reach services on the host's
loopback through `10.0.2.2`, which includes the control plane API, the web
client and the other Dots' forwarded ports. All of them require a credential
the guest does not have: the API's bearer token, the web client's session
(section 9.7; its Host and Origin checks are written by the client and so
cannot be what lets a request through), and each Dot's own token, which a
forwarded port answers only after proving it holds it (section 5.1). QEMU has
no monitor anywhere. Nothing else should listen unauthenticated on the host's
loopback while Dots run; `invisible-dots doctor` cannot check that, and this
document says so.

## 4. Guest

### 4.1 Processes (systemd, all as user `dot` unless stated)

| unit | what |
|---|---|
| `dot-desktop.service` | `Xvfb :0 -nolisten tcp` plus a minimal XFCE session on it |
| `dot-agentd.service` | the computer daemon; TCP port 1024 (reached only through the host's port forward) and a local unix socket |
| `invisible-dots-agent.service` | the Dot itself: the engine (`/opt/invisible-dots-engine/bin/python -I -B -m nanobot`), as the user `dotengine` |

The engine has a user of its own, `dotengine` (created by the image builder's
seed, in group `dot` so it can read and seed the Dot's workspace; its unit runs
it with `UMask=0002`). It holds the OpenRouter key in memory and owns its state
(`/home/dotengine/state`, 0700) and nothing of the model's runs under it:
every command, background process and file operation of the model goes through
dot-agentd as `dot` (section 5.2, `nanobot/dots/computer.py`), so the model can
read or change neither the engine's state nor its memory. The engine needs no
privilege: there is no sudo rule for `dotengine` and no root-owned
configuration file (the Dot's config is stored in the engine's own database,
section 8.8), and its unit sets `NoNewPrivileges=yes`, so nothing it starts can
gain one. What the split does not close: `dot` can read the Dot token
(`/etc/invisible-dots/config.json`) and can stop dot-agentd, which runs as `dot`
too, and listen on port 1024 in its place; a process that does so receives what
the host sends there, the key included. Closing that needs dot-agentd under a
user of its own.

There is no long-running browser service. The agent starts one
`invisible-playwright-mcp` process per launched browser identity (section 6),
with an allowlist of its own environment (`allowlistedEnvironment()`, the same
filter as QEMU's on the host) plus the variables of section 6. The engine of
section 8.8 does not start browsers yet.

`dot` may run exactly one command as root, `/usr/bin/systemctl poweroff`
without a password, which is what dot-agentd starts when the host stops the
VM (section 5.2). The Dot's seed writes that rule; the golden image's builder
seed gives `dot` none and the provisioner removes any rule the image had,
because a Dot's seed only adds its rule to that file. Everything the model
runs (the engine's `exec`, `POST /v1/exec`) therefore runs as `dot`. `dot` is in
the `systemd-journal` group, so it can read its computer's system journal;
the group is given where the user is created, by the image builder's seed,
because cloud-init adds no group to a user that exists already.

### 4.2 Guest filesystem

```text
/etc/invisible-dots/config.json     written by cloud-init: dotId, token (0600, owner dot)
/opt/invisible-dots/                the runtime ISO, read-only: the engine's source (engine/), dot-agentd and the units
/opt/invisible-dots-engine/         the engine's Python environment, built into the golden image (section 3.3)
/home/dotengine/state/              the engine's state (0700): engine.sqlite, which holds the Dot's tables and the
                                    transcripts (section 8.8), and cron/jobs.json, the automations
/home/dot/
  workspace/                        the engine's agent workspace too: group dot, setgid, 2775
  downloads/  documents/
  memory/                           long-term memory notes the Dot writes itself (files; section 8.6)
  browsers/<identity_id>/
    profile/                        the browser profile
    mcp/                            INVISIBLE_MCP_HOME for that identity's server
    metadata.json                   id, name, createdAt, lastUsedAt, status, proxy (optional)
/run/invisible-dots/                dot:dotengine 2750
  agentd.sock                       dot-agentd's local API for the engine (dot:dotengine 0660)
/run/invisible-dots-agent/          dotengine:dot 2750
  agent.sock                        the engine's API, reached by dot-agentd's proxy (dotengine:dot 0660)
```

Each socket sits in a directory its server owns and only the other side may
enter, setgid so the socket takes that side's group (`install.sh` writes both
to tmpfiles). `dot` cannot write `/run/invisible-dots-agent/`, so nothing of
the model's can put another socket where the host pushes the key.

One engine process owns `engine.sqlite`: it opens it in SQLite's exclusive
locking mode and takes the write lock at once, so a second process on the same
file fails at open ("another engine owns ...") and refuses to start, and the
kernel releases the lock the moment the owner dies, so a restart opens it
again without waiting. Nothing else opens the file; the host reads the guest
only through the engine's API. The file carries its layout's version in SQLite's
`user_version`, set when the engine creates it; an engine opens only a file of its
own version and refuses to start on any other ("the engine database was made by
another engine version"), because it does not migrate one.

dot-agentd reads the Dot's home from `DOT_HOME` (default `/home/dot`; the
units do not set it). `INVISIBLE_DOTS_HOME` is the host's data directory
(section 3.2) and is never read in the guest: one name, one place.

### 4.3 Secrets

The OpenRouter key is never written into the golden image, the runtime ISO or
the seed. After the guest reports healthy, the control plane pushes it over
the guest channel (`POST /v1/agent/secrets`) and the engine keeps it in memory only. A VM
that restarts asks for nothing: the control plane pushes it again on every
READY transition, and an engine process that restarts inside a running VM
(systemd restarts it after a crash) announces itself with an `agent.started`
outbound event, on which the control plane pushes the key and the config
again. The Dot's own token is the one secret in the seed; it only
authorizes requests to this one VM.

"Memory only" keeps the key off every disk; it is not on its own what keeps
it from the commands the model runs, which run as the same user `dot`. What
does: `dot` cannot become root (section 4.1), so it cannot read another
process's memory through root; Ubuntu's Yama `ptrace_scope=1` lets a process
trace only its own descendants, and the model's commands descend from
dot-agentd, not from the engine; and the engine is a process of another user,
so ptrace of it is refused in any case. CPython opens no debugger or inspector
on a signal, so nothing can be asked of the process from outside; the unit's
`LimitCORE=0` keeps the key out of core files and `NoNewPrivileges=yes` keeps
anything the engine starts from gaining a privilege. A change to any of these
reopens the question.

In the engine the key lives in one object, `KeyHolder`
(`nanobot/dots/secrets.py`): `POST /secrets` sets it, and the one place that
builds the model provider (`nanobot/dots/provider.py`) reads it. It is never
logged, written or put in an environment, and the server logs a request's
method, path and status and never a body. Nor does it leave in an error:
the holder refuses a key that cannot travel in a header (anything but printable
ASCII without spaces: a newline inside a key makes h11 raise `Illegal header
value b'Bearer <key>'`, and the openai client chains that under its own
exception). That rule has one owner, `packages/shared` (`OPENROUTER_KEY_PATTERN`
and `OPENROUTER_KEY_RULE`): the host applies it where the key enters, so
`PUT /api/secrets/openrouter` answers `400 invalid_request` for a key that breaks
it, and the holder applies the engine's copy of the same two constants again on
`POST /secrets` (a repository test keeps the copy equal). The one place the
provider turns a failure into text (`LLMProvider.failure_text`) removes the
key from it, as a server may echo the Authorization header in its error body; it
replaces the key in the whole text before the body is cut. The same key again changes nothing:
no new provider is built and no running turn is disturbed, so the host's
pushes at every READY and `agent.started` cost nothing. A new key builds the
provider of the next turn; a running turn keeps the one it began with. The
engine reads no credential from its environment: no provider spec names an
environment variable. It refuses to start when it finds a credential on disk
anyway (`nanobot/dots/credentials.py`): a dotenv file with an assignment
(`<state>/.env`, `$HOME/.env`, `$HOME/.nanobot/.env`), a nanobot config file
(`$HOME/.nanobot/config.json`) holding an `apiKey`, or a variable of its own
environment whose name ends in KEY, TOKEN, SECRET or PASSWORD and has a value;
the refusal names where, never what.

A secret also never travels in an error: a failed push of the key is reported
by route, status and code only (`the guest did not take the OpenRouter key
(status 502, ...)`), never with the text the guest or a proxy answered, which
could echo the key into a Dot's error, the log or the event log.

## 5. Host to guest protocol

### 5.1 Transport

HTTP/1.1 over TCP. `dot-agentd` listens on port 1024 inside the guest, and
QEMU forwards `127.0.0.1:<guest_port>` on the host to it (section 3.5). Node
calls `http.request({ host: "127.0.0.1", port })`, the same on every host.
Every request carries
`Authorization: Bearer <dot token>`; `dot-agentd` answers 401 to anything else.
Connections go host to guest only: the guest never connects to the host. Events
flow back over a stream the host opens (5.3).

A port is not a credential (section 3.5), so the host does not send the token
to whatever listens on one: after a host restart or a QEMU that died, another
local process can listen on a port the host still has on record. Before the
first request that carries the token, the guest client asks
`GET /v1/proof?nonce=<16 random bytes in hex>`, the one route without a token,
and requires `{ proof: HMAC-SHA256(token, "invisible-dots guest proof v1\n" +
nonce) }`, compared in constant time. A listener that cannot answer it never
sees the token, the key or the config; the call fails with
`guest_unproven`, which is not retried.

### 5.2 dot-agentd routes (TCP port 1024, token required)

| method and path | body / query | answer |
|---|---|---|
| `GET /v1/proof` | `?nonce=` (32 to 128 lowercase hex characters); no token | `{ proof }`, section 5.1 |
| `GET /v1/health` | | `{ agentd: "ok", agent: <agent /health or {status:"down"}>, uptime_s }` |
| `GET /v1/system` | | `{ hostname, uptime_s, cpus, mem_total_bytes, mem_available_bytes, disk_total_bytes, disk_free_bytes }` |
| `POST /v1/exec` | `{ command, cwd?, timeout_ms? }` | `{ exit_code, stdout, stderr, timed_out }` (bash -lc, output capped at 1 MiB each) |
| `GET /v1/files` | `?path=` | file bytes |
| `PUT /v1/files` | `?path=`, body = bytes | `204` |
| `GET /v1/files/list` | `?path=` | `{ entries: [{ name, type: "file"\|"dir"\|"other", size, mtime }] }` |
| `GET /v1/screenshot` | | `image/png` of display `:0` |
| `POST /v1/system/poweroff` | | `202 { status: "powering_off" }` after starting `sudo -n systemctl poweroff` detached (the seed lets `dot` run exactly that without a password, section 4.1); `500 poweroff_failed` when it cannot be started. How the control plane stops a VM (section 3.4) |
| `* /v1/agent/<rest>` | | reverse proxy to `unix:/run/invisible-dots-agent/agent.sock` at `/<rest>` |

The same routes, without `/v1/agent`, `/v1/proof` and `/v1/system/poweroff`,
are served on `agentd.sock` for the engine (no token: section 4.2 says who can
reach the socket), plus one route of that socket only:

| method and path | body | answer |
|---|---|---|
| `POST /v1/proc` | `{ argv, cwd?, env?, tty?: { cols, rows } }`, with `Connection: Upgrade`, `Upgrade: dots-proc/1` | `101 Switching Protocols`, then frames both ways (one type byte, a big-endian uint32 length, the payload): from the caller `i` input, `e` end of input (^D on a terminal), `r` size (uint16 cols, uint16 rows), `s` a signal number for the process group; from dot-agentd `o` output, `E` error output (none on a terminal), and last `x`, the JSON `{ exit_code, signal? }`. `426` without the upgrade, `400` for an empty program or a bad cwd |

It runs the program as `dot`, without a shell, in its own process group, on a
pseudo-terminal when asked (a new session whose controlling terminal it is).
The process lives exactly as long as the connection: a caller that goes away
takes the whole group with it. Its client is `dot-agentd relay [--socket P]
[--cwd DIR] [--tty] [--env NAME=VALUE]... -- PROGRAM [ARGS...]`, which copies
its own standard input and output through and exits with the program's code
(128 plus the signal number when a signal ended it); with `--tty` and a
terminal on its input it puts that terminal in raw mode and forwards its size
changes. The engine runs the model's every command through it, and reads and
writes the model's files through the `/v1/files` routes of the same socket
(section 8.8). Sleep, stop and reboot are the control plane's decisions,
and the agent's socket offers no poweroff. That is not a guarantee that a Dot
cannot power its own computer off: the model runs commands as `dot`, which
may run the same `systemctl poweroff`, and can read the token in
`/etc/invisible-dots/config.json`. A Dot owns its computer. What the control
plane guarantees is the outcome: a VM that stops without being asked is
recorded as STOPPED, and started again when its Dot has work (section 9.5).
Paths in file routes are resolved against `/home/dot` when relative.

A command of `POST /v1/exec` runs in its own process group, and dot-agentd
kills the whole group when the command reaches its timeout and when the
request that started it goes away: a cancelled call, a tool cut at the stop
grace and an agent that died all take their command with them. A command that
runs through a relay (the engine's) is held the same way: the relay is a child
of the engine that lives as long as the remote command, and ending it ends the
remote process group. Only what the
command detached into another session outlives it.

### 5.3 Agent routes (the Dot's engine, reached as `/v1/agent/...`)

| method and path | body | answer |
|---|---|---|
| `GET /health` | | `{ status: "ok"\|"starting", state: AgentState, openrouter_configured: bool, browser: { identities: n, open: n } }` |
| `POST /secrets` | `{ openrouter_api_key }` | `204` |
| `PUT /config` | `DotRuntimeConfig` (section 7) | `204`, validated, persisted in the engine's database (`dots_kv`) and projected onto the engine's settings in process (section 8.8); a config that does not validate is `400 invalid_config` |
| `POST /events` | `InboundEvent` | `202 { accepted: true }` |
| `GET /events/stream` | `?after=<seq>` | `text/event-stream`, one SSE message per outbound event, `id: <seq>` |
| `GET /state` | | `{ state, current_task_id, pending_approval }` |
| `GET /browser-identities` | | `{ identities: BrowserIdentity[] }` (the engine: always empty, it has no browser yet) |
| `POST /browser-identities` | `{ name, proxy? }` | `201 BrowserIdentity` (the engine: `501 not_implemented`) |
| `GET /browser-identities/:id` | | `BrowserIdentity` (the engine: `404`) |
| `DELETE /browser-identities/:id` | | `204` (the engine: `501 not_implemented`) |
| `GET /automations` | | `{ automations: Automation[] }`: every cron job of the Dot, paused ones too, as `{ id, name, enabled, schedule: { kind: "at"\|"every"\|"cron", at_ms?, every_ms?, expr?, tz? }, message, next_run_at_ms, last_run_at_ms, last_status, last_error, delete_after_run, created_at_ms }`; times are milliseconds since the epoch, `next_run_at_ms` is `null` while a job is paused |
| `PATCH /automations/:id` | `{ enabled: bool }` | `200 Automation` (a job already in that state is not touched: resuming a running job does not move its next run); `404 not_found`, `400 invalid_automation` |
| `DELETE /automations/:id` | | `204`; `404 not_found`, `409 protected` for a system job |
| `GET /tools` | | `{ tools: [{ name, permission, offered, description }] }`: the engine's tool table (section 8.8) in its order; `offered` is whether the model is offered the tool now (its permission is not `deny`, and a memory tool needs memory on; before the first config, none); `description` is the one in the tool's schema |
| `POST /prepare-sleep` | | `204` after the state is flushed and browser sessions are closed; the agent then starts no new work. A model request in flight is abandoned; a tool in flight gets up to 20 seconds to finish and record its result, then is aborted (section 8.7). A `POST /secrets` (the READY procedure of a VM whose stop failed, so no shutdown followed) lifts that, and so does a new inbound event |

Outbound events are written to an outbox table in the Dot's database before
they are streamed, with a monotonically increasing `seq`. The host stores the
last `seq` it saved per Dot and reconnects with `?after=`. Nothing is lost when
the control plane restarts or the VM sleeps.

The engine serves these routes from `nanobot/dots/server.py` (aiohttp), on the
unix socket `INVISIBLE_DOTS_AGENT_SOCKET` names (mode 0660; a socket file left
by a crash is removed first), and binds no TCP listener. Its outbox is the
`dots_outbox` table of `engine.sqlite` (section 8.8). Every outbox row is
written by this one process through `DotStore.write`, which wakes the open
streams after the transaction commits, so the stream replays from the table
after `?after=` (or `Last-Event-ID`) and then sends each row once as it
commits, with a keep-alive comment every 15 seconds; there is no poll.

### 5.4 Event shapes

```ts
// guest to host, persisted in the guest outbox
interface OutboundEvent { seq: number; id: string; type: OutboundEventType; ts: string; data: object }
// host to guest
interface InboundEvent  { id: string; type: InboundEventType; ts: string; data: object }
```

Inbound types: `user.message {text}`, `task.created {task_id, description,
priority}`, `approval.received {approval_id, decision: "approve"|"reject",
note?}`, `system.event {name, data}`. A task cancelled after its
`task.created` may have reached the guest is cancelled there with
`system.event { name: "task.cancelled", data: { task_id } }`. The guest keeps
the id of every inbound event it accepted and ignores one it already has, so
the host may send an event again whenever the outcome of a send is unknown
(section 9.2). An inbound event is recorded and applied in one transaction
(a `user.message` is applied when its chat turn is answered): an event the
guest has accepted is never lost to a restart, and one whose transaction
failed was not accepted, so its redelivery is.

Outbound types: `agent.started {}` (the first event of every start of the
agent process, section 4.3), `agent.state {state}`, `message.assistant {text,
in_reply_to?, spent_usd?}`, `task.started {task_id}`, `task.progress {task_id,
text, spent_usd?}`, `task.completed {task_id, summary, spent_usd?}`,
`task.failed {task_id, error, spent_usd?}`,
`approval.requested {approval_id, task_id?, tool, permission, arguments,
reason}`, `tool.called {task_id?, tool, permission, decision, ok,
duration_ms, target?, interrupted?}`, `browser.identity.created|deleted|launched|closed
{identity_id, name}`, `memory.written {key}`. `interrupted: true` marks a call
the engine stopped during: its outcome is unknown and it was not run again, so
`ok` is false and `duration_ms` is 0.

`task.progress {task_id, text}` is the model saying what it is about to do: the
text an assistant message of a running task carries beside its tool calls (the
message is not the final answer). It is sent once per such message, in the
transaction that stores the message, so a restart neither loses nor repeats it
and it comes before the `tool.called` of those calls. The text is trimmed and
cut at 2000 characters, the last one an ellipsis. A message with no text beside
its calls sends nothing, and neither does the chat: the answer of a chat turn
is its `message.assistant`, and the final answer of a task is its
`task.completed`.

`tool.called.target` is what the call acted on, in one line of at most 160
characters (`TOOL_TARGET_MAX`, in code points as the host's schema counts them;
it refuses a longer, empty or multi-line one), so a client can say "ran `make test`" and not only "exec ok".
It is a name or a place, never content. The permission table
(`nanobot/dots/permissions.py`) gives each tool a function that states what of
its arguments may be shown: `exec` the first line of the command, cut at 120
characters, redacted by an allowlist and not by the shapes a secret takes: the
program of each command, its plain words, long options whose name does not say
they hold a credential, short flags run together (`-rf`), a URL without its
user and password and with its query values masked, and `host:port` are shown;
the value of every single-letter option (`-p`, `-u`, `-H`, `-x`; only a plain
path stays), a value written against its flag (`-phunter2`), the value of a
`--flag` or `NAME=` named for a credential, a quoted word with spaces, any
`user:password` word and the word after `Bearer` or `Basic` are masked as `***`
(a header keeps its name). A secret written as a bare word of a command stays
visible, so the full command stays with the approval;
`read_file`, `list_dir`, `write_file` and `edit_file` the path; `find_files` the
query, else the glob, else the path; `grep` the pattern; `apply_patch` the path,
or `N files, first <path>`; `memory_search` the query; `memory_get` the note
name; `cron` the action and the name or job id (`add daily-standup`);
`exec_session` `input to <id>`, `terminate <id>` or `output of <id>`, and never
the input; `list_exec_sessions` nothing. The engine computes it when the call
starts and keeps it with the call's intent, so a call cut by a stop is reported
with what it was doing. A call that never started has no intent and no target:
a denied call, a call to a tool that is not offered, one whose arguments did not
fit. The key is then absent, as it is for a tool with nothing to name.

`spent_usd` on `message.assistant`, `task.progress`, `task.completed` and
`task.failed` is the model spend of the session the event belongs to, in USD,
read from the same ledger the cost cap uses (section 8.2) in the transaction
that stores the event, to the hundred-millionth of a USD. On a task's events it
is the spend of the task so far (it only grows, and survives a restart, an
approval and a resume); on the chat's `message.assistant` it is what the chat
spent since its last answer, because the answer takes the chat's spend with it
(a chat that parked a call for approval reports the spend before and after the
approval in the one answer it gives). The
engine always sends it (0 when nothing was spent); the schema makes it optional
so events logged before it existed stay valid. The host reads it as the
guest's report: it is never used to enforce anything (the cap is the guest's).

`memory.written {key}` reports a note the Dot wrote: `key` is the note's path
relative to `/home/dot/memory` (`trips/rome.md` for
`/home/dot/memory/trips/rome.md`). It comes from the file tools `write_file`,
`edit_file` and `apply_patch` (a dry run writes nothing), read from the call's
own arguments with the computer's path resolution, so a relative path or a
`../` counts as the tool counts it, and the directory itself is no note. The
engine records the keys with the call's intent before the call runs and sends
one event per note, right after the call's `tool.called`, in the transaction
that stores the call's result, only when the call ran ok: a call that failed,
was denied or was interrupted sends none, and a note an `apply_patch` wrote
twice is one event. A note written through `exec` is not seen.

The `arguments` of `approval.requested` are what the person decides on, and
they leave the guest: a tool argument that carries a secret is redacted there
by the engine, at the point where the event is built (the engine's tools carry
no such argument yet and it redacts nothing; the browser phase adds the proxy
URL of `browser_identity_create`, whose password is replaced by the rule of
`redactProxy()` in `packages/shared/src/identity-rules.ts`). The pending call in
the Dot's database keeps the full arguments, so the approved call is made as
asked.

An outbound event is handed to the event stream only after the transaction
that wrote it to the outbox committed: one written inside a transaction that
rolls back is never streamed, so its `seq` cannot reach the host and then be
reused for another event.

The control plane adds its own: `dot.created`, `dot.updated`, `dot.deleted`,
`computer.state {state}`, `computer.started`, `computer.stopped`,
`task.created`, `task.cancelled`, `approval.resolved`, and the two of a messaging
channel: `channel.status {kind, status, detail?}` (`kind` is `telegram` or
`whatsapp`; `status` is `connecting`, `connected`, `needs_relink` or `error`,
and `detail` never holds a credential) and `channel.peer.paired {kind, peer_id,
label}`. A channel lives in the control plane only: the Dot never sees one, so
no inbound or outbound type names it.

The message a person sends is logged as a `user.message` host event
`{message_id, text, origin?}`. `origin` is `{channel, binding_id, chat_id,
external_id}` for a message that came through a channel and is absent for the
web, the CLI and the SDK. The event log is the one place that says where a
message came from, and a reply is routed back by it; the guest receives the
event with `{text}` only. Only code inside the control plane can set an origin
(`Scheduler.sendMessage`): `POST /api/dots/:id/messages` takes `{text}` and
ignores anything else.

## 6. Browser identities

- An identity is a row of the engine's `dots_browser_identities` table (id,
  name, proxy, created, last used, archived) and a directory under
  `/home/dot/browsers/<identity_id>/`. Its id is a slug of its name plus a short
  random suffix. The guest's database is the only record of which identities
  exist; the host never mirrors the list, it asks the guest. Whether an
  identity is open is never stored: it is derived from the live browser
  sessions of the running engine, so a file never claims an open browser for a
  process that is gone. The proxy is stored as given, password included, in
  the engine's database (`dotengine`'s state directory, 0700, which the model
  cannot read); everything shown to a model, a person, an event or a log has
  the password replaced.
- The fingerprint seed of an identity is stored by the browser layer in the
  profile itself (`profile/.stealth-identity.json`). invisible_dots never stores
  or passes a seed: the first launch of a profile picks one and every later
  launch of the same profile gets the same one back.
- Launching an identity starts one `invisible-playwright-mcp` process over
  stdio. Its environment is the allowlist of section 4.1 plus, through the MCP
  server's documented settings: its home (`INVISIBLE_MCP_HOME=<identity>/mcp`)
  and session id (`INVISIBLE_MCP_SESSION_ID=<identity_id>`), the identity's
  profile directory (`<identity>/profile`), headed mode, `DISPLAY=:0`, and the
  identity's proxy when it has one. The names of the browser layer's own
  settings are written in one place, `packages/shared/src/protocol.ts`
  (`ENV.PROFILE_DIR`, `ENV.HEADLESS`, `ENV.PROXY`). The browser therefore runs
  on the Dot's desktop and shows up in its screenshots.
- The model never calls `browser_open` directly and never sees the MCP tools
  by their own names. It calls invisible_dots tools that take an
  `identity_id`; the browser manager opens the identity's `main` browser with
  no `profile`, `proxy` or `seed` argument, so the environment above is the
  only source of those values.
- At most `browser.identities.max_open` identities are open at once (default
  3, roughly 0.8 GB of memory each). Launching one more closes the least
  recently used. At most `browser.identities.max_identities` exist.
- Closing a session stops the process; the profile stays on disk. Deleting an
  identity removes its directory.

## 7. Dot configuration

YAML in, validated by one schema in `packages/shared` (zod):

```yaml
name: fare-watch                       # [a-z0-9-], 1..40
goal: >
  Check one-way fares from Milan to Lisbon every morning and report the cheapest day.
instructions: >                        # optional
  Write findings to ~/workspace/fares.csv.
model:
  provider: openrouter                 # the only accepted value
  id: z-ai/glm-5.3-flash               # any OpenRouter model id
models:                                # optional per-role models, OpenRouter ids; the roles: summary
  summary: openai/gpt-5-mini         # writes the summary when the thread outgrows limits.context_tokens
computer:
  cpu: 2                               # 1..16
  memory: 4gb                          # 2gb..64gb
  disk: 40gb                           # 20gb..1024gb
  idle_timeout: 15m                    # sleep after this long with nothing to do; 0 = never
browser:
  identities:
    managed_by_dot: true               # the Dot may create and delete identities itself
    max_identities: 20
    max_open: 3
permissions:                           # allow | ask | deny, keyed by permission name
  computer.exec: allow
  browser.identity.delete: ask
memory:
  enabled: true
limits:
  max_steps_per_task: 60               # model turns before a task is failed
  context_tokens: 32000                # prompt tokens a request may use, 4000..1000000 (section 8.6)
  max_cost_per_task_usd: 1.00          # USD of model spend of a task or a chat turn, 0.01..100; the last request may exceed it (section 8.2)
```

`models` has one role, `summary`, and no other: the roles are what the engine
asks a model for, and a role it never asks for would be a setting that does
nothing, so a config that names another is refused as `unknown model role
"fast" (the roles are: summary)` (`MODEL_ROLES` in `packages/shared`, copied
into the guest's `protocol.py`). The role's value is an OpenRouter model id
like `model.id`; without it the Dot's own model writes the summary. A config
push that changes it applies from the next turn.

The permission names are the ones of `PERMISSIONS` in
`packages/shared/src/tools.ts`: those the tools of section 8.3 exercise, and no
others (a Dot has no tool for web reading or search, sub-agents or messaging,
and its notes are files written with `files.write`). A config that names any
other permission is refused as unknown. `PERMISSION_INFO` in the same file gives
each one the label, description and risk (`low`, `medium`, `high`) a person is
shown when they decide on it.

Defaults for permissions not listed: everything under `computer.*`,
`files.*`, `browser.*` and `memory.*` is `allow`, except
`browser.identity.delete`, which is `ask`; `automations` is `ask`. Any
permission name the registry does not know is `deny`.

`DotRuntimeConfig` (what `PUT /config` sends to the guest) is the same object
minus `computer`, with `permissions` resolved by the host: one decision for
every permission the registry knows, defaults applied. The guest applies the
map as it is and denies a permission missing from it, so the defaults live in
one place (`resolvePermission` in `packages/shared`).

## 8. Agent runtime

Sections 8.1 to 8.7 are the contract of a Dot's runtime. Section 8.8 is the
engine that keeps it (`invisible_engine_dots/`), how it keeps it, and what it
does not do yet.

### 8.1 States

`IDLE -> THINKING -> EXECUTING -> (THINKING | WAITING_APPROVAL) -> DONE -> IDLE`

`DONE` follows a failed unit as well as a completed one. `THINKING` is a model
request in flight; `EXECUTING` is a tool running. Every transition is an
`agent.state` event. The protocol also names `PLANNING` (the model's answer
being turned into tool calls); the engine has no such step and never reports it.

### 8.2 Work

The runtime is event driven. Work arrives as `user.message` (a chat turn in
the Dot's single persistent conversation), as `task.created` (queued locally,
run one at a time in priority order, then creation order) or as the firing of
one of the Dot's own automations (section 8.8, answered in the chat). A task
ends when the model answers without tool calls (`task.completed`, the answer is
the summary), or when an approval is rejected and the model gives up. It fails
(`task.failed`, with a reason the owner can read) when it exceeds
`max_steps_per_task`; when a model request fails for good after the retries of
section 8.5, or the run ends without an answer; or after being interrupted
three times (section 8.7). A chat turn has the same limits; a failed chat turn
answers "I could not answer: ...".

`limits.max_cost_per_task_usd` caps the model spend of a task, or of the chat
between one answer and the next. The events that end work carry the spend (section 5.4). The cost of a request is what OpenRouter reports for it in the usage
of the last chunk of its response (`usage.cost`, USD; for a BYOK request the
upstream cost it reports beside it is added, which may count more than was
charged and never less). The engine adds the cost of every response of a turn,
the requests of the turn, their retries and the summary requests alike, to the
spend of its session in the Dot's database as each arrives, and checks the
spend before every model request: when it has reached the cap the turn stops
without asking again, and fails with `stopped: the task reached
limits.max_cost_per_task_usd (spent 1.0423 USD of 1.00)` (`task.failed`'s
`error`; "the turn" instead of "the task" for the chat, which then answers "I
could not answer: ..."). A request cannot be priced before it is answered, so
the cap may be exceeded by the last request, and an answer that crosses it is
delivered and the task completes: the cap only stops the work from going on. A
request that failed has no cost and counts for nothing. A task's spend is kept
across a restart, an approval and a resume (a task that was cut by a crash goes
on from what it had spent); the chat's spend starts again with each answer it gives, so an approval or a
restart does not reset it.
A lowered cap applies from the next turn, like the step limit. A response that
reports no cost fails the turn at its next check, `stopped: OpenRouter reported
no cost for a request, so limits.max_cost_per_task_usd cannot be enforced`: the
cap never runs blind. A request abandoned by a sleep may have cost something
that was never reported; that gap is at most one request a sleep.

### 8.3 Tools

Function names use `_` because OpenAI-style function names cannot contain
dots. Each tool declares the permission it needs, in one table
(`nanobot/dots/permissions.py`) that offers the model its tools, decides every
call and reports the permission of each `tool.called`. A tool that is not in
the table is neither offered nor allowed. Every permission named below is one
of `PERMISSIONS` (section 7); a tool cannot take a permission the host's config
does not know.

| tool | permission | what it does |
|---|---|---|
| `exec` | `computer.exec` | runs a command through `bash -lc` in a working directory with a timeout (60 s by default, 600 s at most); with `yield_time_ms` it returns while the command still runs, which makes it a background job; with `tty: true` it runs on a pseudo-terminal, as a background job that `exec_session` drives (no new tool, the same permission) |
| `exec_session` | `computer.exec` | sends input to, waits for, reads or terminates a background job (a terminal's output is the text of its screen, section 8.8) |
| `list_exec_sessions` | `computer.exec` | lists the background jobs |
| `read_file` | `files.read` | reads a text file, by line window; reports a binary file as binary |
| `list_dir` | `files.read` | lists a directory, optionally recursively |
| `find_files` | `files.read` | finds files by path terms, glob or type |
| `grep` | `files.read` | searches file contents by regular expression |
| `write_file` | `files.write` | writes a whole file |
| `edit_file` | `files.write` | replaces text in a file |
| `apply_patch` | `files.write` | applies a list of structured edits (replace or add) to files, with a dry run |
| `memory_search` | `memory.read` | keyword search over the memory notes (offered only when `memory.enabled`) |
| `memory_get` | `memory.read` | reads one memory note (offered only when `memory.enabled`) |
| `cron` | `automations` | adds, lists and removes the Dot's own scheduled automations |

Planned for the browser phase, which the engine does not carry yet (section
8.8): the screenshot of the Dot's desktop and the browser identity tools. They
take the permissions below and an `identity_id`, and the model never sees the
MCP server's own tool names.

| tool | permission | arguments |
|---|---|---|
| `computer_screenshot` | `computer.screenshot` | none (the image is sent to the model) |
| `browser_identity_list` | `browser.identity.list` | none |
| `browser_identity_create` | `browser.identity.create` | `name, proxy?` |
| `browser_identity_delete` | `browser.identity.delete` | `identity_id` |
| `browser_identity_launch` | `browser.identity.launch` | `identity_id` |
| `browser_identity_close` | `browser.identity.close` | `identity_id` |
| `browser_navigate` | `browser.navigate` | `identity_id, url` |
| `browser_snapshot` | `browser.read` | `identity_id` |
| `browser_read_text` | `browser.read` | `identity_id, selector?` |
| `browser_click` | `browser.act` | `identity_id, selector` |
| `browser_click_at` | `browser.act` | `identity_id, x, y` |
| `browser_type` | `browser.act` | `identity_id, selector, text` |
| `browser_press_key` | `browser.act` | `identity_id, key` |
| `browser_scroll` | `browser.act` | `identity_id, direction: "up"\|"down"` (PageUp / PageDown) |
| `browser_back` / `browser_forward` / `browser_reload` | `browser.act` | `identity_id` (Alt+Left, Alt+Right, F5) |
| `browser_screenshot` | `browser.read` | `identity_id` (the image is sent to the model) |

Browser actions on an identity that is not open launch it first. When
`managed_by_dot` is false, the `browser_identity_create` and
`browser_identity_delete` tools are not offered at all.

The tool calls of one response run one at a time, in the order the model
gave them. Only the response's `tool_calls` count: a call written in the
assistant's text runs nothing. The registry validates a call's arguments
before the policy sees it: an unknown tool or invalid arguments never reach
the gate and never run, and the model gets the error. A result longer than
12000 characters is cut, once.

### 8.4 Policy

Every tool call goes through the policy gate before it runs: a function of the
current config, and the only place that denies a tool the config does not
offer. `allow` runs it, `deny` returns an error result to the model, `ask`
emits `approval.requested`, moves to `WAITING_APPROVAL` and persists the
pending call, with its full arguments, in the Dot's database, keyed by the
call's id. A call that needs approval stops the round: later calls of the same
response are not run either, and the turn ends. `approval.received` is
recorded when it is accepted. With `approve` the model is told, in a turn of
its own, that the call was approved and has not run; it makes the same call
again and the gate lets that one call through, once. With `reject` the model
is told the call did not run, with the note if there is one. A decision is
recorded once: a second one for the same approval is ignored. An approved call
runs at most once. Section 8.8 says how the gate does this.

### 8.5 OpenRouter

`POST https://openrouter.ai/api/v1/chat/completions` with
`HTTP-Referer: https://github.com/feder-cr/dots` and `X-Title: invisible_dots`
(sent only when the base URL's host is `openrouter.ai`, so a stand-in used by
tests never receives them), the key from memory (section 4.3). Tool calling in
the OpenAI format, `tool_choice: "auto"`, every request streamed (with
`stream_options.include_usage`, so the final chunk carries the usage and the
cost, section 8.2). A response cut by the
output limit (`finish_reason: "length"`) has none of its tool calls executed:
what it said is stored without them and the model is asked to go on, a bounded
number of times. Retries with exponential backoff on 429 and 5xx (at most 4
attempts, honouring `Retry-After`). Tool results longer than 12000 characters
are cut with a marker.

### 8.6 Memory

- Working memory: the thread is append-only in the Dot's database; what is
  sent is bounded by `limits.context_tokens`. Before every model request the
  runner measures the request (the system prompt, the tool definitions and the
  messages) against that budget less the room for the answer, and compacts it
  when it does not fit: tool results the model has already processed become
  placeholders, and the older part of the thread is replaced by a summary the
  Dot's model writes (a mechanical digest when that fails). The summary is
  stored with the session, at the boundary it covers, when the turn ends, and
  the next request is the system prompt, the summary and the thread after it.
  `models.summary` (section 7) names another model for the summary request.
  That request goes through the same metered provider, so its real cost counts
  toward the cap (section 8.2); it keeps `limits.context_tokens` as its window,
  so the summary model needs a window at least that large; and it carries no
  tool definitions, because a model other than the turn's may not accept them
  (the turn's own model keeps sending them so that its prompt cache is reused).
- Long-term memory: notes, one file each, in `/home/dot/memory` on the Dot's
  computer. The Dot writes them with its file tools (`files.write`), and each
  note a file tool writes is reported to the host as `memory.written` (section
  5.4); `memory_search` finds a keyword or phrase in their text (a plain search,
  there is no index and no embedding) and `memory_get` reads one. The system
  prompt names the 20 most recently changed notes. With `memory.enabled` false,
  or `memory.read` denied, the memory tools are not offered and the prompt says
  nothing of the notes.
- Workspace memory: `/home/dot/workspace` and `/home/dot/memory`, reached
  through the file tools.

### 8.7 Crash recovery

The engine can die at any point (a crash, a kill, a power cut) and systemd
starts it again. What it guarantees:

- One process owns the Dot's database (section 4.2).
- Every commit point is one transaction that includes the outbox rows
  describing it; section 8.8 lists them.
- An intent left without a result is a call the engine stopped during. When a
  unit is entered (a start, and the beginning of every turn), such a call is
  never run again: it gets the result "This call was interrupted before its
  result was recorded. It may have taken effect, and it may still be running.
  Check the current state before calling it again." (plus, for an approved
  call, that the approval was used), and `tool.called` with `interrupted: true`
  and the permission and decision of its time. A command dies with the engine
  that started it (section 5.2), so "may still be running" covers what the
  command detached; "may have taken effect" covers everything it did before it
  was killed.
- So a call runs at most once, and the model is told whenever its outcome is
  unknown. `tool.called` is written exactly once per call that ran or was
  refused (a call waiting for approval, or one that never started, reports
  nothing). `agent.state` is at-least-once.
- A unit can end between a response and the results of its calls (a failed
  write, a failure, a cancel, a stop). The transaction that ends it answers
  every call of the newest assistant message that has no result, by what the
  database holds for the call (section 8.8). A thread never keeps a call
  without its result, which the provider would refuse on every later turn.
- Stopping: `POST /prepare-sleep` and SIGTERM abandon a model request in
  flight and give a tool in flight up to 20 seconds to finish and commit its
  result, which leaves 10 of systemd's `TimeoutStopSec=30` to checkpoint the
  database. A tool cut at the grace keeps its intent, and the next entry of its
  unit reports it as interrupted. Measured in the engine smoke, with a task's
  `sleep 70` still running at SIGTERM and the event stream connected: the
  process exited 20.4 s after the signal, 9.6 s inside the limit (the 20 s
  grace, then the checkpoint, the exec sessions, the MCP client and aiohttp's
  cleanup in 0.4 s).
- A task that was running when the engine stopped is started again with a note
  that the previous attempt was interrupted, and fails once it has been started
  three times (`stopped: the task was interrupted 3 times`). A start the engine
  abandoned on purpose (a sleep, a stop) is given back and does not count.
- An answer the chat owes is given: a `user.message` whose text the transcript
  holds and that no answer has covered is answered by a turn of its own at the
  next start.

### 8.8 The runtime on the nanobot fork

The engine (`invisible_engine_dots/`) carries the contract of sections 5.3 and
5.4 and the runtime of this section on nanobot's tool-calling runner, in
`nanobot/dots/`. `python -I -B -m nanobot` serves the Dot; `--version`
answers and any other argument is refused. The process reads its environment
once, in `main.py`: `INVISIBLE_DOTS_AGENT_SOCKET`,
`INVISIBLE_DOTS_AGENTD_SOCKET`, `INVISIBLE_DOTS_AGENTD_BIN`,
`INVISIBLE_DOTS_WORKSPACE`, `INVISIBLE_DOTS_ENGINE_STATE`, and for tests and
the smoke `INVISIBLE_DOTS_OPENROUTER_URL`. Before it opens anything it checks
that the runtime disk's `requirements.lock` equals the venv's (section 3.3),
that no credential is on disk (section 4.3) and that no other engine owns the
state.

- Work. One class, `TurnRunner` (`turns.py`), starts every model turn and
  drives nanobot's `AgentRunner` (`nanobot/agent/runner.py`); the `Engine`
  (`engine.py`) decides which turn runs and what its end means. The chat is the
  session `chat`; a task is the session `task:<task_id>`. Accepted
  `user.message` and automation rows wait in `dots_inbound`; when no chat turn
  runs, a chat turn starts with all of them, in the order accepted, as its
  opening messages; while it runs, rows accepted since are injected into it
  through the runner's injection callback and committed as user messages. The
  answer a chat owes (section 8.7) is one rule: when no chat turn runs, no
  accepted row waits, a row is in the transcript and no open approval holds
  the chat, a chat turn runs with no opening message. A `task.created` is
  queued in `dots_tasks` and run one at a time, priority first then arrival;
  a chat turn and a task turn may overlap. `system.event task.cancelled` ends
  the task, cancels its turn and closes its open calls; no task event follows
  `cancelled`. No work starts before the host pushed both the config and the
  key, nor while a prepare-sleep holds it (a `POST /secrets` or a new inbound
  event lifts it). One asyncio loop runs everything.
- Where the state lives. One SQLite file, `<state>/engine.sqlite`
  (`/home/dotengine/state`, 0700), opened in WAL mode with
  `synchronous=FULL` and the exclusive locking mode. It holds the Dot's tables
  (`dots_outbox`, `dots_inbound`, `dots_tasks`, `dots_tool_intents`,
  `dots_tool_decisions`, `dots_approvals`, `dots_spend`, `dots_browser_identities`, `dots_kv`) and the transcripts
  (`sessions`, `messages`): SQLite makes a transaction atomic per file only,
  and this is what lets an event commit with the transcript row it describes.
  `DotStore` (`store.py`) is the one place a write transaction begins and
  ends.
- Commit points, each one transaction with the outbox rows describing it: an
  inbound event with its effect (a queued task, a recorded decision, a
  cancel); a task's start with `task.started`; the opening of a turn (the
  calls the previous unit left open are closed, then the opening messages are
  appended); every message the runner adds, one at a time and before it goes
  on (`AgentRunner._commit` hands it to the commit callback of `TurnRunner`):
  the assistant message with its tool calls, each tool result as soon as its
  call returns, the final answer, an injected user message; a gate decision
  (a park, or a denial); a call's intent with `agent.state EXECUTING` (from
  the turn hook, just before the tool runs); the end of a failed turn; the
  agent state transitions. `DotStore.append_messages` calls
  `record_transcript_append` (`transcript_outbox.py`) in the transaction that
  stores a message: a user message that carries an inbound id marks that input
  as in the transcript; the final assistant message of the chat emits
  `message.assistant` and applies every input the transcript holds (the
  `in_reply_to` is the newest `user.message`); the final assistant message of
  a running task completes it with `task.completed`, the text as the summary;
  any other assistant message of a running task that has tool calls and text
  beside them emits `task.progress` (section 5.4);
  a tool result emits `tool.called`, its duration measured from the call's
  intent and its `target` read from it (section 5.4), which it removes. A turn that fails fails its task in its own
  transaction; a chat turn that fails answers "I could not answer: ...".
- Closing open calls (`close_open_calls`, `gate.py`), at every start, at the
  beginning of every turn and at the end of a cancelled or failed one. For
  each call of the newest assistant message that has no result, one result,
  by what the database holds: an intent (the call started) gives the
  interrupted text of section 8.7 and `tool.called` with `interrupted: true,
  ok: false, duration_ms: 0`, and the decision `ask` when it was the approved
  call; a park decision gives the approval message again and no event; a deny
  decision gives "The Dot's policy denied this call." and `tool.called` with
  `deny`; a skip decision gives the skipped message and no event; nothing
  gives "Not executed: the unit ended before this call ran." and no event.
- The model's computer. `AgentdComputer` (`computer.py`) is the one door to
  the Dot's computer, and it speaks only to dot-agentd. Every command the model
  runs goes through `ExecTool._spawn`, the one spawn of `exec` and of the
  background jobs: a local child of the engine in its own session that runs
  `dot-agentd relay -- /bin/bash -lc <command>` with `PATH` as its only
  variable (the command's environment is its login shell's, as `dot`); the
  relay lives exactly as long as the remote command, and killing it (a
  timeout, a cancel, `terminate`, the engine's death) makes dot-agentd kill
  the remote process group. A background job is an `exec` that outlived its
  `yield_time_ms`; `exec_session` and `list_exec_sessions` act on it. With
  `tty: true` (always a background job: a terminal program is interactive) the
  relay gets `--tty` and `TERM` (the engine's, else `xterm-256color`) and
  dot-agentd runs the command on an 80x24 pseudo-terminal, so what it writes is
  one stream and its input is echoed back; `close_stdin` is ^D and the
  character with code 3 is ^C. The model reads the text of the screen, not the
  byte stream: `terminal_text` (`exec_session.py`) drops escape sequences,
  turns `\r\n` into a newline, lets a lone `\r`, a backspace and erase-in-line
  overwrite, and holds back an escape sequence cut by the end of one poll until
  the next. A program that paints the whole screen (vim, htop) is not
  rendered. There is no terminal for the person: a person's keystrokes are not
  tool calls and would bypass the approval system (section 10). The file
  tools read and write through the `GET /v1/files`, `PUT /v1/files` and
  `GET /v1/files/list` routes of `agentd.sock` (relative paths resolve against
  `/home/dot/workspace`), keeping nanobot's line windows, read-before-write
  checks, fuzzy edit matching and diff summaries. `find_files` and `grep` run
  `find`, `stat` and `grep` on the computer, as `dot`, by argv with no shell,
  to find the files that can match, and read only those. Nothing of the model's
  runs as `dotengine`, and what `dot` may touch is decided by the operating
  system: the engine adds no path policy of its own.
- The config. `PUT /config` is validated (`DotRuntimeConfig`, the same checks as
  the zod schema), stored in `dots_kv` and projected in process
  (`projection.py`): the OpenRouter model id, the tools offered (those of the
  table whose permission is `allow` or `ask`, minus the memory tools when
  memory is off), `max_steps_per_task` as the step limit, `context_tokens` as
  the context budget, the 12000-character result cap, and the Dot's section of
  the system prompt (its name, goal and instructions, then nanobot's tool
  contract, a short note on its computer, the memory notes and the time).
  There is no config file, no installer and no sudo rule. The same config
  again changes nothing, and the same key again builds no provider
  (`provider.py`: a new provider only when the key, the model or the base URL
  changes, and a running turn keeps the provider it began with), so the host's
  pushes at every READY and `agent.started` disturb no running turn.
- `agent.state` follows the turn hook: a run starting is `THINKING`, a tool
  running `EXECUTING`, the last run ending `DONE` then `IDLE` (or
  `WAITING_APPROVAL` while an approval waits); every start of the process
  records `IDLE` again.
- After a crash (`Engine.start`). The first event is `agent.started`. Every
  call left with an intent and no result is closed as interrupted, once. An
  approval still `running` is over (its call is one of those interrupted, with
  `decision: "ask"`); a turn that was telling a session a decision (`granted`,
  `told`) is told again; the approved call still runs at most once. A task left
  running is resumed with its description and the note "[The previous attempt
  at this task was interrupted by a restart. ...]", unless an approval of its
  session is open (then the decision moves it), and fails once it has been
  started three times; a run a prepare-sleep abandoned does not count. A chat
  turn whose answer is owed runs by the rule above.
- Policy (`gate.py`). Every tool call is decided at one boundary,
  `_admit_tool_call` in `nanobot/agent/tools/execution.py`, after the call was
  validated and its arguments cast and before anything runs; the gate is a
  required argument of the runner (`AgentRunSpec.gate`), the contract it
  answers is in `nanobot/agent/tools/gate_types.py`, and a batch of calls that
  run together is decided in full before any of them starts, so a park stops
  the calls after it; `ToolRegistry` has no way to run a tool, so no call
  reaches one another way. The decision
  is made from the map the host pushed (section 7), read at the moment of the
  call, so a push between two calls of one turn applies to the second: a tool
  with no permission, or a permission missing from the map, is denied, and
  with no config or no database every call is (the gate fails closed). `deny`
  returns the reason to the model as the call's result, with no hint to try
  another way; `tool.called` reports the call with `decision: "deny"` and
  `ok: false` (the decision of a call inside a turn is kept in
  `dots_tool_decisions` until its result is written). A provider's tool call id
  names a call only inside its own response (models behind OpenRouter number
  their calls from zero in every response), so the intent, the decision and the
  approval of a call are keyed by the session and the id, and an approval is made
  per ask: the same call asked again while its approval is pending (same session,
  id, tool and arguments) is the one approval, a later call that only shares the
  id is a new one.
- Tools offered. One table (`nanobot/dots/permissions.py`, section 8.3) lists
  the tools a Dot may use, the permission each exercises and how to build it;
  the registry holds exactly those, and each turn works on a view of it that
  holds the offered ones, so a denied tool is not even seen, and the gate
  decides every call by the same table. nanobot's MCP client is wired in with
  no server configured; the tools of a server would register on the registry
  and still be neither offered nor allowed until the table names them.
- Browser identities. `BrowserManager` (`nanobot/dots/browser.py`) owns the
  identities (their rows in `dots_browser_identities`, their directories under
  `/home/dot/browsers`, made and removed as dot through the Computer) and one
  `invisible-playwright-mcp` process per open identity, started as dot through
  `dot-agentd relay` with the environment of section 6 and nanobot's MCP client
  on a registry of its own. Launch, close and delete run one at a time; calls on
  one identity run one at a time. At `max_open` a launch closes the least
  recently used identity first; a lower `max_identities` deletes nothing. A
  browser action on an identity that is not open fails with `not_open` and
  never launches it. A browser that the server reports gone while its process
  lives is opened again once and the call repeated; a process that ended (the
  client reports it instead of reconnecting, because a restarted process has
  lost its browser) is a crash: the identity is closed, `browser.identity.closed`
  is emitted once and the call fails with `crashed`. A close calls
  `browser_close` first, so Firefox flushes its profile, then ends the process.
  Every `browser.identity.*` event commits with the row change it describes.
- Approvals. `ask` inside a turn stores the call with its full arguments in
  `dots_approvals` (`pending`), emits `approval.requested` and records the
  decision `park`, in one transaction; the model gets a result saying the call
  waits for the user and has not run, the later calls of its response are
  recorded as `skipped` (they run nothing, report nothing and say so), and the
  runner ends the turn (`stop_reason` `parked`: no further model request).
  Nothing waits in memory. A retried turn reuses the approval of the same
  tool call id and asks nothing new. A task whose run parked a call is neither
  failed nor resumed while an approval of its session is open, and
  `agent.state` ends on `WAITING_APPROVAL`; `GET /state` names the oldest
  pending approval. `approval.received` is applied in the transaction that
  accepts it (`approved` or `rejected`, with the note); a decision for an
  unknown or already decided approval is logged and ignored. The engine then
  tells the session that made the call, in a turn of its own (the chat's
  included): an approved call is to be made again with exactly its arguments
  (written as JSON with no spaces), a rejected one did not run, with the note.
  The approval is `granted` (or `told`) before that turn starts and `done`
  when it ends. The one call an `ask` lets through is the approved one made
  again in a turn of the same session: same tool, the same arguments (compared
  with keys sorted), once; it moves the approval to `running`, runs like any
  call of the turn, and its `tool.called` says `ask` and ends the approval.
  Different arguments are asked about anew.
- Automations. nanobot's `CronService` runs inside the engine, its jobs in
  `<state>/cron/jobs.json`, and the `cron` tool (permission `automations`,
  `ask` by default) adds and removes them. A firing is recorded as a durable
  inbound row, `automation.fired`, once per firing, and the chat answers it as
  an input: the opening message reads `[Automation "<name>" fired] <message>`
  and the answer is a `message.assistant` without `in_reply_to`. The person
  lists, pauses and removes the jobs through `GET /automations`, `PATCH` and
  `DELETE /automations/:id` (section 5.3), served from the same service object
  the tool uses; the person does not make one. `GET /tools` shows the permission
  table with what the model is offered now.
- Prepare-sleep and SIGTERM. The engine stops taking new work; a turn with no
  tool running is cancelled at once; a turn with a tool running gets up to 20
  seconds, in which the tool's result commits and the next iteration abandons
  the turn, and is cancelled at the deadline (its intent stays, and the next
  start reports it interrupted); the attempt of a cut task is given back; the
  WAL is checkpointed. The API (`server.py`) answers the host's `prepare-sleep`
  to its end even when the host hangs up.
- Removed from nanobot (everything since the import is in
  `invisible_engine_dots/UPSTREAM.md`): the app shells, the channels, the bus
  and the commands, the agent loop and its hooks, the other approval and guard
  mechanisms (the workspace path policy, the command guard, the sandbox, the
  SSRF guard), subagents, skills, the web tools, image and document reading,
  the usage telemetry, the configuration files and every provider but
  OpenRouter.
- Not yet: the browser identities in the engine's API and tools (`GET` lists
  none, `POST` and `DELETE` answer `501`; `BrowserManager` exists and is tested
  but nothing calls it) and the screenshot tool.

## 9. Control plane

### 9.1 Database (PostgreSQL)

PostgreSQL is the database on every host. By default it is PGlite (PostgreSQL
compiled to WebAssembly, `@electric-sql/pglite`) running inside the server
process with its data in `~/.invisible-dots/db`, so nothing has to be
installed. With `DATABASE_URL` set, the same migrations and the same queries
run against an external PostgreSQL 16 or newer through `pg`. The repositories
talk to one small interface (`query` for one statement, `exec` for a script
of several such as a migration file, `transaction`, `close`, and `kind`) with
two adapters; no SQL differs between them, and the test suite runs against
both. int8 comes back as a number (a value above 2^53 is an error, never
rounded) and bytea as `Uint8Array`, on both.

PGlite has one connection and does not lock its data directory, so one server
runs per `INVISIBLE_DOTS_HOME` (`server.lock`, section 3.2), transactions run
one at a time, and nothing else opens the database: `invisible-dots doctor`
asks the running server instead. Each migration file runs in its own
transaction, which first takes a transaction-scoped advisory lock, so two
servers migrating one external database apply every file once.

One database serves one control plane. `server.lock` only guards one
`INVISIBLE_DOTS_HOME`, and two servers with different homes on one external
database would each reconcile, dispatch and stop the other's Dots (one finds
no disk for the other's VMs and marks them ERROR). So the server also holds a
session-level advisory lock on its database for its whole life
(`Database.holdInstanceLock()`) and refuses to start without it; the lock goes
with the session, so a server that died leaves nothing to clean up.

Event ids are visible in id order: every insert into `events` takes a
transaction-scoped advisory lock before its `bigserial` id is drawn, held
until its transaction commits. Without it, on PostgreSQL a transaction that
drew id 10 could commit after one that drew 11, and a client that resumed
`GET /api/stream` after 11 would never see 10. A transaction that inserts an
event and changes other rows inserts the event first, so the lock is never
taken while holding a row lock another event writer waits for.

Tables: `dots`, `computers`, `tasks`, `task_runs`, `events`, `approvals`,
`inbound_events`, `secrets`, `channel_bindings`, `channel_peers`,
`channel_pairings`, `channel_prompts`, `schema_migrations`. Migrations are plain
SQL files applied in order at start.

- `dots(id text pk, name text unique, config jsonb, status text, created_at, updated_at)`
- `computers(dot_id pk fk, vm_name, guest_port int null, pid int null, state text, golden_image text, runtime_image text, token_enc bytea, event_cursor bigint default 0, last_active_at, last_error, updated_at)`: `guest_port` and `pid` are null while no QEMU runs, and `guest_port` is not unique (a crashed VM's row may name a port since reused); both are copies of `qemu.json` (section 3.2), which wins on reconciliation
- `tasks(id text pk, dot_id fk, description, priority int, status, created_at, scheduled_at, started_at, finished_at, summary, error, spent_usd double precision default 0)`: `spent_usd` is the highest `spent_usd` the guest reported on the task's events (section 5.4), recorded by the host in the transaction that stores each event, so a late or repeated event never lowers it and a cancelled task the guest keeps working on still counts; a task whose guest never reported spend stays 0
- `task_runs(id pk, task_id fk, started_at, delivered_at, finished_at, outcome)`: `delivered_at` is set when the guest accepted the run's `task.created`
- `events(id bigserial pk, dot_id, type, data jsonb, source 'host'|'guest', guest_seq bigint, created_at)`, unique `(dot_id, guest_seq)`, and unique `(dot_id, data->origin->>binding_id, data->origin->>external_id)` for a `user.message` with an origin: a channel message is stored once, by the channel's own id, in the transaction that stores it, so a redelivery after any failure finds the first one and the Dot gets it once (section 9.8)
- `approvals(id text pk, dot_id, task_id, tool, permission, arguments jsonb, reason, status 'pending'|'approved'|'rejected'|'expired', note, created_at, resolved_at)`: an approval whose task reached a terminal state before anyone decided is `expired`, in the same statement that ends the task, and an `approval.requested` for a task that is already terminal is stored as `expired`, never `pending`
- `inbound_events(seq bigserial pk, id text unique, dot_id fk, type, data jsonb, ts, task_id, run_id, created_at, sent_at, delivered_at, dropped_at, drop_reason, failures int, last_error, retry_at)`: the outbox of host to guest events (section 9.2)
- `secrets(scope text, name text, value_enc bytea, updated_at, pk(scope, name))`: `scope` is `global` or a dot id; no foreign key can cover that, so deleting a Dot deletes the secrets scoped to it in the same statement (`DotsRepository.delete`)

- `channel_bindings(id text pk, dot_id fk cascade, kind 'telegram'|'whatsapp', enabled bool, settings jsonb, status, status_detail, account, event_cursor bigint, created_at)`, unique `(dot_id, kind)`: one Dot's link to one channel kind (section 9.8); `settings` is `{approvals, notify_tasks}` and never a credential; `account` is the channel's public name for the account (a bot's username); `event_cursor` is the id of the last event of the Dot the hub dealt with
- `channel_peers(binding_id fk cascade, peer_id, chat_id, role 'owner'|'user', label, created_at, pk(binding_id, peer_id))`: the people allowed to talk through the binding, by the channel's stable id, with the chat they paired from
- `channel_pairings(binding_id fk cascade, code_hash, expires_at, consumed_at, pk(binding_id, code_hash))`: one-time pairing codes, stored hashed
- Where a channel message came from is in its `user.message` event (section 5.4), the one owner of that fact; there is no table of handled messages. An index on `events` by `(dot_id, data->>'message_id')` for `user.message` lets an answer find the message it answers
- `channel_prompts(binding_id fk cascade, approval_id fk approvals cascade, chat_id, ref, created_at, pk(binding_id, approval_id, chat_id))`: the approval prompts a channel sent, one message per chat; `ref` is the channel's handle for the message (a Telegram message id), what an edit needs. A row is deleted once its prompt was edited to the outcome

Secrets are encrypted with AES-256-GCM under `master.key`. The OpenRouter key
is looked up as `(<dot_id>, openrouter_api_key)` first, then
`(global, openrouter_api_key)`.

### 9.2 Durable queue

The dispatcher claims work with
`SELECT ... FROM tasks WHERE status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= now()) ... FOR UPDATE SKIP LOCKED`,
one task per Dot at a time (a Dot with a `RUNNING` or `WAITING_APPROVAL` task
is skipped). One dispatcher runs per database (section 9.1); the row locks
make a claim and the rest of its transaction one unit, and are not what would
keep two dispatchers from claiming two tasks of one Dot.

Everything the control plane tells a guest goes through one durable outbox,
`inbound_events`, written in the same transaction that decided it: a claim
stores its task's `task.created` (and opens a run), a resolved approval its
`approval.received`, a message its `user.message`, a cancel its
`system.event`. Nothing is kept only in memory, so a failed wake or a control
plane restart loses nothing a person saw accepted. One deliverer
(`apps/scheduler/src/inbound.ts`) sends a Dot's undelivered rows in order,
waking the Dot first when it sleeps, and stops at the first failure so a later
event never overtakes an earlier one:

- A row is delivered when the guest answers 202. Every READY transition
  sends the Dot's rows again, and a periodic pass retries rows whose retry
  time came.
- Whether a `task.created` may still go out is decided in the statement that
  marks its send begun: a task that stopped being active meanwhile (a cancel
  that won the race with a wake) is dropped there and never sent. A cancel of
  a task whose send never began drops that `task.created` in its own
  transaction; otherwise the guest may hold the task, so the cancel stores a
  `system.event` behind it.
- A send whose outcome is unknown (a timeout, a reset connection) may have
  reached the guest: it is sent again with the same id, which the guest
  ignores if it has it, and it never counts as a failure. Only failures
  with a known outcome count: the guest refused the event (it is dropped),
  or nothing listened. After 3 such failures a `task.created` gives its task
  up as FAILED; a message or a decision is never given up and waits for the
  next READY.

### 9.3 Lifecycles

VM states: `PROVISIONING, STARTING, RUNNING, IDLE, STOPPING, STOPPED, ERROR, DELETING`.

Dot states: `CREATING, READY, IDLE, RUNNING, WAITING_APPROVAL, ERROR, DISABLED`.

Task states: `PENDING, RUNNING, WAITING_APPROVAL, COMPLETED, FAILED, CANCELLED`.

A Dot is READY when all of these hold:
the QEMU process is running, `GET /v1/health` answers through the port forward with
`agentd: "ok"` and the agent `status: "ok"`, the OpenRouter key has been pushed
(`openrouter_configured: true`), and the guest's own checks pass (filesystem
writable, network reachable, browser layer installed) as reported in the
health answer.

The READY procedure runs under the Dot's lock, like every operation that
changes a computer's state, and is the one place that starts a Dot's event
pump; it first stops a pump of an earlier start, which would read a guest
port that is gone. The key and the config are read from the database when
they are pushed. A key or a config stored while the procedure runs bumps the
Dot's generation, and the procedure pushes again until it completes on an
unchanged generation, so a tightened permission or a rotated key is never
lost in that window; pushes to a READY guest run one at a time per Dot, so the
last one sent is the newest. Every stop, reboot and delete takes the Dot out
of READY before anything else, so a delivery that skipped the lock because
the Dot was READY can only meet a stop that has not begun.

### 9.4 Create

`POST /api/dots` -> insert `dots` (CREATING) -> generate a token ->
`qemu-img create -f qcow2 -F qcow2 -b <golden> disk.qcow2 <disk>` -> write
`seed.iso` -> pick a guest port -> spawn QEMU and write `qemu.json` (section
3.4) -> wait for the forward -> wait for health -> push the secret -> `PUT
/config` -> open the event stream -> READY.

### 9.5 Sleep and wake

When a Dot has no PENDING task that is due, no RUNNING or WAITING_APPROVAL
task and nothing undelivered in its outbox, its agent state is IDLE, and
nothing happened for `idle_timeout`: `POST /v1/agent/prepare-sleep` ->
`POST /v1/system/poweroff` -> QEMU exits (killed after 60 s, section 3.4) ->
STOPPED. The idle stop checks all of it again under the Dot's lock, after
taking the Dot out of READY, and is called off when work arrived meanwhile.
Disk, identities and memory stay. A new task or message for a STOPPED Dot
starts the VM, waits for READY and then delivers it; so does a scheduled task
when its `scheduled_at` comes. A STOPPED Dot whose due work waits behind a task
its guest has not finished (it was stopped mid-task) is started too, so its
guest finishes that task and the next one can be claimed. A VM that stops
without being asked (the guest powered itself off, QEMU crashed) is recorded
as STOPPED, and started again at once when its Dot still has work.

### 9.6 API

All routes require `Authorization: Bearer <api token>` (from
`~/.invisible-dots/config/api.token`, created at first start). The server
binds `127.0.0.1:8787` by default (`INVISIBLE_DOTS_LISTEN`). Every reader of
the token (the server, the command, the web server) reads it through one
function, `readApiToken()` in `packages/shared/src/api-token.ts`:
`INVISIBLE_DOTS_TOKEN` when set, otherwise the first line of `api.token`,
trimmed, and at least 16 characters.

```text
POST   /api/dots                     body: { config: <yaml string> | <object> }
GET    /api/dots
GET    /api/dots/:id
PATCH  /api/dots/:id                 body: { config }   (pushed to the guest if running)
DELETE /api/dots/:id                 destroys the VM and its disk, then deletes the Dot, its rows and its own secrets

POST   /api/dots/:id/messages        body: { text }
GET    /api/dots/:id/messages        conversation, from the event log (a user message carries `origin` when it came through a channel)
POST   /api/dots/:id/tasks           body: { description, priority?, scheduled_at? }
GET    /api/dots/:id/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/cancel

GET    /api/dots/:id/computer
POST   /api/dots/:id/computer/start
POST   /api/dots/:id/computer/stop
POST   /api/dots/:id/computer/reboot
GET    /api/dots/:id/computer/screenshot

GET    /api/dots/:id/browser-identities
POST   /api/dots/:id/browser-identities
GET    /api/dots/:id/browser-identities/:identityId
DELETE /api/dots/:id/browser-identities/:identityId

GET    /api/dots/:id/channels        { channels: [{ kind, enabled, status, status_detail, account, settings, peers, created_at }], available: [kind] }; never a token; `available` is what this server runs (WhatsApp only when it was started with it, section 9.8)
PUT    /api/dots/:id/channels/telegram  body: { token }   links the Dot to the bot (201), or gives the linked bot a new token (200); the token is checked with Telegram, stored encrypted, never returned
PATCH  /api/dots/:id/channels/:kind  body: { settings?: { approvals?, notify_tasks? }, enabled? }   enabled false pauses the channel, its people and token stay
POST   /api/dots/:id/channels/whatsapp/link   202 the channel's record, waiting: starts linking WhatsApp (400 when the server does not run it, 409 `already_linked`)
GET    /api/dots/:id/channels/whatsapp/qr   server-sent events of `ChannelLinkFrame` (`waiting`, `code`, then `linked` or `failed`, and the stream ends); never cached, never stored
DELETE /api/dots/:id/channels/:kind  unlink: the channel stops, its token (WhatsApp: the linked device's keys) and its people are deleted
POST   /api/dots/:id/channels/:kind/pairing   201 { code, deep_link, message, expires_at }: a one-time code, valid ten minutes; `message` is what to send the account to pair
DELETE /api/dots/:id/channels/:kind/peers/:peer   revoke a paired person

GET    /api/approvals                ?status=pending|approved|rejected|expired
POST   /api/approvals/:id/approve    body: { note? }
POST   /api/approvals/:id/reject     body: { note? }

GET    /api/dots/:id/events          ?after=<id>&limit=&types=<a,b>&task_id=   `types` are event type names (an unknown one is a 400), `task_id` keeps the events whose `data.task_id` it is
GET    /api/dots/:id/files/list      ?path=   { path, entries: [{ name, type, size, mtime }] }: a directory under /home/dot (home when omitted)
GET    /api/dots/:id/files           ?path=   the bytes of a file under /home/dot, at most 16 MiB (413 `file_too_large`)
GET    /api/dots/:id/automations     { automations: Automation[] }: the Dot's cron jobs (section 5.3); needs the computer running (409 `computer_stopped`)
PATCH  /api/dots/:id/automations/:automationId   body: { enabled }   pauses or resumes one; answers the automation
DELETE /api/dots/:id/automations/:automationId   204
GET    /api/dots/:id/tools           { tools: [{ name, permission, offered, description }] }: the engine's tool table and what the model is offered now; needs the computer running
GET    /api/dots/:id/usage           ?since=<ISO 8601 timestamp>   { dot_id, since, spent_usd }
GET    /api/stream                   SSE: every event, ?dot_id= to filter
PUT    /api/secrets/openrouter       body: { value, dot_id? }
GET    /api/health
GET    /api/doctor                   { ok, checks: [{ id, label, status: ok|missing|failed, detail, fix? }] }: the host report of section 11.1, run on the machine the server runs on
```

`GET /api/health` answers `{ status: "ok", database: "ok", version,
openrouter_configured }`; the last field is whether a global OpenRouter key is
stored, which `invisible-dots doctor` reports.

`GET /api/doctor` answers the report of section 11.1 as the server's own host
sees it, the same rows in the same order as `invisible-dots doctor --json`
(`{ ok, checks }`, `ok` true only when every check is). It runs QEMU's
accelerator probe, so it takes a moment and it is not polled.

`GET /api/dots/:id/usage` answers the model spend the Dot's guest reported, in
USD, since `since` (the first event when omitted; a malformed `since` is a 400).
The event log is its one source: it sums `spent_usd` over the events that end a
unit of spend, a task's `task.completed` and `task.failed` (each carries the
whole task) and the chat's `message.assistant` (each carries what the chat spent
since its last answer), by the
time the host stored them. `task.progress` is left out because its value is the
running total of a task that ends with one of those events. Work that never
reported an end (a cancelled task) is not in the
total; the task's own `spent_usd` still shows what was heard of it. Like
`/events`, it reads the history of a deleted Dot by id.

`GET /api/dots/:id/events` filters in the database: `types` is a comma-separated
list of type names, `task_id` matches `data->>'task_id'` (the one place the
contract puts the task, so the host's `task.created` and `task.cancelled` and
the guest's `task.*`, `tool.called` and `approval.requested` of a task all
match), and both combine with `after` and `limit`. A chat turn's events carry
no task. Migration `0007_events_task.sql` adds the expression index the task
filter reads. A type name no event has (`tool.calls`) is a 400, so a typo does not
look like a quiet Dot.

`GET /api/dots/:id/automations`, `PATCH` and `DELETE /api/dots/:id/automations/:automationId`
and `GET /api/dots/:id/tools` pass through to the engine's routes of section 5.3:
the cron jobs and the tool table are the engine's, and the control plane keeps no
copy of either. They need the computer running (`409 computer_stopped`), the
engine's own refusals pass through with their code and status, and a `PATCH` whose
`enabled` is not a boolean is a `400 invalid_request` before the guest is called.
A job the Dot makes with its `cron` tool needs the approval of `automations`
(`ask` by default), so a person sees an automation here only after approving it.

`GET /api/dots/:id/files/list` and `GET /api/dots/:id/files` read the Dot's
computer through dot-agentd's `GET /v1/files/list` and `GET /v1/files`, and
only under `/home/dot`: `path` is absolute, relative to `/home/dot` or `~`, and
the control plane normalizes it (`checkHomePath` in `packages/shared`) so the
guest always gets an absolute one; a path outside home, or with any `..` segment,
is a `400 invalid_path` without a call to the guest. The check is lexical:
dot-agentd runs as `dot`, so what a symbolic link inside home may lead to is what
`dot` may read anyway. A read is one buffered answer of at most 16 MiB; a larger
file is a `413 file_too_large` and the host stops reading it as soon as it passes
the limit. The bytes are the Dot's own (a model wrote them, perhaps after reading
hostile text) and the web server answers from the page's origin, so the type is
never one a browser runs: images are served as `image/png`, `image/jpeg`,
`image/gif` or `image/webp` inline, source and markup (`.md`, `.json`, `.html`,
`.svg`, ...) as `text/plain` inline, everything else as a download, always with
`nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `no-store`
(the web proxy passes those headers on). The guest's own refusals pass through
with their code (`404 not_found`, `400 is_a_directory`, `400 not_a_directory`).

Browser identity and file routes need the Dot's computer running: on a stopped
Dot they answer `409 { error: "computer_stopped" }`.

Errors are `{ error: <code>, message }` with a 4xx or 5xx status.

### 9.7 Web client

`apps/web` is a Next.js server on `127.0.0.1:3000`. It answers `/api/...` with
the control plane's own paths, so the browser uses the SDK unchanged, and
adds the API token on the way, so the browser never sees it. It holds that
token and listens on the host's loopback, which every guest reaches as
`10.0.2.2` (section 3.6), so it has a credential of its own:

- The person signs in once at `/login` with the API token. `POST /session`
  compares it with the token `readApiToken()` reads (in constant time) and
  answers with the cookie `idots_session`: an HMAC of the token, never the
  token itself, so it changes when the token does. It is `HttpOnly` (no
  script reads it) and `SameSite=Strict` (no other site's page makes the
  browser send it). `DELETE /session` clears it.
- Every proxied request without that session answers
  `401 { error: "login_required" }` with the header
  `x-invisible-dots-login: required`, before the API is contacted; the page
  then goes to `/login`.
- The Host, Origin and `Sec-Fetch-Site` checks stay in front of it, as a
  defence against DNS rebinding and cross-site pages only: they are written
  by the client, so they never let a request through on their own. The Host
  must be loopback or listed in `INVISIBLE_DOTS_WEB_ALLOWED_HOSTS`.

### 9.8 Messaging channels

A person can talk to a Dot from a chat (Telegram, WhatsApp). This is the control
plane's business only: the Dot never sees a channel, no guest route or event
type names one, and the Dot has no tool that sends a message anywhere.
`packages/channels` holds the **channel hub**, built in `startServer` right after
the Scheduler, started after `scheduler.start()` and closed before it. It runs in
the server process because the database is single-process (section 9.1) and the
credentials live in it. It uses only what the Scheduler offers: `sendMessage`
(with an origin), `resolveApproval`, `requireDot` and the event log.

An adapter (`Channel`) is transport only: `run(sink, signal)` connects and
delivers until aborted, `sendText`, `sendApproval` and `editApproval`, optionally `typing`. A `ChannelType` makes the
adapter for a binding and names the secrets a binding of its kind keeps (and which
of them are credentials a log line could hold, `scrubNames`). A kind that is
linked by scanning a code on a phone (`scanned`: WhatsApp) is linked with `link`
and never given credentials; the others with `add`. The hub owns every policy:

- **Who may talk.** Only a person paired with a one-time code, by the channel's
  stable id (a Telegram numeric user id, a WhatsApp phone number, never a mutable
  name). The code is eight
  symbols (40 bits), valid ten minutes, used once, stored as a SHA-256 hash with
  the binding id, and pairs the sender as an `owner` together with their chat.
  Anyone else, a chat that is not a private one, an empty message: dropped
  before anything is written, so a stranger costs no row and no model call. A
  paired person is held to a token bucket (10 messages at once, then 20 per
  minute, told once) and to 8000 characters per message.
- **Inbound.** A message becomes `Scheduler.sendMessage(dot, text, {channel,
  binding_id, chat_id, external_id})`; the guest receives `{text}` only. The
  channel's own message id is part of the `user.message` event, which a unique
  index allows once per Dot, binding and channel id, so the message and the proof
  that it was handed over commit together. `sink.inbound` resolves only after the
  control plane has answered, so an adapter commits its offset after the hub is
  done with the message. A redelivered message, after a failure at any point or
  across a restart, finds the first one: the Dot gets it once, and the repeat is
  answered with the first message.
- **Outbound.** One `events.stream({dotId}, {after: event_cursor})` per binding.
  `message.assistant` goes to the chat of the `user.message` its `in_reply_to`
  names, when that message came through this binding and its person is still
  paired; an answer that answers nothing (an automation's) goes to every owner's
  chat; an answer to a message from the web or another channel is not mirrored.
  `task.completed` and `task.failed` go to the owners unless `notify_tasks` is off.
  `agent.state` THINKING shows typing in the chat of the last message while the
  Dot has not answered it. Text is split at the adapter's `maxText` on paragraph,
  line and word boundaries. The cursor moves after a send succeeded (events that
  need no send are written in batches), so a restart resumes where it stopped;
  a crash between a send and the cursor write sends that message again. A send
  that fails is retried with backoff (a channel's `retry_after` is honoured); one
  the channel refuses for good (the person blocked the bot) is dropped.
- **Approvals.** When the Dot asks (`approval.requested`) and the binding's
  `approvals` setting is on, every owner's chat gets a prompt: the tool, its
  permission, the reason and the arguments, each cut to 300 characters (the
  arguments can hold private data, and a chat is read by a third party), with an
  Approve and a Reject button. Only a paired owner, in their private chat, can
  answer; the button's id proves nothing, so the hub also checks that the
  approval belongs to the binding's own Dot and that approvals are still asked
  in chats. The answer is `Scheduler.resolveApproval`, the one way an approval
  is answered, so a second press, or a press after the web answered, is the
  scheduler's 409 and the person is told it was answered already. The person
  always gets a short notice for the press. Every answer, whoever gave it,
  arrives as `approval.resolved` and edits the prompts to the outcome with the
  buttons taken away; `channel_prompts` remembers where each prompt is. The
  prompts are brought up to date when the channel starts, when a person pairs
  and when `approvals` is switched on: a prompt whose approval was settled
  meanwhile (answered elsewhere, or its task ended: "No longer needed") is
  edited, and a pending approval with no prompt in an owner's chat is sent one.
  Delivery is at least once like every send: a crash between sending a prompt and
  recording it sends it again. An approval over a chat is as strong as the
  person's Telegram account; switching `approvals` off keeps the answer in the
  app.
- **Answers in words.** A channel without buttons (`approvalByText`: WhatsApp)
  ends its prompt with `Reply "yes ap-xxxxxx" to approve or "no ap-xxxxxx" to
  reject`, where the token is the last six characters of the approval's id. The
  hub, not the adapter, reads a message that is exactly that, from a paired owner
  only (a stranger's message is dropped before anything is read, so a stranger is
  never answered), and resolves it with the same checks and the same
  `Scheduler.resolveApproval` as a button; the person is told "Approved.",
  "Rejected.", "It was answered already.", "That request does not exist." or that
  two requests share the code. Anything else, including a bare `yes`, is an
  ordinary message to the Dot: an answer given by a misread sentence would be an
  approval nobody meant.
- **Failure.** An adapter that fails is started again after an exponential backoff
  (1 s up to 60 s, with jitter) on a fresh instance; `ChannelNeedsRelinkError`
  (a revoked token, a logged-out device) stops it until the person relinks.
  Every change of status is a `channel.status` host event, once; the reason is
  cut to 300 characters and has the binding's credentials replaced, whatever
  the adapter wrote. A new binding starts after the Dot's latest event: history
  is not replayed into the chat. When the Dot is deleted its bindings go with it
  (foreign keys) and the hub stops the adapter on `dot.deleted`.
- **Credentials.** Stored as secrets scoped to the Dot, under the names the
  channel type declares, encrypted like the OpenRouter key, never returned,
  never pushed to the guest, deleted with the binding and with the Dot. A channel
  type may check credentials before anything is stored (`check`): Telegram asks
  `getMe`, so a wrong token is a 400 `invalid_credentials` (the message never
  holds the token), an unreachable Telegram a 502 `channel_unreachable`, and a
  bot another Dot already uses a 409 `account_in_use` (a bot serves one Dot: two
  pollers on one token take turns failing). Giving a linked channel a new token
  (`PUT`) starts it again with the people kept; it is the way back from
  `needs_relink`.

#### Telegram

`packages/channels/src/telegram/` is the adapter, on grammY (the Bot API client,
MIT). It is transport only, like every adapter.

- **Long polling**, because the control plane listens on a local address behind
  NAT and polling needs only outbound HTTPS. Telegram keeps an update that was
  not confirmed for 24 hours: a PC that is off for longer loses what was sent
  meanwhile. A webhook the bot had is deleted on connect (the bot is the Dot's
  own). Only `message` and `callback_query` updates are asked for.
- **An update is confirmed to Telegram** (the `offset` of the next poll) only after
  the hub dealt with it. When the hub could not record a message the adapter
  fails, the hub starts it again, and Telegram offers the update once more; the
  hub recognises one it already gave the Dot by its id, `<bot id>:<update id>`
  (update ids of two bots overlap, and a Dot's bot can be replaced). No offset is
  stored: a restart is the same as a failure.
- **Pairing.** `/start <code>` in a private chat is a pairing attempt; the deep
  link `https://t.me/<bot>?start=<code>` sends exactly that. A bare `/start` and
  everything a stranger sends get no answer. Only private chats are served.
  Authorization is the sender's numeric user id, never a username.
- **Approval buttons.** `callback_data` is `ap1:y:<approval id>` or
  `ap1:n:<approval id>` (47 bytes for `appr_<uuid>`): versioned, checked to fit
  Telegram's 64 bytes when the prompt is made (an id that does not fit is
  refused for good) and again when parsed, and parsed strictly, so data from
  another version or a forged shape is answered "This button is out of date"
  and goes no further. A press is confirmed to Telegram only after the hub dealt
  with it, like a message. The press is always answered (`answerCallbackQuery`)
  with the hub's notice, best effort: Telegram refuses an answer that is too
  old. An edit of a prompt that is gone or already says the same counts as done.
- **Messages.** Plain text, no formatting; a long answer is split at 4000
  characters. A message without text (a photo, a voice note) is answered "not
  supported yet" to a paired person and dropped. Typing shows while the Dot
  thinks.
- **Failures are told to the hub in words.** A 401 is a revoked token
  (`needs_relink`); a 409 on polling says another process polls the same bot; a
  403, 400 or 404 on send is final (the person blocked the bot), a 429 carries its
  `retry_after`, anything else is retried. The token is in every request URL, so
  no message the adapter makes carries a URL, and the hub replaces the binding's
  token in whatever it stores or logs. Retries and backoff are the hub's alone.
- **Not private.** Telegram bot chats are not end-to-end encrypted: Telegram can
  read what a person and the Dot write there. The CLI says so when a bot is linked.

From the CLI, `invisible-dots channel add telegram --dot <dot>` (token asked for in
a terminal or read from stdin, never from arguments), `channel list [--dot]`,
`channel pair <kind> --dot <dot>` (prints the deep link and the words to send) and
`channel remove <kind> --dot <dot>`.

#### WhatsApp (opt-in, unofficial)

`packages/channels/src/whatsapp-baileys/` is the adapter, on Baileys
(WhiskeySockets, MIT), a client of the WhatsApp Web protocol. **It is not an
official way to use WhatsApp.** It links the Dot as a device of a personal account,
which WhatsApp's terms do not allow for automation, and WhatsApp can answer by
restricting or banning the account. The library is a release candidate pinned to
one exact version (`7.0.0-rc14`; a test keeps `package.json` and the lock file at
the same exact version) because the protocol moves under it: when WhatsApp stops
accepting that release, WhatsApp stops working until the pin is moved. Use a number
of its own (a spare SIM or eSIM), never the one a person lives on. The official
Cloud API (a business account and a public webhook) is a later adapter on the same
hub.

- **Licenses.** Baileys is MIT, but it depends on `libsignal`, which is GPL-3.0.
  Neither is in this repository; the command bundle leaves Baileys out
  (`external` in `apps/cli/scripts/build.mjs`, checked by a test), so no build of
  ours embeds GPL code, and the server resolves it from `node_modules` when WhatsApp
  is linked. `THIRD_PARTY_NOTICES.md` says what that means for whoever
  distributes an installation.
- **Off by default.** The server runs WhatsApp only when started with
  `INVISIBLE_DOTS_WHATSAPP=1` (`defaultChannelTypes` in `apps/api/src/start.ts`).
  Otherwise the type does not exist: `GET .../channels` lists only the kinds it
  runs (`available`), and linking answers 400 with how to turn it on. Baileys is
  loaded by a dynamic `import()` when a connection opens, so a server that never
  links WhatsApp never loads it, and no file but `baileys.ts` and `auth-state.ts`
  names it (a test reads the sources).
- **One port.** `port.ts` is what the channel needs of a connection (messages in,
  text out, a code to scan, why it ended); `baileys.ts` implements it over
  the network and `FakeWhatsAppConnector` for tests, because WhatsApp cannot be
  faked. Everything WhatsApp-specific that is a decision is in `whatsapp.ts` and
  tested against the fake; the glue is tested for what it decides alone (how a
  message is read, how a close is understood) and for surviving a socket that
  cannot connect. The real network is not reached by any test.
- **Linking by a code.** `POST .../whatsapp/link` creates the binding without
  credentials and starts the adapter, which opens a connection that is not
  linked; WhatsApp sends a code every few seconds, shown on the phone under
  Settings, Linked devices, Link a device. `GET .../whatsapp/qr` streams the codes
  and the end as `ChannelLinkFrame`. The code is a way into the account for as long
  as it is shown, so it lives in memory only (`LinkSessions`): not in the
  database, not in an event, not in a log, not in a status, and the stream is
  `no-store`. A watcher that joins late gets the code on show now. The scan ends
  with `linked` and the number; a code that ran out before the scan, a device WhatsApp
  rejects or one removed on the phone ends with `failed` and `needs_relink`
  (`ChannelNeedsRelinkError`); a connection that is lost is retried by the hub with
  backoff. Linking again after a failure deletes every key of the old device first.
  WhatsApp asks for a new connection when a link finishes (status 515); the adapter
  opens it at once, and gives up after three in a row.
- **The keys are secrets.** The linked device's identity and Signal keys are an
  account takeover if they leak, so they are not the plaintext JSON files of
  Baileys' own helper: `AuthStore` implements Baileys' `AuthenticationState` over
  the encrypted `secrets` of the Dot, one secret for the credentials and one per
  group of keys (eleven; a `Record` over the library's own list of groups makes a
  group added by an upgrade a compile error), under the same AES-256-GCM and the
  same row-bound associated data as the OpenRouter key. A change is written (the
  credentials and the groups that changed, in one transaction, in order) before it
  is acknowledged to Baileys, so a crash leaves the state as it was or as it is
  now, never a step apart; a failed write is kept and tried again with the next.
  A closed store refuses every write, so a delete by the hub is final, and the
  write itself holds the binding row, so a session still open when the channel or
  its Dot is deleted cannot write its keys back afterwards (the write is refused
  as `ChannelGoneError`). They are never sent to the guest, and deleted with the
  channel and with the Dot.
- **Who is who.** WhatsApp addresses a person by phone (`<number>@s.whatsapp.net`)
  or by LID (`<id>@lid`), and may switch. The peer is the phone number when it is
  known from the address, from its twin address in the same message, or from what
  the account learned earlier (a local lookup that sends nothing to WhatsApp), and
  `lid:<id>` otherwise, so one person is one peer whichever address is used; the
  chat to answer is the matching address. The one edge: someone paired while only
  their LID was known, whose number is learned later, appears under the number and
  pairs again. Device and agent suffixes are dropped.
- **Reply-only.** Nothing is sent to a chat that did not write first: the hub sends
  only to paired people, and a person pairs by writing the code. A stranger is never
  answered, told they are refused, or sent a read receipt (the unread message of a
  chat is marked read just before the Dot answers that chat, from a bounded memory),
  so no stranger learns that the number is alive. Each send is preceded by a typing
  indicator and a pause of 0.4 to 1.5 seconds. The account does not announce itself
  online. No groups (WhatsApp is told to ignore every address that is not one
  person's, so those messages are neither decrypted nor seen), no broadcast, no
  channel posts, no messages the account wrote itself, no attachments (a paired
  person is told "not supported yet", as on Telegram). There is no way to send to a
  number that has not written.
- **Pairing.** `pair <code>` as a whole message; the link
  `https://wa.me/<number>?text=pair%20<code>` opens the chat with exactly that
  ready to send. The number is the account the adapter reported when it connected.
- **Approvals.** In words, as described above: the prompt is a message with the
  reply to send, and when the approval is settled the prompt is edited to the
  outcome (WhatsApp limits how long a sent message can be edited, about fifteen
  minutes, so the prompt of an old approval may keep its question; a late answer is
  told it was answered already).
- **At most once on the way in.** WhatsApp confirms a message to its sender when
  it arrives, not when the hub dealt with it, so unlike Telegram a message the hub
  could not record cannot be offered again. The adapter then drops the connection,
  the channel shows `error`, the hub reconnects, and the person writes again.
  Messages come one at a time, in order.
- **Not private, and not stable.** WhatsApp and the account's other devices see
  what the Dot writes; the account's owner sees the Dot as a linked device. Baileys
  follows a protocol WhatsApp does not publish: a release of it can stop working
  without notice, and nothing here can prevent a ban.

From the CLI, `invisible-dots channel link whatsapp --dot <dot>` prints the risk,
then each code as a QR for the terminal until the number is linked, then
`channel pair whatsapp --dot <dot>` prints the link and the words that pair.

## 10. Out of scope for this version

Snapshots and rollback, scheduled recurring jobs, MCP integrations beyond the
browser, remote desktop and interactive terminal, artifacts, backups, quotas,
network policies, multiple hosts, organisations and RBAC, macOS hosts. The
tables and states above leave room for them; nothing here pretends to
implement them.

## 11. Getting a host ready

The same four commands on every host:

```text
invisible-dots setup         get QEMU and its accelerator ready (may ask for administrator rights once)
invisible-dots doctor        check everything, print one line per check and the command that fixes a failure
invisible-dots image build   build the golden image and the runtime ISO (section 3.3)
invisible-dots server        run the control plane in the foreground
```

`invisible-dots server` is the one entry point of the control plane; no
other program starts it. It stops cleanly (closes the database, releases
`server.lock`) on Ctrl+C, a service manager's SIGTERM, a closed terminal
(SIGHUP, which Node also raises on Windows when the console window closes)
and Ctrl+Break on Windows (SIGBREAK): the same handler for all four.

The OpenRouter key is then stored with `invisible-dots secret openrouter`,
the same line on every host and in every shell: in a terminal it asks for the
key and reads one line, and piped it reads standard input. The key is never an
argument, so it never lands in a shell history or a process list.

### 11.1 doctor

Checks, in this order, each with `ok` / `missing` / `failed` and a fix line:
Node version; QEMU found (and its version, 8.2 or newer); `qemu-img` found;
the accelerator usable (Linux: `/dev/kvm` opens read-write; Windows: the
`HypervisorPlatform` optional feature is enabled, read without administrator
rights through `Get-CimInstance Win32_OptionalFeature`), confirmed by actually
running QEMU with `-nodefaults -no-user-config -machine q35 -accel <kvm|whpx>
-cpu host -display none -no-reboot -boot reboot-timeout=0` and seeing it exit
with code 0; the data directory, `INVISIBLE_DOTS_HOME`, a path QEMU can be
given (plain ASCII, no comma, section 3.2) with enough free space;
the golden image and runtime ISO present and matching their manifests; the
OpenRouter key stored. `doctor` never changes anything and creates nothing.
Exit code 0 only when every check is `ok`. On a host invisible_dots does not
run on, the accelerator rows say so, and the report still prints.

- The probe runs guest code instead of holding the machine before its first
  instruction: the empty machine's firmware finds nothing to boot,
  `reboot-timeout=0` makes it reset at once, and `-no-reboot` turns the reset
  into QEMU exiting with code 0. So exit code 0 means the accelerator opened
  AND ran the CPU model the Dots use; there is no monitor, the same as for a
  Dot. Measured with QEMU 8.2.2 and KVM: exit 0 after 0.2 s, and the firmware's
  debug port reads "No bootable device. Retrying in 0 seconds." then
  "Rebooting."; without either flag QEMU never exits. A probe still running
  after 30 s is killed and reported as a virtual CPU that does not run, with
  QEMU's first line of error output. Not measured with WHPX yet.
- The probe uses the Dots' machine type, not `-machine none`: QEMU 11.1 with
  WHPX aborts on `-machine none` (`X86_MACHINE` assertion, measured).
- The probe has the last word: when the host-side check says `missing` but
  QEMU starts with the accelerator, the accelerator row is `ok` and `setup`
  enables nothing. Measured on Windows 11: WHPX initialised while the
  `HypervisorPlatform` feature read as disabled (Virtual Machine Platform on).
- The OpenRouter key is read from the running server's `GET /api/health`,
  because only the server may open the embedded database (section 9.1). While
  the server is down that row is `failed`, with the command that starts it.
  Inside the server (`GET /api/doctor`) the row asks the Scheduler directly.
- One code runs the report in both places: `runDoctor` in
  `apps/vm-manager/src/doctor.ts`, over the real machine's
  `hostDoctorDeps()` and the images' rows of `apps/api/src/doctor.ts`; the CLI
  only renders it (`apps/cli/src/doctor/render.ts`). The wire types
  (`DoctorCheck`, `DoctorAnswer`) are in `packages/shared/src/api.ts`.

### 11.2 setup

`setup` runs `doctor`, then fixes only what is missing:

- **Windows**: downloads the official QEMU installer for the version pinned in
  `virtualization/qemu/windows.json` (URL and SHA-256) into a temporary
  directory as the normal user, verifies the hash, then asks for elevation
  ONCE (`Start-Process -Verb RunAs` on a generated PowerShell script) to run,
  in that single elevated session: `dism /online /enable-feature
  /featurename:HypervisorPlatform /all /norestart` when the feature is off, and
  the QEMU installer silently (its arguments, `/S`, come from the pin) when
  QEMU is missing. Nothing the elevated session runs or writes is in a place
  the normal user can change, because a program running as that user could
  swap an installer between its hash check and its start, plant a DLL next to
  it, or turn the result file into a link to anywhere. So the session creates
  a new directory directly under ProgramData whose ACL, set in the same call
  that creates it, lets only Administrators and SYSTEM write (the person may
  read), and refuses to go on if it existed or is not empty; it copies the
  installer there, hashes the COPY and runs the copy from that directory; it
  finds dism through the system directory Windows reports, never through an
  environment variable the user can set; and it writes the exit codes to a
  result file in that directory, which the normal session reads and then
  removes with the directory. Exit code 3010 from dism means a restart is
  required: `setup` says so and stops with exit code 5. The person restarts
  and runs `invisible-dots doctor`. The installer's Authenticode certificate is
  outside its validity period, so the pinned hash is the only trust anchor.
- **Linux**: prints and runs `sudo apt-get install -y qemu-system-x86
  qemu-utils` on apt-based systems (and prints the equivalent `dnf` / `pacman`
  line elsewhere instead of guessing), then checks `/dev/kvm`; if it is not
  accessible it prints `sudo usermod -aG kvm $USER` and that a new login is
  needed. `setup` refuses to run as root: it would check `/dev/kvm` as root and
  name root in that line, not the person who runs the server. It calls `sudo`
  itself for the one step that needs it, as Windows elevates its one step.
- The minimum of section 3.1 is 8.2 because Ubuntu 24.04's own
  `qemu-system-x86` is 8.2.2, so `setup` on the most common LTS installs a QEMU
  that `doctor` accepts; 8.2.2 was measured against the argv of section 3.4
  and the probe of section 11.1 (with KVM). Debian 13 ships 10.0.

The project never redistributes QEMU binaries: Windows gets the official
installer, Linux gets the distribution's package.

### 11.3 Licensing

The root LICENSE (MIT) covers this repository, except everything under
`invisible_engine_dots/`, which is under `invisible_engine_dots/LICENSE` (MIT) and the
nested notices next to the code they cover; `THIRD_PARTY_NOTICES.md` at the
root carries that license, the notices of the earlier TypeScript engine whose
text the history still holds (Open Multi-Agent, MIT), and names every nested
notice, and `invisible_engine_dots/UPSTREAM.md` records the version and commit
the fork comes from. The engine's source goes
onto the runtime disk with the fork's `LICENSE` and `UPSTREAM.md`
(`/opt/invisible-dots/engine/`). No list is written by hand, so it cannot
drift from the lockfile. QEMU (GPL-2.0) is installed
from the official Windows installer or the distribution's package and is only
ever run as a separate program; it is never linked into, bundled with or
shipped by this project. The guest operating system (the Ubuntu cloud image),
Node, `uv`, the browser engine, `invisible-playwright-mcp` with its Python
packages, and the Python packages the engine's lock
(`guest/image-builder/builder/engine-requirements.lock`) names are
downloaded from their publishers when a host builds its golden image, each
under its own license, as the wheels the publishers released. This project publishes no image (section
3.3); whoever copies a golden image to another machine takes on the license
terms of the components inside it.
