<h1 align="center">invisible_dots</h1>

<p align="center"><b>Every Dot is an AI agent with a computer of its own:<br>a virtual machine, a desktop, browser identities and a memory that outlast every task.</b></p>

---

Windows, in PowerShell:

```powershell
winget install -e --id OpenJS.NodeJS.LTS; winget install -e --id GoLang.Go; winget install -e --id Git.Git
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
git clone https://github.com/feder-cr/dots; cd dots
npm ci
npm run build --workspace @invisible-dots/cli
npm run build --workspace @invisible-dots/web
$env:CGO_ENABLED = "0"; $env:GOOS = "linux"; $env:GOARCH = "amd64"
go -C guest/dot-agentd build -trimpath -o bin/dot-agentd ./cmd/dot-agentd
Remove-Item Env:CGO_ENABLED, Env:GOOS, Env:GOARCH
node apps/cli/dist/invisible-dots.mjs setup
```

If `setup` asks for a restart, restart, then in the same folder:

```powershell
node apps/cli/dist/invisible-dots.mjs image build
node apps/cli/dist/invisible-dots.mjs server
```

Linux (Ubuntu 24.04):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo snap install go --classic
git clone https://github.com/feder-cr/dots && cd dots
npm ci
npm run build --workspace @invisible-dots/cli
npm run build --workspace @invisible-dots/web
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C guest/dot-agentd build -trimpath -o bin/dot-agentd ./cmd/dot-agentd
node apps/cli/dist/invisible-dots.mjs setup
node apps/cli/dist/invisible-dots.mjs image build
node apps/cli/dist/invisible-dots.mjs server
```

Then, in a second terminal in the same folder:

```text
node apps/cli/dist/invisible-dots.mjs secret openrouter
node apps/cli/dist/invisible-dots.mjs init
node apps/cli/dist/invisible-dots.mjs create dot.yaml
node apps/cli/dist/invisible-dots.mjs message my-first-dot "What is on your desktop right now?"
```

`secret openrouter` asks for your OpenRouter key and stores it. `init` writes
`dot.yaml`, the Dot's name, goal, model and permissions, to edit before
`create`. `invisible-dots doctor` checks the host and names the command that
fixes anything missing.

To talk to a Dot from Telegram, make a bot with @BotFather (one bot per Dot),
then:

```text
node apps/cli/dist/invisible-dots.mjs channel add telegram --dot my-first-dot
node apps/cli/dist/invisible-dots.mjs channel pair telegram --dot my-first-dot
```

`channel add` asks for the bot's token and stores it encrypted; `channel pair`
prints a link: open it in Telegram and press Start, and that chat is the Dot's
from then on. Nobody else can talk to it. When the Dot needs a permission it
asks in that chat, with Approve and Reject buttons (the arguments shown are cut
to 300 characters; `PATCH /api/dots/:id/channels/telegram` with
`{"settings": {"approvals": false}}` keeps the answer in the app).
Telegram bot chats are not end-to-end encrypted.

WhatsApp is also possible, and it is opt-in because it is **not an official way
to use WhatsApp**: it links the Dot as a device of a personal account through an
unofficial client (Baileys, pinned to one release candidate), which WhatsApp's terms
do not allow for automation and which can get the account restricted or banned.
Use a number of its own, such as a spare SIM or eSIM, never the one you live on.
The client depends on `libsignal`, which is GPL-3.0 (see
`THIRD_PARTY_NOTICES.md`); the command bundle leaves it out and loads it from
`node_modules` only when you link WhatsApp.
The server offers it only when started with `INVISIBLE_DOTS_WHATSAPP=1`; then

```text
node apps/cli/dist/invisible-dots.mjs channel link whatsapp --dot my-first-dot
node apps/cli/dist/invisible-dots.mjs channel pair whatsapp --dot my-first-dot
```

`channel link` shows a code to scan under WhatsApp > Settings > Linked devices, and
the keys of the linked device are stored encrypted like the Telegram token.
`channel pair` prints a link that opens a chat with the number and the words
`pair <code>` ready to send. The Dot never writes first, to anyone; it answers
people who paired and nobody else, in private chats only. Approvals are answered
in words (`yes ap-xxxxxx` or `no ap-xxxxxx`; there are no buttons).

The web client: `invisible-dots server` serves it too, built by the
`npm run build --workspace @invisible-dots/web` line above. Open
http://127.0.0.1:3000 and sign in with the first line of `config/api.token` in
`~/.invisible-dots`. `server --no-web` runs the control plane alone, and
`INVISIBLE_DOTS_WEB_LISTEN` moves the web client to another `host:port`.

## What a Dot is

- **A computer.** Its own QEMU virtual machine with a persistent disk. It
  sleeps when it has nothing to do and wakes for the next task or message.
- **An agent inside it.** Its engine is a fork of nanobot, in Python. It
  reasons with any model on OpenRouter and works through tools: a shell with
  background jobs, files, memory notes and scheduled automations. The shell and
  the files are the Dot's own, run as the Dot's user through its computer's
  daemon.
- **Browser identities.** Each one is a separate browser profile with its own
  cookies, logins and fingerprint, kept from one task to the next. The control
  plane and the browser layer have them; the new engine does not offer them to
  the model yet.
- **Rules you set.** Every tool runs as allow, ask or deny; an ask waits for
  `invisible-dots approve`, and a pending approval survives a restart.

The same code runs on Linux (KVM) and Windows (Windows Hypervisor Platform).
The Windows path is not verified on real hardware yet. The engine's own tests
(`invisible_engine_dots`, pytest) run on Linux, in CI's `engine` job. There is
no end-to-end run against real VMs right now: the one that drove the earlier
engine is gone, and the browser phase of the new one brings its replacement.

How it works, and the contract every part is written against:
[docs/architecture.md](docs/architecture.md).

---

Not affiliated with OpenAI. MIT licensed. The agent engine is a fork of
nanobot, also MIT, and parts of this repository's history come from Open
Multi-Agent, also MIT, with their notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). QEMU, the guest operating
system, the browser engine and the packages a host downloads keep their own
licenses (docs/architecture.md, section 11.3).
