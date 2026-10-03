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
| how `invisible-dots doctor` reads the accelerator before probing it | `/dev/kvm` opens read-write | the `HypervisorPlatform` feature state through `Get-CimInstance` | `apps/cli/src/setup/install.ts` `checkAcceleratorAccess()` |
| how `invisible-dots setup` installs QEMU and enables the accelerator | `sudo apt-get install` (or the distribution's equivalent, printed) | one UAC prompt: enables the Windows Hypervisor Platform feature and runs the official QEMU installer silently | `apps/cli/src/setup/install.ts` `installHostPrerequisites()`, given the host's platform by `apps/cli/src/host.ts` |
| `setup` run as root | refused: it would check `/dev/kvm` as root and add root to the `kvm` group, not the person who runs the server; it calls `sudo` itself | there is no root; setup always runs as the normal user and elevates its one step | `apps/cli/src/setup/install.ts` `setupRefusal()` |
| a file or directory private to the user (`config/`, `master.key`, `api.token`, `db/`, the data directory) | mode `0600` / `0700` | an ACL with the current user alone, inheritance removed (`icacls`), because Windows ignores the mode bits and a directory under a drive root inherits "Authenticated Users: Modify" | `packages/shared/src/files.ts` `permissionBitsEnforced()` and `restrictToOwner()` |

One more branch exists only to let tests run on a Windows developer host:
`packages/shared/src/sockets.ts` `testSocketPath()` hands out a named pipe
there, because Node cannot serve a unix socket on Windows. The guest
code that serves sockets decides from the path (`socketIsAFile()`), never
from the platform. dot-agentd ships for linux/amd64 only, and the build
constraints of six of its files let its package compile and its tests run on a
Windows developer host; no shipped binary contains the `!unix` side:

- `setProcessGroup`: `guest/dot-agentd/internal/agentd/exec_unix.go`, `guest/dot-agentd/internal/agentd/exec_other.go`
- `listenUnixPrivate`: `guest/dot-agentd/internal/agentd/listen_unix.go`, `guest/dot-agentd/internal/agentd/listen_other.go`
- `diskUsage`: `guest/dot-agentd/internal/agentd/platform_unix.go`, `guest/dot-agentd/internal/agentd/platform_other.go`

`tests/repo/platform-branches.test.ts` reads every product source file
(TypeScript and JavaScript, the build scripts, the guest's shell scripts and
dot-agentd's Go) and fails on a platform check outside this list: Node's
platform and OS probes, `getuid`, the Windows path module, a platform name
as a string, Go's `runtime.GOOS`, build constraints and platform file name
suffixes.

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
  vm-manager/      QEMU driver: overlays, seed and runtime ISOs, QEMU argv, port forwards, the guest client, the host's one process runner
  web/             Next.js web client
  cli/             `invisible-dots`: setup, doctor, image build, server, and the API client commands
packages/
  shared/          types and schemas shared by host and guest: config, protocol, events, states
  database/        PostgreSQL schema (PGlite embedded or an external server), migrations, repositories, durable queue
  iso/             ISO 9660 + Joliet writer in plain TypeScript (seed and runtime disks)
  events/          event types, the host event log and its fan-out to SSE subscribers
  sdk/             typed HTTP client for the API (used by cli and web)
guest/
  invisible-dots-agent/   the Dot's main process (Node), bundled into one file
  dot-agentd/             the computer daemon (Go): the guest endpoint, exec, files, screenshots
  image-builder/          golden image and runtime disk builders (TypeScript), guest systemd units
guest-runtime/
  engine/             the agent engine: state machine, reasoning loop, policy gate, context budget, crash
                      recovery; derived in part from Open Multi-Agent (MIT, see THIRD_PARTY_NOTICES.md)
  openrouter-client/  the only LLM client
  memory/             local SQLite state: conversation, memories, outbox, intents, summaries
  task-runtime/       local task queue and lifecycle
  tools/              tool registry: computer, files, memory tools
  browser-manager/    browser identities and their MCP sessions
virtualization/
  qemu/            the pinned QEMU version for Windows setup (installer URL + SHA-256) and argv notes
  cloud-init/      NoCloud templates
  images/          pinned base image metadata
tests/
  repo/            checks over the whole repository (the platform branches of section 1.1)
  e2e/             end-to-end run against real VMs (local only, needs an accelerator)
docs/
```

There is no host installer script, no service unit and no container: the host
needs Node 24 and QEMU, and `invisible-dots setup` gets QEMU (section 11).

Everything under `apps/`, `packages/`, `guest-runtime/`,
`guest/invisible-dots-agent/` and `guest/image-builder/` is TypeScript in one
npm workspace. `dot-agentd`
is a Go module. Node 24 or newer everywhere (the guest uses the built-in
`node:sqlite`). Go 1.25 or newer.

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
it; `invisible-dots setup` performs those commands (section 11).

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
  Python environment, and the browser engine already downloaded. It changes
  rarely. It is never modified once a VM uses it: a new one gets a new version
  in its name.
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
  and mounted at `/opt/invisible-dots`) carries our code: the bundled
  `invisible-dots-agent`, the `dot-agentd` binary and the systemd units. A new
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
  `apps/vm-manager/src/runner.ts`): Windows can report a process gone before
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
| `invisible-dots-agent.service` | the Dot itself |

There is no long-running browser service. The agent starts one
`invisible-playwright-mcp` process per launched browser identity (section 6),
with an allowlist of its own environment (`allowlistedEnvironment()`, the same
filter as QEMU's on the host) plus the variables of section 6.

`dot` may run exactly one command as root, `/usr/bin/systemctl poweroff`
without a password, which is what dot-agentd starts when the host stops the
VM (section 5.2). The Dot's seed writes that rule; the golden image's builder
seed gives `dot` none and the provisioner removes any rule the image had,
because a Dot's seed only adds its rule to that file. Everything the model
runs (`computer_exec`, `POST /v1/exec`) therefore runs as `dot`. `dot` is in
the `systemd-journal` group, so it can read its computer's system journal;
the group is given where the user is created, by the image builder's seed,
because cloud-init adds no group to a user that exists already.

### 4.2 Guest filesystem

```text
/etc/invisible-dots/config.json     written by cloud-init: dotId, token (0600, owner dot)
/opt/invisible-dots/                the runtime ISO, read-only: the agent bundle, its THIRD_PARTY_NOTICES.txt, dot-agentd, the units
/home/dot/
  workspace/  downloads/  documents/
  memory/                           long-term memory notes the Dot writes itself
  state/dot.db                      SQLite: conversation, tasks, memories, outbox, identities, tool intents, context summaries
  browsers/<identity_id>/
    profile/                        the browser profile
    mcp/                            INVISIBLE_MCP_HOME for that identity's server
    metadata.json                   id, name, createdAt, lastUsedAt, status, proxy (optional)
/run/invisible-dots/
  agentd.sock                       dot-agentd, local API for the agent (mode 0600, owner dot)
  agent.sock                        the agent's API, reached by dot-agentd's proxy
```

One agent process owns `dot.db`: it opens it in SQLite's exclusive locking
mode and takes the write lock at once, so a second process on the same file
fails at open ("another agent owns ..."), and the kernel releases the lock
the moment the owner dies, so a restart opens it again without waiting.
Nothing else opens the file; the host reads the guest only through the
agent's API.

dot-agentd reads the Dot's home from `DOT_HOME` (default `/home/dot`; the
units do not set it). `INVISIBLE_DOTS_HOME` is the host's data directory
(section 3.2) and is never read in the guest: one name, one place.

### 4.3 Secrets

The OpenRouter key is never written into the golden image, the runtime ISO or
the seed. After the guest reports healthy, the control plane pushes it over
the guest channel (`POST /v1/agent/secrets`) and the agent keeps it in memory only. A VM
that restarts asks for nothing: the control plane pushes it again on every
READY transition, and an agent process that restarts inside a running VM
(systemd restarts it after a crash) announces itself with an `agent.started`
outbound event, on which the control plane pushes the key and the config
again. The Dot's own token is the one secret in the seed; it only
authorizes requests to this one VM.

"Memory only" keeps the key off every disk; it is not on its own what keeps
it from the commands the model runs, which run as the same user `dot`. What
does: `dot` cannot become root (section 4.1), so it cannot read another
process's memory through root; Ubuntu's Yama `ptrace_scope=1` lets a process
trace only its own descendants, and the model's commands descend from
dot-agentd, not from the agent; and the agent runs with `--disable-sigusr1`,
so no process of the same user can open Node's inspector in it. A change to
any of the three reopens the question.

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
| `* /v1/agent/<rest>` | | reverse proxy to `unix:/run/invisible-dots/agent.sock` at `/<rest>` |

The same routes, without `/v1/agent`, `/v1/proof` and `/v1/system/poweroff`,
are served on `agentd.sock` for the agent (no token: the socket is owned by
`dot`, mode 0600). Sleep, stop and reboot are the control plane's decisions,
and the agent's socket offers no poweroff. That is not a guarantee that a Dot
cannot power its own computer off: the model runs commands as `dot`, which
may run the same `systemctl poweroff`, and can read the token in
`/etc/invisible-dots/config.json`. A Dot owns its computer. What the control
plane guarantees is the outcome: a VM that stops without being asked is
recorded as STOPPED, and started again when its Dot has work (section 9.5).
Paths in file routes are resolved against `/home/dot` when relative.

### 5.3 invisible-dots-agent routes (reached as `/v1/agent/...`)

| method and path | body | answer |
|---|---|---|
| `GET /health` | | `{ status: "ok"\|"starting", state: AgentState, openrouter_configured: bool, browser: { identities: n, open: n } }` |
| `POST /secrets` | `{ openrouter_api_key }` | `204` |
| `PUT /config` | `DotRuntimeConfig` (section 7) | `204`, persisted in `dot.db` |
| `POST /events` | `InboundEvent` | `202 { accepted: true }` |
| `GET /events/stream` | `?after=<seq>` | `text/event-stream`, one SSE message per outbound event, `id: <seq>` |
| `GET /state` | | `{ state, current_task_id, pending_approval }` |
| `GET /browser-identities` | | `{ identities: BrowserIdentity[] }` |
| `POST /browser-identities` | `{ name, proxy? }` | `201 BrowserIdentity` |
| `GET /browser-identities/:id` | | `BrowserIdentity` |
| `DELETE /browser-identities/:id` | | `204` |
| `POST /prepare-sleep` | | `204` after the state is flushed and browser sessions are closed; the agent then starts no new work. A model request in flight is abandoned; a tool in flight gets up to 20 seconds to finish and record its result, then is aborted (section 8.7). A `POST /secrets` (the READY procedure of a VM whose stop failed, so no shutdown followed) lifts that, and so does a new inbound event |

Outbound events are written to an outbox table in `dot.db` before they are
streamed, with a monotonically increasing `seq`. The host stores the last `seq`
it saved per Dot and reconnects with `?after=`. Nothing is lost when the control
plane restarts or the VM sleeps.

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
in_reply_to?}`, `task.started {task_id}`, `task.progress {task_id, text}`,
`task.completed {task_id, summary}`, `task.failed {task_id, error}`,
`approval.requested {approval_id, task_id?, tool, permission, arguments,
reason}`, `tool.called {task_id?, tool, permission, decision, ok,
duration_ms, interrupted?}`, `browser.identity.created|deleted|launched|closed
{identity_id, name}`, `memory.written {key}`. `interrupted: true` marks a call
the agent stopped during: its outcome is unknown and it was not run again, so
`ok` is false and `duration_ms` is 0.

The `arguments` of `approval.requested` are what the person decides on, and
they leave the guest: a tool argument that carries a secret is redacted there
by the tool's own rule (`redactToolArguments()`, `packages/shared/src/tools.ts`;
today the password in a `browser_identity_create` proxy URL). The pending call
in `dot.db` keeps the full arguments, so an approval runs the call as asked.

An outbound event is handed to the event stream only after the transaction
that wrote it to the outbox committed: one written inside a transaction that
rolls back is never streamed, so its `seq` cannot reach the host and then be
reused for another event.

The control plane adds its own: `dot.created`, `dot.updated`, `dot.deleted`,
`computer.state {state}`, `computer.started`, `computer.stopped`,
`task.created`, `task.cancelled`, `approval.resolved`.

## 6. Browser identities

- An identity is a directory under `/home/dot/browsers/<identity_id>/`. Its id
  is a slug of its name plus a short random suffix. The guest's `dot.db` is the
  only record of which identities exist; the host never mirrors the list, it
  asks the guest.
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
models:                                # optional extra roles, all OpenRouter
  fast: openai/gpt-5-mini
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
  max_cost_per_task_usd: 1.00          # model spend of a task or a chat turn, 0.01..100 (section 8.2)
```

Defaults for permissions not listed: everything under `computer.*`,
`files.*`, `browser.*` and `memory.*` is `allow`, except
`browser.identity.delete` which is `ask`. Any permission name the registry does
not know is `deny`.

`DotRuntimeConfig` (what `PUT /config` sends to the guest) is the same object
minus `computer`.

## 8. Agent runtime

### 8.1 States

`IDLE -> THINKING -> PLANNING -> EXECUTING -> (THINKING | WAITING_APPROVAL) -> DONE -> IDLE`

`DONE` follows a failed unit as well as a completed one. `THINKING` is a model request in flight; `PLANNING` is the model's answer being
turned into tool calls; `EXECUTING` is a tool running. Every transition is an
`agent.state` event.

### 8.2 Work

The runtime is event driven. There is no polling loop. Work arrives as
`user.message` (a chat turn in the Dot's single persistent conversation) or
`task.created` (queued locally, run one at a time in priority order, then
creation order). A task ends when the model answers without tool calls
(`task.completed`, the answer is the summary), or when an approval is
rejected and the model gives up. It fails (`task.failed`, with a reason the
owner can read) when it exceeds `max_steps_per_task`; when its spend reaches
`max_cost_per_task_usd` (checked before every model request, the usage of
summary and flush calls included, and persisted with every response, so the
cap holds across a restart; a model that reports no cost is logged once and
the step limit still holds); when the same tool calls return the same
results three rounds in a row a second time (the first time, the model gets
a notice; the streak and the notices are read from the unit's own messages);
when its context budget is too small for the current step (section 8.6); or
after three failed attempts at one step (section 8.7). A chat turn has the
same limits, its cost counted per turn; a failed chat turn answers "I could
not answer: ...".

### 8.3 Tools

Function names use `_` because OpenAI-style function names cannot contain
dots. Each tool declares the permission it needs, and whether it is
replay-safe: running it twice with the same arguments has the effect of
running it once. Only a replay-safe call may run again when a crash leaves its
outcome unknown. `browser_navigate` is not: a GET can consume a one-time link
or confirm an action, and the profile keeps its cookies across a restart.

| tool | permission | replay | arguments |
|---|---|---|---|
| `computer_exec` | `computer.exec` | no | `command, cwd?, timeout_seconds?` |
| `computer_screenshot` | `computer.screenshot` | yes | none (the image is sent to the model) |
| `files_read` | `files.read` | yes | `path` |
| `files_write` | `files.write` | yes | `path, content` |
| `files_list` | `files.read` | yes | `path` |
| `memory_remember` | `memory.write` | yes | `key, content` |
| `memory_search` | `memory.read` | yes | `query` |
| `browser_identity_list` | `browser.identity.list` | yes | none |
| `browser_identity_create` | `browser.identity.create` | no | `name, proxy?` |
| `browser_identity_delete` | `browser.identity.delete` | no | `identity_id` |
| `browser_identity_launch` | `browser.identity.launch` | yes | `identity_id` |
| `browser_identity_close` | `browser.identity.close` | yes | `identity_id` |
| `browser_navigate` | `browser.navigate` | no | `identity_id, url` |
| `browser_snapshot` | `browser.read` | yes | `identity_id` |
| `browser_read_text` | `browser.read` | yes | `identity_id, selector?` |
| `browser_click` | `browser.act` | no | `identity_id, selector` |
| `browser_click_at` | `browser.act` | no | `identity_id, x, y` |
| `browser_type` | `browser.act` | no | `identity_id, selector, text` |
| `browser_press_key` | `browser.act` | no | `identity_id, key` |
| `browser_scroll` | `browser.act` | no | `identity_id, direction: "up"\|"down"` (PageUp / PageDown) |
| `browser_back` / `browser_forward` / `browser_reload` | `browser.act` | no | `identity_id` (Alt+Left, Alt+Right, F5) |
| `browser_screenshot` | `browser.read` | yes | `identity_id` (the image is sent to the model) |

Browser actions on an identity that is not open launch it first. When
`managed_by_dot` is false, the `browser_identity_create` and
`browser_identity_delete` tools are not offered at all.

The tool calls of one response run one at a time, in the order the model
gave them. Only the response's `tool_calls` count: a call written in the
assistant's text runs nothing. The registry validates a call's arguments and
cuts its text at 12000 characters, once.

### 8.4 Policy

Every tool call goes through the policy gate before it runs: a pure function
of the current config, and the only place that denies a tool the config does
not offer. `allow` runs it, `deny` returns an error result to the model, `ask`
emits `approval.requested`, moves to `WAITING_APPROVAL` and persists the
pending call in `dot.db`, keyed by its position (the assistant message and the
call's index in it). A call that needs approval stops the round: later calls
of the same response wait for the decision. `approval.received` with `approve`
runs the call, with the arguments of the pending row, and resumes the loop;
with a note, the note follows the call's result. `reject` returns `Rejected by
the user: <note>` (or `Rejected by the user.`) to the model. A decision is
recorded once: a second one for the same approval is ignored. An approved call
runs at most once, or at most twice when its tool is replay-safe and the agent
crashed during it (section 8.7). The memory flush before a summary (section
8.6) goes through this policy: its `memory_remember` calls run only when
`memory.write` is `allow`.

### 8.5 OpenRouter

`POST https://openrouter.ai/api/v1/chat/completions` with
`HTTP-Referer: https://github.com/feder-cr/dots` and `X-Title: invisible_dots`.
Tool calling in the OpenAI format, `tool_choice: "auto"`, no streaming. A
response cut by the output limit (`finish_reason: "length"`) has none of its
tool calls executed: it is stored without them, followed by a notice asking
the model to reply again more briefly, and it counts as a step.
Retries with exponential backoff on 429 and 5xx (at most 4 attempts, honouring
`Retry-After`). Images (screenshots) are sent as `image_url` parts with a
`data:image/png;base64,` URL. Tool results longer than 12000 characters are cut
with a marker. Usage (`prompt_tokens`, `completion_tokens`, `cost` when
OpenRouter reports it) is accumulated per task, the usage of the summary and
memory-flush calls of section 8.6 included (they count toward cost, not
steps).

### 8.6 Memory

- Working memory: the thread is append-only in `dot.db`; what is sent is
  bounded by `limits.context_tokens`. A request is the system prompt, the
  unit's start message (the task's seed, or the chat turn's user message,
  always kept whole), the newest summary of the thread (`context_summaries`),
  and the thread after that summary; the thread is never read whole. The
  estimate covers the system prompt, the tool definitions, the messages and
  each image (1600 tokens); characters count as tokens at the larger of 1/3
  and the ratio the provider last reported for the model. Building stops as
  soon as the estimate is at or under 0.75 of the budget: first, tool results
  the model has already processed become `[Tool result of <tool>: <n>
  characters, already processed]`, the largest first (the oldest first among
  equals), never one under 1000 tokens (`MIN_PLACEHOLDER_TOKENS`: a short
  result costs little and is often the very value a later step needs, such as
  a code looked up at the start of a task) and never in the newest round,
  and only the newest three images are sent; then a summary of the older part
  of the thread, cut where no call is separated from its results and so the
  part kept verbatim fits in 0.35 of the budget, made by the unit's model in
  requests of at most 0.5 of the budget and stored capped at 0.15 of it (a
  failed or cut summary falls back to a mechanical digest, capped the same
  way); before the summary, when memory is on and the policy allows
  `memory.write`, a memory-flush turn lets the model save what it still needs
  with `memory_remember`, if that request itself fits; then the largest
  results of the newest round are shrunk, head and tail. A summary is also
  made once 200 messages follow the newest one. A request still above 0.9 of
  the budget is never sent: the unit fails with "the context budget
  (limits.context_tokens = N) is too small for the current step".
