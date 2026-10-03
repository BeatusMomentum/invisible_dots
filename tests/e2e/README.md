# End-to-end run

`tests/e2e/run.ts` is the product's acceptance test: it builds the images,
starts the control plane, creates a Dot with a real QEMU VM on a real
accelerator, and has it do real work through OpenRouter. It drives the product
only from the outside, through the `invisible-dots` command and the HTTP API
(docs/architecture.md section 9.6), and reads nothing but the documented data
directory (section 3.2). It imports nothing from the workspace.

It is not part of `npx vitest run` and not part of CI: it needs a hardware
accelerator, about 15 GB of disk, network access, 20 to 60 minutes the first
time, and an OpenRouter key that it spends a few cents of.

## What it checks

| step | what |
|---|---|
| a | `invisible-dots doctor`: Node, QEMU, qemu-img, the accelerator and its probe are ok |
| b | `invisible-dots image build`: the golden image and the runtime ISO exist and hash to their manifests; doctor agrees |
| c | `invisible-dots server` in the background; the OpenRouter key stored through `invisible-dots secret openrouter` (stdin) |
| d | a Dot created from YAML (`invisible-dots create`) is READY; its `qemu.json` matches the computer record; `doctor` exits 0; a chat message gets a reply |
| e | a task creates the browser identity `research`, opens https://example.com, writes the heading to `~/workspace/heading.txt` and remembers it; the events, the identity list and the file's SHA-256, computed in the guest and compared with that of `Example Domain`, prove each part |
| f | `GET /api/dots/:id/computer/screenshot` returns a PNG (saved as `screenshot.png`) |
| g | with `files.write: ask`, a task stops at `approval.requested`, `invisible-dots approve` releases it, it completes, and the file holds exactly what was approved (by SHA-256) |
| h | the server restarts and adopts the running VM (same pid); `invisible-dots computer stop` reaches STOPPED with QEMU gone, through the guest's own poweroff (`computer.stopped` says `forced: false`, in well under the 60 s after which QEMU is killed); `start` reaches READY; the identity is launched again and its `.stealth-identity.json` is unchanged (by SHA-256); `heading.txt` (by SHA-256), the memory and the conversation are all still there; the guest's whole system journal, read inside the guest, holds no OpenRouter key |
| i | with `computer.exec: ask`, a task stops at an approval; the agent process is ended inside the guest (`pkill -9` through `POST /v1/exec`); systemd restarts it, the host re-pushes key and config (a second `agent.started`), the same approval is still pending; approved with a note, the task completes and a counter file proves the command ran exactly once |
| j | a task runs a slow `computer_exec`; while it is in flight the agent process is ended the same way; after the restart the Dot's event log has a `tool.called` with `interrupted: true` for that call, and a marker file proves the command itself ran once |
| k | the key is in none of the Dot's event and approval rows (read back decompressed through the API) and, once the Dot is stopped, in none of its files: the overlay disk, the seed, the serial log and QEMU's log |
| l | `DELETE /api/dots/:id` removes the Dot, its QEMU process and `vms/<id>` |
| m | the key is in no event row read back after the delete, and in no file of the run's logs, `logs/` or the embedded database's directory |

