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
same database, the same data directory layout, the same commands. A
difference between the two is allowed only where the operating system makes
sameness impossible, and every such difference lives in ONE function that a
test covers. The complete list today:

| what | Linux | Windows | where |
|---|---|---|---|
| QEMU accelerator | `-accel kvm` | `-accel whpx` | `apps/vm-manager/src/host.ts` `accelerator()` |
| how `invisible-dots setup` installs QEMU and enables the accelerator | `sudo apt-get install` (or the distribution's equivalent, printed) | one UAC prompt: enables the Windows Hypervisor Platform feature and runs the official QEMU installer silently | `apps/cli/src/setup/` |
| file permission bits on secrets | `0600` | not enforced by the OS (documented limitation) | `packages/shared/src/files.ts` |

Never fall back silently: when the accelerator is missing, starting a VM fails
with a message that says which command fixes it. Software emulation (TCG) is
never used. macOS is not supported in this version: it needs an arm64 guest
image and an arm64 browser build, which are not wired.

## 2. Repository layout

```text
apps/
  api/             control-plane HTTP API + SSE; the server entry point
  scheduler/       task dispatcher, wake on work, sleep on idle
  vm-manager/      QEMU driver: overlays, seed and runtime ISOs, QEMU argv, QMP, port forwards
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
  openrouter-client/  the only LLM client
  agent-runtime/      state machine and the reasoning loop
  memory/             local SQLite state: conversation, memories, outbox
  task-runtime/       local task queue and lifecycle
  policy/             ALLOW / ASK / DENY engine
  tools/              tool registry: computer, files, memory tools
  browser-manager/    browser identities and their MCP sessions
virtualization/
  qemu/            the pinned QEMU version for Windows setup (installer URL + SHA-256) and argv notes
  cloud-init/      NoCloud templates
  images/          pinned base image metadata
tests/
  e2e/             end-to-end run against real VMs (local only, needs an accelerator)
docs/
```

There is no host installer script, no service unit and no container: the host
needs Node 24 and QEMU, and `invisible-dots setup` gets QEMU (section 11).

Everything under `apps/`, `packages/`, `guest-runtime/` and
`guest/invisible-dots-agent/` is TypeScript in one npm workspace. `dot-agentd`
is a Go module. Node 24 or newer everywhere (the guest uses the built-in
`node:sqlite`). Go 1.25 or newer.

The control plane runs as ONE process (`invisible-dots server`) that composes
`api`, `scheduler` and `vm-manager`. They are separate packages so that each
can be tested alone, not separate daemons. It runs in the foreground the same
way on every host; running it as a service is left to the person.

## 3. Host

### 3.1 Requirements

Linux or Windows on x86-64, Node 24, and QEMU 9.2 or newer
(`qemu-system-x86_64` and `qemu-img`) with its hardware accelerator usable:
`/dev/kvm` readable and writable by the user on Linux, the Windows Hypervisor
Platform feature enabled on Windows. No administrator rights are needed at run
time. `invisible-dots doctor` checks each item and names the command that fixes
it; `invisible-dots setup` performs those commands (section 11).

QEMU is found, in this order, at `INVISIBLE_DOTS_QEMU_DIR`, on `PATH`, and at
the default install location of the official Windows installer
(`C:\Program Files\qemu`). It is always invoked by absolute path once found.

### 3.2 Host filesystem

One directory, `INVISIBLE_DOTS_HOME`, default `~/.invisible-dots` on every
host (`%USERPROFILE%\.invisible-dots` on Windows):

```text
~/.invisible-dots/
  config/
    master.key                          32 random bytes: encrypts secrets in the database
    api.token                           bearer token for the API
  db/                                   the embedded PostgreSQL (PGlite) data directory
  images/
    noble-server-cloudimg-amd64.img     pinned by SHA-256 (virtualization/images/base.json)
    golden-<version>.qcow2              immutable, read-only
    runtime-<version>.iso               our code: agent bundle + dot-agentd + units
  vms/<dot_id>/
    disk.qcow2                          overlay, backing file = a golden image
    seed.iso                            NoCloud seed
    qmp.sock                            QMP control socket of the running VM
    qemu.pid                            pid file of the running VM
    serial.log                          the guest serial console
  logs/
```

Both hosts use the same layout and the same names; only the root differs, and
only because home directories differ.

### 3.3 Two images, two lifetimes

- The **golden image** carries the operating system and third-party software:
  Ubuntu 24.04, qemu-guest-agent, Xvfb and a minimal XFCE session, the libraries
  the browser needs, Node 24, `uv`, `invisible-playwright-mcp` at an exact
  version, and the browser engine already downloaded. It changes rarely. It is
  never modified once a VM uses it: a new one gets a new version in its name.
- The **runtime disk** (`runtime-<version>.iso`, attached read-only to every VM
  and mounted at `/opt/invisible-dots`) carries our code: the bundled
  `invisible-dots-agent`, the `dot-agentd` binary and the systemd units. A new
  version of our code is a new ISO and a VM restart, not a new golden image and
  not a rebuilt overlay.

Neither image is ever published by this project: the host builds both from
public sources (`invisible-dots image build`, code in `guest/image-builder/`),
with the same QEMU it runs Dots with. Both ISOs are written by
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
  -qmp unix:<vms/id/qmp.sock>,server=on,wait=off
  -serial file:<vms/id/serial.log>
  -display none -pidfile <vms/id/qemu.pid>
```

- No fallback: if `-accel` fails, the start fails and the error names the
  fix. If `-cpu host` is rejected by an accelerator, the error says so; it is
  not replaced by a guessed model without an explicit decision recorded here.
- QMP is a unix socket on every host (QEMU supports AF_UNIX on Windows), never
  TCP: QMP has no authentication, and a guest can reach the host's loopback
  through user networking (section 3.6).
- The VM process is spawned detached, so the control plane can restart without
  stopping Dots; on start it finds running VMs through their pid files and QMP
  sockets.
- Stop: QMP `system_powerdown`, then QMP `quit` after 60 s. State: QMP
  `query-status` when the socket answers, STOPPED when there is no live process.

### 3.5 Port forwards

`<guest_port>` is a free TCP port on 127.0.0.1, chosen at each start (bind to
port 0, read it, release it, pass it to QEMU; retried if QEMU reports the port
taken) and recorded in the `computers` table. A port is never a credential:
every request to a guest carries the Dot's token (section 5.1).

### 3.6 Networking and its limits

QEMU user-mode networking gives every Dot its own NAT with no bridge, no
administrator rights and the same behaviour on every host. Dots cannot reach
each other's guest addresses. A guest CAN reach services on the host's
loopback through `10.0.2.2`, which includes the control plane API and the other
Dots' forwarded ports: both require a bearer token the guest does not have,
and QMP is not on TCP. Nothing else should listen unauthenticated on the
host's loopback while Dots run; `invisible-dots doctor` cannot check that, and
this document says so.

## 4. Guest

### 4.1 Processes (systemd, all as user `dot` unless stated)

| unit | what |
|---|---|
| `qemu-guest-agent.service` | stock, root |
| `dot-desktop.service` | `Xvfb :0 -nolisten tcp` plus a minimal XFCE session on it |
| `dot-agentd.service` | the computer daemon; TCP port 1024 (reached only through the host's port forward) and a local unix socket |
| `invisible-dots-agent.service` | the Dot itself |

There is no long-running browser service. The agent starts one
`invisible-playwright-mcp` process per launched browser identity (section 6).

### 4.2 Guest filesystem

```text
/etc/invisible-dots/config.json     written by cloud-init: dotId, token (0600, owner dot)
/opt/invisible-dots/                the runtime ISO, read-only
/home/dot/
  workspace/  downloads/  documents/
  memory/                           long-term memory notes the Dot writes itself
  state/dot.db                      SQLite: conversation, tasks, memories, outbox, identities
  browsers/<identity_id>/
    profile/                        the browser profile
    mcp/                            INVISIBLE_MCP_HOME for that identity's server
    metadata.json                   id, name, createdAt, lastUsedAt, status, proxy (optional)
/run/invisible-dots/
  agentd.sock                       dot-agentd, local API for the agent (mode 0600, owner dot)
  agent.sock                        the agent's API, reached by dot-agentd's proxy
```

### 4.3 Secrets

The OpenRouter key is never written into the golden image, the runtime ISO or
the seed. After the guest reports healthy, the control plane pushes it over
the guest channel (`POST /v1/agent/secrets`) and the agent keeps it in memory only. A VM
that restarts asks for nothing: the control plane pushes it again on every
READY transition. The Dot's own token is the one secret in the seed; it only
authorizes requests to this one VM.

## 5. Host to guest protocol

### 5.1 Transport

HTTP/1.1 over TCP. `dot-agentd` listens on port 1024 inside the guest, and
QEMU forwards `127.0.0.1:<guest_port>` on the host to it (section 3.5). Node
calls `http.request({ host: "127.0.0.1", port })`, the same on every host.
Every request carries
`Authorization: Bearer <dot token>`; `dot-agentd` answers 401 to anything else.
Connections go host to guest only: the guest never connects to the host. Events
flow back over a stream the host opens (5.3).

### 5.2 dot-agentd routes (TCP port 1024, token required)

| method and path | body / query | answer |
|---|---|---|
| `GET /v1/health` | | `{ agentd: "ok", agent: <agent /health or {status:"down"}>, uptime_s }` |
| `GET /v1/system` | | `{ hostname, uptime_s, cpus, mem_total_bytes, mem_available_bytes, disk_total_bytes, disk_free_bytes }` |
| `POST /v1/exec` | `{ command, cwd?, timeout_ms? }` | `{ exit_code, stdout, stderr, timed_out }` (bash -lc, output capped at 1 MiB each) |
| `GET /v1/files` | `?path=` | file bytes |
| `PUT /v1/files` | `?path=`, body = bytes | `204` |
| `GET /v1/files/list` | `?path=` | `{ entries: [{ name, type: "file"\|"dir"\|"other", size, mtime }] }` |
| `GET /v1/screenshot` | | `image/png` of display `:0` |
| `* /v1/agent/<rest>` | | reverse proxy to `unix:/run/invisible-dots/agent.sock` at `/<rest>` |

The same routes, without `/v1/agent`, are served on `agentd.sock` for the agent
(no token: the socket is owned by `dot`, mode 0600). Paths in file routes are
resolved against `/home/dot` when relative.

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
| `POST /prepare-sleep` | | `204` after the state is flushed and browser sessions are closed |

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
note?}`, `system.event {name, data}`.

Outbound types: `agent.state {state}`, `message.assistant {text,
in_reply_to?}`, `task.started {task_id}`, `task.progress {task_id, text}`,
`task.completed {task_id, summary}`, `task.failed {task_id, error}`,
`approval.requested {approval_id, task_id?, tool, permission, arguments,
reason}`, `tool.called {task_id?, tool, permission, decision, ok,
duration_ms}`, `browser.identity.created|deleted|launched|closed {identity_id,
name}`, `memory.written {key}`.

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
  stdio with:
  `INVISIBLE_MCP_HOME=<identity>/mcp`, `INVISIBLE_MCP_SESSION_ID=<identity_id>`,
  `STEALTHFOX_PROFILE_DIR=<identity>/profile`, `STEALTHFOX_HEADLESS=0`,
  `DISPLAY=:0`, and `STEALTHFOX_PROXY` when the identity has a proxy. The
  browser therefore runs on the Dot's desktop and shows up in its screenshots.
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

`THINKING` is a model request in flight; `PLANNING` is the model's answer being
turned into tool calls; `EXECUTING` is a tool running. Every transition is an
`agent.state` event.

### 8.2 Work

The runtime is event driven. There is no polling loop. Work arrives as
`user.message` (a chat turn in the Dot's single persistent conversation) or
`task.created` (queued locally, run one at a time in priority order, then
creation order). A task ends when the model answers without tool calls
(`task.completed`, the answer is the summary), when it exceeds
`max_steps_per_task` (`task.failed`), or when an approval is rejected and the
model gives up.

### 8.3 Tools

Function names use `_` because OpenAI-style function names cannot contain
dots. Each tool declares the permission it needs.

| tool | permission | arguments |
|---|---|---|
| `computer_exec` | `computer.exec` | `command, cwd?, timeout_seconds?` |
| `computer_screenshot` | `computer.screenshot` | none (the image is sent to the model) |
| `files_read` | `files.read` | `path` |
| `files_write` | `files.write` | `path, content` |
| `files_list` | `files.read` | `path` |
| `memory_remember` | `memory.write` | `key, content` |
| `memory_search` | `memory.read` | `query` |
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

### 8.4 Policy

Every tool call goes through the policy engine before it runs. `allow` runs
it, `deny` returns an error result to the model, `ask` emits
`approval.requested`, moves to `WAITING_APPROVAL` and persists the pending call
in `dot.db`. `approval.received` with `approve` runs the call and resumes the
loop; `reject` returns "rejected by the user" (plus the note) to the model.

### 8.5 OpenRouter

`POST https://openrouter.ai/api/v1/chat/completions` with
`HTTP-Referer: https://github.com/feder-cr/dots` and `X-Title: invisible_dots`.
Tool calling in the OpenAI format, `tool_choice: "auto"`, no streaming.
Retries with exponential backoff on 429 and 5xx (at most 4 attempts, honouring
`Retry-After`). Images (screenshots) are sent as `image_url` parts with a
`data:image/png;base64,` URL. Tool results longer than 12000 characters are cut
with a marker. Usage (`prompt_tokens`, `completion_tokens`, `cost` when
OpenRouter reports it) is accumulated per task.

### 8.6 Memory

- Working memory: the conversation and the current task's messages in
  `dot.db`, trimmed to the last 40 messages plus the system prompt.
- Long-term memory: `memories(key, content, updated_at)` in `dot.db` with an
  FTS5 index; `memory_search` queries it. The system prompt lists the 20 most
  recently updated keys.
- Workspace memory: `/home/dot/workspace` and `/home/dot/memory`, reached
  through the file tools.

## 9. Control plane

### 9.1 Database (PostgreSQL)

PostgreSQL is the database on every host. By default it is PGlite (PostgreSQL
compiled to WebAssembly, `@electric-sql/pglite`) running inside the server
process with its data in `~/.invisible-dots/db`, so nothing has to be
installed. With `DATABASE_URL` set, the same migrations and the same queries
run against an external PostgreSQL 16 or newer through `pg`. The repositories
talk to one small interface (`query`, `transaction`) with two adapters; no SQL
differs between them, and the test suite runs against both.

Tables: `dots`, `computers`, `tasks`, `task_runs`, `events`, `approvals`,
`secrets`, `schema_migrations`. Migrations are plain SQL files applied in order
at start.

- `dots(id text pk, name text unique, config jsonb, status text, created_at, updated_at)`
- `computers(dot_id pk fk, vm_name, guest_port int, pid int, state text, golden_image text, runtime_image text, token_enc bytea, event_cursor bigint default 0, last_active_at, updated_at)`
- `tasks(id text pk, dot_id fk, description, priority int, status, created_at, scheduled_at, started_at, finished_at, summary, error)`
- `task_runs(id pk, task_id fk, started_at, finished_at, outcome)`
- `events(id bigserial pk, dot_id, type, data jsonb, source 'host'|'guest', guest_seq bigint, created_at)`, unique `(dot_id, guest_seq)`
- `approvals(id text pk, dot_id, task_id, tool, permission, arguments jsonb, reason, status 'pending'|'approved'|'rejected', note, created_at, resolved_at)`
- `secrets(scope text, name text, value_enc bytea, updated_at, pk(scope, name))`: `scope` is `global` or a dot id

Secrets are encrypted with AES-256-GCM under `master.key`. The OpenRouter key
is looked up as `(<dot_id>, openrouter_api_key)` first, then
`(global, openrouter_api_key)`.

### 9.2 Durable queue

The dispatcher claims work with
`SELECT ... FROM tasks WHERE status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= now()) ... FOR UPDATE SKIP LOCKED`,
one task per Dot at a time (a Dot with a `RUNNING` or `WAITING_APPROVAL` task
is skipped).

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

### 9.4 Create

`POST /api/dots` -> insert `dots` (CREATING) -> generate a token ->
`qemu-img create -f qcow2 -F qcow2 -b <golden> disk.qcow2 <disk>` -> write
`seed.iso` -> pick a guest port -> spawn QEMU (section 3.4) -> wait for health
-> push the secret -> `PUT /config` -> open the event stream -> READY.

### 9.5 Sleep and wake

When a Dot has no PENDING or RUNNING task, its agent state is IDLE, and nothing
happened for `idle_timeout`: `POST /v1/agent/prepare-sleep` -> QMP
`system_powerdown` (QMP `quit` after 60 s) -> STOPPED. Disk, identities and
memory stay. A new task or message for a STOPPED Dot starts the
VM, waits for READY and then delivers it.

### 9.6 API

All routes require `Authorization: Bearer <api token>` (from
`~/.invisible-dots/config/api.token`, created at first start). The server
binds `127.0.0.1:8787` by default (`INVISIBLE_DOTS_LISTEN`).

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

GET    /api/approvals                ?status=pending
POST   /api/approvals/:id/approve    body: { note? }
POST   /api/approvals/:id/reject     body: { note? }

GET    /api/dots/:id/events          ?after=<id>&limit=
GET    /api/stream                   SSE: every event, ?dot_id= to filter
PUT    /api/secrets/openrouter       body: { value, dot_id? }
GET    /api/health
```

Browser identity routes need the Dot's computer running: on a stopped Dot they
answer `409 { error: "computer_stopped" }`.

Errors are `{ error: <code>, message }` with a 4xx or 5xx status.

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

### 11.1 doctor

Checks, in this order, each with `ok` / `missing` / `failed` and a fix line:
Node version; QEMU found (and its version, 9.2 or newer); `qemu-img` found;
the accelerator usable (Linux: `/dev/kvm` opens read-write; Windows: the
`HypervisorPlatform` optional feature is enabled, read without administrator
rights through `Get-CimInstance Win32_OptionalFeature`), confirmed by actually
starting QEMU with `-accel <kvm|whpx> -machine none` and reading its exit; disk
space in `INVISIBLE_DOTS_HOME`; the golden image and runtime ISO present and
matching their manifests; the OpenRouter key stored. `doctor` never changes
anything. Exit code 0 only when every check is `ok`.

### 11.2 setup

`setup` runs `doctor`, then fixes only what is missing:

- **Windows**: downloads the official QEMU installer for the version pinned in
  `virtualization/qemu/windows.json` (URL and SHA-256) into a temporary
  directory as the normal user, verifies the hash, then asks for elevation
  ONCE (`Start-Process -Verb RunAs` on a generated PowerShell script) to run,
  in that single elevated session: `dism /online /enable-feature
  /featurename:HypervisorPlatform /all /norestart` when the feature is off, and
  the QEMU installer silently (`/S`) when QEMU is missing. Exit code 3010 from
  dism means a restart is required: `setup` says so and stops. The person
  restarts and runs `invisible-dots doctor`.
- **Linux**: prints and runs `sudo apt-get install -y qemu-system-x86
  qemu-utils` on apt-based systems (and prints the equivalent `dnf` / `pacman`
  line elsewhere instead of guessing), then checks `/dev/kvm`; if it is not
  accessible it prints `sudo usermod -aG kvm $USER` and that a new login is
  needed.

The project never redistributes QEMU binaries: Windows gets the official
installer, Linux gets the distribution's package.