- Long-term memory: `memories(key, content, updated_at)` in `dot.db` with an
  FTS5 index; `memory_search` queries it. The system prompt lists the 20 most
  recently updated keys.
- Workspace memory: `/home/dot/workspace` and `/home/dot/memory`, reached
  through the file tools.

### 8.7 Crash recovery

The agent can die at any point (a crash, a kill, a power cut) and systemd
starts it again. What it guarantees:

- One process owns `dot.db` (section 4.2).
- Every commit point is one transaction that includes the outbox rows
  describing it: the assistant's message with the step and its usage; a
  call's intent, before the call starts; a call's result with its
  `tool.called`, once the call returned; the end of a unit.
- An intent left without a result is a call the agent stopped during. When a
  unit is entered (a start, a resume after `POST /secrets` or after an
  approval), such a call is run again only if its tool is replay-safe
  (section 8.3) and it was started once; otherwise it gets the result "This
  call was interrupted before its result was recorded. It may have taken
  effect, and it may still be running. Check the current state before calling
  it again." (plus, for an approved call, that the approval was used), and
  `tool.called` with `interrupted: true` and the permission and decision of
  its time. "May still be running" is literal: `computer_exec` keeps running
  in dot-agentd until its own timeout.
- So a call that is not replay-safe runs at most once, and the model is told
  whenever its outcome is unknown; a replay-safe call runs at least once and
  at most twice. `tool.called` is written exactly once per call. `agent.state`
  and the events a tool emits itself (`memory.written`, `browser.identity.*`)
  are at-least-once: a call run again emits them again.
