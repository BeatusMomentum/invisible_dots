<h1 align="center">dots</h1>

<p align="center"><b>Every Dot is an AI agent with a computer of its own:<br>a virtual machine, a desktop, browser identities and a memory that outlast every task.</b></p>

---

Needs Node 24, Go 1.25 and git. Windows, in PowerShell:

```powershell
git clone https://github.com/feder-cr/dots; cd dots
npm ci
npm run build --workspace @invisible-dots/invisible-dots-agent --workspace @invisible-dots/cli
$env:CGO_ENABLED = "0"; $env:GOOS = "linux"; $env:GOARCH = "amd64"
go -C guest/dot-agentd build -trimpath -o bin/dot-agentd ./cmd/dot-agentd
Remove-Item Env:CGO_ENABLED, Env:GOOS, Env:GOARCH
node apps/cli/dist/invisible-dots.mjs setup
node apps/cli/dist/invisible-dots.mjs image build
node apps/cli/dist/invisible-dots.mjs server
```

Linux:

```bash
git clone https://github.com/feder-cr/dots && cd dots
npm ci
npm run build --workspace @invisible-dots/invisible-dots-agent --workspace @invisible-dots/cli
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C guest/dot-agentd build -trimpath -o bin/dot-agentd ./cmd/dot-agentd
node apps/cli/dist/invisible-dots.mjs setup
node apps/cli/dist/invisible-dots.mjs image build
node apps/cli/dist/invisible-dots.mjs server
```

Then, in a second terminal in the same directory:

```text
node apps/cli/dist/invisible-dots.mjs secret openrouter
node apps/cli/dist/invisible-dots.mjs init
node apps/cli/dist/invisible-dots.mjs create dot.yaml
node apps/cli/dist/invisible-dots.mjs message my-first-dot "What is on your desktop right now?"
```

`secret openrouter` asks for your OpenRouter key and stores it. `init` writes
`dot.yaml`, the Dot's name, goal, model and permissions, to edit before
`create`. The API listens on http://127.0.0.1:8787; `invisible-dots doctor`
checks the host and names the command that fixes anything missing.

The web client:

```text
npm run build --workspace @invisible-dots/web
npm run start --workspace @invisible-dots/web
```

Open http://127.0.0.1:3000 and sign in with the first line of
`config/api.token` in `~/.invisible-dots`.

## What a Dot is

- **A computer.** Its own QEMU virtual machine with a persistent disk, on Linux
  or Windows hosts alike. It sleeps when it has nothing to do and wakes for
  the next task or message.
- **An agent inside it.** It reasons with any model on OpenRouter and works
  through tools: a shell, files, screenshots, memory and the browser.
- **Browser identities.** Each one is a separate browser profile with its own
  cookies, logins and fingerprint, kept from one task to the next.
- **Rules you set.** Every tool runs as allow, ask or deny; an ask waits for
  `invisible-dots approve`.

How it works, and the contract every part is written against:
[docs/architecture.md](docs/architecture.md).

---

MIT licensed. QEMU, the guest operating system, the browser engine and the
packages a host downloads keep their own licenses (docs/architecture.md,
section 11.3).