Steps i and j reach dot-agentd directly (`127.0.0.1:<guest_port>`, the proof
handshake, the Dot's token read from its seed) to do to a guest what the
model is not allowed to do to its own computer: end the agent process and
check that systemd brings it back and the engine resumes from `dot.db`.

The key checks report only "found" or "not found" and where, never any part
of the key. They look for its first 12 characters; the journal check of step
h looks inside the guest for the `sk-or-` prefix every OpenRouter key has
(the run refuses a key without it), without giving the model any part of the
key, and is only accepted when the guest proves it read the system journal.
Large rows are compressed inside the database's files, which is why step k
reads them through the API as well as step m scanning the files. The guest's
journal compresses large entries too, which is why step h reads it inside the
guest besides step k scanning the disk.

A file the Dot wrote is checked by having the Dot hash it in the guest
(`printf '%s' "$(cat <file>)" | sha256sum`, so a trailing newline does not
count) and comparing with the hash of the expected text on the host: the
model only relays a value it cannot make up.

The run stops at the first failing step. Everything it writes goes to
`E2E_LOG_DIR` (default `tmp/e2e/<UTC time>/`, ignored by git): `cli.log` (every
command and its output, never the key), `server.log`, `image-build.log`,
`events.txt` (the Dot's event log, rewritten after every step, so it is there
when a step fails), `screenshot.png`, `serial.log` of the Dot, and
`summary.json` / `summary.txt`
with each step's result and duration. Dots it creates are named `e2e-...`; a
later run deletes the ones an earlier failed run left behind.

## On a Linux host

What the host needs is what docs/architecture.md section 3.1 lists, plus Go
to build dot-agentd from source:

```bash
sudo apt-get install -y qemu-system-x86 qemu-utils   # or: invisible-dots setup
sudo usermod -aG kvm "$USER"                          # then log in again
# Node 24 from https://nodejs.org, Go 1.25 or newer from https://go.dev

git clone https://github.com/feder-cr/dots && cd dots
npm ci
npm run build --workspace guest/invisible-dots-agent --workspace apps/cli
(cd guest/dot-agentd && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/dot-agentd ./cmd/dot-agentd)

# The key goes in a file only you can read; the run never prints it.
install -m 600 /dev/null ~/openrouter.key && $EDITOR ~/openrouter.key

INVISIBLE_DOTS_HOME=~/.invisible-dots-e2e \
E2E_OPENROUTER_KEY_FILE=~/openrouter.key \
node tests/e2e/run.ts
```

A separate `INVISIBLE_DOTS_HOME` keeps the run away from your own Dots. The
run starts `invisible-dots server` itself on the default address
(`127.0.0.1:8787`), so stop any server already running on that home or port,
or set `INVISIBLE_DOTS_LISTEN` and `INVISIBLE_DOTS_URL` together. Optional
settings: `E2E_LOG_DIR`, `E2E_MODEL` (default `z-ai/glm-5.3-flash`) and
`E2E_CLI` (default `apps/cli/dist/invisible-dots.mjs`).

The images stay in `INVISIBLE_DOTS_HOME/images`, so a second run skips the
image build (`image build` finds images with the same inputs and does
nothing) and takes about 15 minutes.

## In a container, when the host cannot run it directly

`linux-host/Dockerfile` is a stand-in Linux host for machines that have
`/dev/kvm` but cannot install QEMU or use sudo (for example WSL). It is test
harness only, never a way to run the product. Its image has exactly what an
Ubuntu 24.04 user installs: the distribution's QEMU, CA certificates and Node
24 from the official tarball (checked against `SHASUMS256.txt` and a pinned
hash). Nothing else, so the run fails if the product starts to need another
host program. It runs as an ordinary user that reaches `/dev/kvm` through the
device's group, as on a real host; no `--privileged`.

```bash
# dot-agentd needs Go, which the host image deliberately lacks
docker run --rm -v "$PWD/guest/dot-agentd:/src" -w /src \
  -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH=amd64 -e GOFLAGS=-buildvcs=false \
  golang:1.26 go build -trimpath -o bin/dot-agentd ./cmd/dot-agentd

docker build -t idots-linux-host tests/e2e/linux-host
docker run -d --init --name idots-e2e \
  --device /dev/kvm --group-add "$(stat -c %g /dev/kvm)" \
  -v "$PWD:/src:ro" \
  -v ~/openrouter.key:/run/secrets/openrouter:ro \
  -v idots-e2e-home:/data -v idots-e2e-work:/work \
  -e INVISIBLE_DOTS_HOME=/data/home \
  idots-linux-host sleep infinity

# Copies the read-only checkout to /work/dots, runs npm ci for Linux and builds.
docker exec idots-e2e bash /src/tests/e2e/linux-host/prepare.sh
docker exec -w /work/dots -e E2E_OPENROUTER_KEY_FILE=/run/secrets/openrouter \
  -e E2E_LOG_DIR=/work/logs/run idots-e2e node tests/e2e/run.ts
```

`--init` is required. QEMU is spawned detached, so when the server that
started it exits (step h restarts it), QEMU's parent becomes process 1. On a
real host that is init or a session's subreaper, which reaps QEMU when it
exits; in a container without `--init` it is `sleep`, which never does, so a
powered-off QEMU stays a zombie, `process.kill(pid, 0)` keeps reporting it
alive, and a stop that took seconds takes the full 60 s timeout.

`INVISIBLE_DOTS_HOME` is on a named volume, never on a bind mount from a
Windows drive: qcow2 disks on a 9p or SMB share are too slow for a VM. After a
change to the checkout, run `prepare.sh` again (it starts from a fresh copy)
and the run again; the images on the volume are reused unless their inputs
changed.

On WSL, the VM that runs docker shuts down when no WSL session is attached,
which kills the container and every Dot in it: keep a session open (for
example `wsl.exe -e bash -lc "sleep 21600"` in the background) while the run
lasts. Remove everything afterwards with `docker rm -f idots-e2e` and
`docker volume rm idots-e2e-home idots-e2e-work`. Do remove the home volume:
it holds `config/master.key` next to the database in which the key is stored
encrypted under it, so whoever can read the volume can decrypt the key.

## Linux only

The run is written for a Linux host. Step h restarts the server with SIGTERM,
which on Linux runs the server's own shutdown (it closes the database and
releases `server.lock`). On Windows, Node's `kill()` is TerminateProcess
whatever the signal, so the same step would test a hard kill instead; the
server itself handles Ctrl+C, a closed console window and Ctrl+Break there
(docs/architecture.md section 11).