- A unit can end between a response and the results of its calls (a failed
  write, a failure, a cancel). The transaction that ends it answers every call
  of the newest assistant message that has no result: `Not executed: the unit
  ended before this call ran.`, or the interrupted result for a call that had
  started; and it deletes the thread's intents. A thread never keeps a call
  without its result, which the provider would refuse on every later turn;
  the request builder only asserts it, and fails the unit if it is broken.
- Stopping: `POST /prepare-sleep` and SIGTERM abandon a model request in
  flight and give a tool in flight up to 20 seconds to finish and commit its
  result, which leaves 10 of systemd's `TimeoutStopSec=30` to close the
  browsers and checkpoint the database. A tool cut at the grace keeps its
  intent, and the next entry of its unit, in this process or the next,
  reports it as interrupted (or runs it again, if it is replay-safe).
- The first start on this engine (marked by a config row, not by the
  migration, so a crash between the two cannot skip it) applies the inbound
  events the previous version accepted but never applied, gives old approvals
  the position of their call, answers the calls the previous version left
  open (removing from their message, as never run, those that sit in the
  middle of a thread where no result can follow them), and gives the active
  unit's first open call an intent unless its approval shows it never ran.
- Each attempt of a step (its memory flush and summary, if any, and its model
  request) is counted, in its own transaction, before it starts; the
  assistant's commit and a summary's commit reset the count. A step whose
  fourth attempt would start fails its unit with "stopped: the model request
  failed to complete 3 times", so a response whose commit kills the process is
  paid for at most three times. An attempt the agent abandons on purpose (a
  sleep, a cancel) does not count.

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
`inbound_events`, `secrets`, `schema_migrations`. Migrations are plain SQL
files applied in order at start.

- `dots(id text pk, name text unique, config jsonb, status text, created_at, updated_at)`
- `computers(dot_id pk fk, vm_name, guest_port int null, pid int null, state text, golden_image text, runtime_image text, token_enc bytea, event_cursor bigint default 0, last_active_at, last_error, updated_at)`: `guest_port` and `pid` are null while no QEMU runs, and `guest_port` is not unique (a crashed VM's row may name a port since reused); both are copies of `qemu.json` (section 3.2), which wins on reconciliation
- `tasks(id text pk, dot_id fk, description, priority int, status, created_at, scheduled_at, started_at, finished_at, summary, error)`
- `task_runs(id pk, task_id fk, started_at, delivered_at, finished_at, outcome)`: `delivered_at` is set when the guest accepted the run's `task.created`
- `events(id bigserial pk, dot_id, type, data jsonb, source 'host'|'guest', guest_seq bigint, created_at)`, unique `(dot_id, guest_seq)`
- `approvals(id text pk, dot_id, task_id, tool, permission, arguments jsonb, reason, status 'pending'|'approved'|'rejected'|'expired', note, created_at, resolved_at)`: an approval whose task reached a terminal state before anyone decided is `expired`, in the same statement that ends the task, and an `approval.requested` for a task that is already terminal is stored as `expired`, never `pending`
- `inbound_events(seq bigserial pk, id text unique, dot_id fk, type, data jsonb, ts, task_id, run_id, created_at, sent_at, delivered_at, dropped_at, drop_reason, failures int, last_error, retry_at)`: the outbox of host to guest events (section 9.2)
- `secrets(scope text, name text, value_enc bytea, updated_at, pk(scope, name))`: `scope` is `global` or a dot id

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
DELETE /api/dots/:id                 destroys the VM and its disk

POST   /api/dots/:id/messages        body: { text }
GET    /api/dots/:id/messages        conversation, from the event log
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

GET    /api/approvals                ?status=pending|approved|rejected|expired
POST   /api/approvals/:id/approve    body: { note? }
POST   /api/approvals/:id/reject     body: { note? }

GET    /api/dots/:id/events          ?after=<id>&limit=
GET    /api/stream                   SSE: every event, ?dot_id= to filter
PUT    /api/secrets/openrouter       body: { value, dot_id? }
GET    /api/health
```

`GET /api/health` answers `{ status: "ok", database: "ok", version,
openrouter_configured }`; the last field is whether a global OpenRouter key is
stored, which `invisible-dots doctor` reports.

Browser identity routes need the Dot's computer running: on a stopped Dot they
answer `409 { error: "computer_stopped" }`.

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

The root LICENSE (MIT) covers this repository, except the files under
`guest-runtime/engine/` that carry the Open Multi-Agent header, which are under
`guest-runtime/engine/LICENSE` (MIT as well); `THIRD_PARTY_NOTICES.md` at the
root carries that notice, and `guest-runtime/engine/UPSTREAM.md` records the
version and commit they come from. The guest agent is one bundled file; its
build writes `THIRD_PARTY_NOTICES.txt` next to it from esbuild's metafile,
with the license and notice files of every npm package an input comes from,
this repository's license and Open Multi-Agent's, and the runtime disk
carries it next to the agent (`/opt/invisible-dots/THIRD_PARTY_NOTICES.txt`),
so the notices travel with every copy of the bundle. No list is written by
hand, so it cannot drift from the lockfile. QEMU (GPL-2.0) is installed
from the official Windows installer or the distribution's package and is only
ever run as a separate program; it is never linked into, bundled with or
shipped by this project. The guest operating system (the Ubuntu cloud image),
Node, `uv`, the browser engine and `invisible-playwright-mcp` with its Python
packages are downloaded from their publishers when a host builds its golden
image, each under its own license. This project publishes no image (section
3.3); whoever copies a golden image to another machine takes on the license
terms of the components inside it.
