<h1 align="center">invisible_dots</h1>

<p align="center"><b>Every Dot is an AI agent with a computer of its own:<br>a virtual machine, a desktop and browsers that outlast every task, on your PC,<br>with permissions you set (allow, ask or deny for each one).</b></p>

<p align="center">
<a href="https://github.com/feder-cr/dots/actions/workflows/tests.yml"><img alt="tests" src="https://github.com/feder-cr/dots/actions/workflows/tests.yml/badge.svg"></a>
<a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
<img alt="status: alpha" src="https://img.shields.io/badge/status-alpha-orange">
</p>

<p align="center">
<a href="#quick-start">Quick start</a>&nbsp;&nbsp;&nbsp;
<a href="#using-the-web-ui">Web UI</a>&nbsp;&nbsp;&nbsp;
<a href="#using-a-dot-day-to-day">Day to day</a>&nbsp;&nbsp;&nbsp;
<a href="#what-a-dot-can-do">What a Dot can do</a>&nbsp;&nbsp;&nbsp;
<a href="#approvals">Approvals</a>&nbsp;&nbsp;&nbsp;
<a href="#security-model-and-known-limits">Security</a>&nbsp;&nbsp;&nbsp;
<a href="#talk-to-it-from-your-phone">Channels</a>&nbsp;&nbsp;&nbsp;
<a href="#how-it-works">How it works</a>&nbsp;&nbsp;&nbsp;
<a href="#configuration">Configuration</a>&nbsp;&nbsp;&nbsp;
<a href="#privacy">Privacy</a>&nbsp;&nbsp;&nbsp;
<a href="#status-and-what-is-not-done-yet">Status</a>
</p>

---

A Dot is a persistent agent that owns a computer. You give it a goal, a model
and a set of permissions. invisible_dots gives it a QEMU virtual machine on
your own PC, with a disk that persists, a Linux desktop, a shell, its own files
and notes, and browser identities that keep their cookies and logins from one
task to the next. You talk to it from a web UI, the command line, an HTTP API,
Telegram, or (opt-in) WhatsApp.

The reasoning happens inside the Dot's VM. The control plane on your PC runs
the infrastructure only: the VMs, the task queue, events, approvals and
channels. The model is any model on OpenRouter, paid with your key.

What sets it apart:

- **A computer, not a sandbox for one command.** Each Dot has a
  hardware-accelerated VM (KVM on Linux, Windows Hypervisor Platform on
  Windows) with a persistent disk. It powers off after a quiet spell
  (`idle_timeout`, 15 minutes in the sample) and starts again for the next
  message, the next task or one of its own automations; disk, identities and
  memory stay.
- **A browser built not to look automated.** The only browser of a Dot is
  [invisible-playwright-mcp](https://github.com/feder-cr/invisible_playwright_mcp),
  on [invisible_playwright](https://github.com/feder-cr/invisible_playwright): a
  Firefox patched in C++, with the fingerprint set inside the engine instead of
  injected into the page. Each identity keeps its own profile and fingerprint.
  A browser has no proxy of its own by default: it uses the egress of the Dot's
  VM (through the Dot's VM proxy when it has one), and a proxy for one identity is an explicit option.
- **You set what it may do.** Every tool belongs to a permission, and each
  permission is allow, ask or deny. An ask waits for your answer, survives a
  restart, and lets that one call run once.
- **A crash loses nothing you saw accepted.** A restart of the server, a crash
  of the Dot's engine or a `kill -9` keeps every message and task you were told
  was accepted, and a tool call cut short is never run twice: the model is told
  its outcome is unknown and checks before trying again.

No package or hosted service is published. The one thing published is the
golden image, built by CI from this repository's pinned inputs and downloaded
by `image build` when its inputs are yours; everything else you build on your
own machine.

> [!IMPORTANT]
> invisible_dots is alpha and has not yet run end to end on real hardware: the
> acceptance run (`tests/e2e/run.ts`) is written but has never been completed
> on a machine with an accelerated QEMU. Its notes estimate 30 to 90 minutes
> and about 15 GB of disk for a first run. On Windows a Dot's VM boots under
> the Windows Hypervisor Platform with the CPU model `host,-vmx,-svm` (measured;
> plain `-cpu host` pauses it), and the rest of the lifecycle there is not
> measured yet ([architecture: VM definition](docs/architecture.md#34-vm-definition)).

## Quick start

In short: install Node, Go and Git, clone, `npm ci`, build the command line,
run `setup --all`, run `server`, and open the web UI to make the first Dot. That
is eight lines to type on Windows and nine on Linux, then the browser.

### Requirements

- Linux or Windows, on x86-64, with hardware virtualization on. macOS is not
  supported.
- Node 24 or newer, Git, and Go 1.25 or newer (to build the guest daemon).
- QEMU 8.2 or newer; `setup --all` installs it and enables the accelerator.
- At least 20 GiB free for the data directory (`doctor` checks it). Each Dot's
  disk is a copy-on-write overlay that grows as it writes, up to its
  `computer.disk` (40 GB in the sample).
- Memory: `image build` boots a builder VM with 2 vCPUs and 4 GiB, and each
  running Dot takes its `computer.memory` (4 GB in the sample). Inside a Dot,
  each open browser takes roughly 0.8 GB, and at most `max_open` (default 3)
  are open at once.
- A data directory path in plain ASCII with no comma. The default is
  `~/.invisible-dots`, under your account name, so an account named `José`
  fails at `doctor`; set `INVISIBLE_DOTS_HOME` to a path such as
  `C:\invisible-dots` before every command, the server included.
- An [OpenRouter](https://openrouter.ai) key.

### 1. Get the tools and the code

This is the part the repository's own command cannot do, because the command
needs Node and the checkout to exist first.

**Windows**, in PowerShell:

```powershell
winget install -e --id OpenJS.NodeJS.LTS; winget install -e --id GoLang.Go; winget install -e --id Git.Git
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
git clone https://github.com/feder-cr/dots
cd dots
npm ci
npm run build --workspace @invisible-dots/cli
```

**Linux** (Ubuntu 24.04), in bash:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo snap install go --classic
git clone https://github.com/feder-cr/dots
cd dots
npm ci
npm run build --workspace @invisible-dots/cli
```

### 2. Get the host ready, in one command

The same command in PowerShell and bash, from the repository folder:

```sh
node apps/cli/dist/invisible-dots.mjs setup --all
```

Run it as yourself, not as root or administrator: it asks for the rights it
needs once. It runs four steps in order, and each one skips what is already
done. These are the commands the quick start used to have you type one by one;
you can still run any of them alone:

| step | what it does | by hand |
|---|---|---|
| 1. The guest daemon | Builds `dot-agentd`, the program that runs inside every Dot's VM, for Linux whatever your host is. It stops here, before changing anything, when Go is missing, and prints the command that installs it. | `go -C guest/dot-agentd build -trimpath -o bin/dot-agentd ./cmd/dot-agentd` with `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` |
| 2. QEMU and its accelerator | Checks the host and fixes only what is missing. On **Windows** it enables the Windows Hypervisor Platform and installs QEMU in one elevated step (one UAC prompt). On **Linux** it installs QEMU with `sudo apt-get` (sudo asks for your password). | `invisible-dots setup` |
| 3. The web client | Builds it, with Next.js's anonymous telemetry turned off, unless it is built already. | `npm run build --workspace @invisible-dots/web` |
| 4. The guest images | Builds the runtime disk (the daemon and the engine), and downloads the golden image (Ubuntu 24.04, the desktop, the browser) that CI built for exactly these inputs, or builds it here when none is published (a changed pin, a fork, no network). A second run with unchanged inputs does nothing. | `invisible-dots image build` (`--no-download` always builds) |

Two things can stop it on purpose, and both end with the same advice: run the
same command again and it carries on.

- On **Windows**, if enabling the accelerator needs a restart, it says so and
  exits with code 5 after step 2. Restart, come back to this folder and run it
  again.
- On **Linux**, if you are not in the `kvm` group yet it prints
  `sudo usermod -aG kvm $USER`. Log out and in again, then run it again.

Anything else that fails (a missing Go, a failed download, a build error)
stops the run with the reason and with nothing after that step run. `doctor`
prints one line per check and the command that fixes each failure; `setup
--all` ends by telling you what to do next. Ctrl+C stops the image build
cleanly, and a second Ctrl+C ends the command at once.

### 3. Start the server and open the web UI

`setup --all` ends by printing these:

```sh
node apps/cli/dist/invisible-dots.mjs server
```

It runs in the foreground until Ctrl+C, and serves the web client too. Open
http://127.0.0.2:3000: there is no login. The web client listens on 127.0.0.2,
a loopback address of your PC that no Dot's VM reaches (a VM reaches only
127.0.0.1, as 10.0.2.2), and adds the API token to each API call itself.

On a computer that is ready except for the key, Home shows a field for your
OpenRouter key; then Create a Dot makes the first Dot. The web client is a
companion: if it was not built or its port is taken, the server says why and
the API and the command line carry on (`server --no-web` leaves it out).

### Your first Dot from the command line

Instead of the web UI, in a second terminal in the same folder:

```sh
node apps/cli/dist/invisible-dots.mjs secret openrouter
node apps/cli/dist/invisible-dots.mjs init
node apps/cli/dist/invisible-dots.mjs create dot.yaml
node apps/cli/dist/invisible-dots.mjs message my-first-dot "List the files in your home folder and say how much disk is free."
node apps/cli/dist/invisible-dots.mjs logs my-first-dot
```

`secret openrouter` asks for the key (it is never a command-line argument, and
what you paste at the prompt is not shown on the screen). `init` writes
`dot.yaml`, the Dot's name, goal, model, resources and permissions, to edit
before `create`. The first Dot takes a while to boot; the message waits in the
queue until it is ready. `logs` prints the Dot's events and keeps following new
ones until Ctrl+C (`--no-follow` prints and exits). It worked when `logs` shows
a `message.assistant` event with the answer and what it cost (`spent_usd`). The
web UI's Create a Dot page takes the place of `init` and `create`, and its
Settings page takes the key.

### A shorter command

In the rest of this page, `invisible-dots` stands for
`node apps/cli/dist/invisible-dots.mjs`, and `invisible-dots --help` lists every
command. To type it that way:

- in **bash**, run this once in the repository folder (again in each new
  terminal):

  ```bash
  alias invisible-dots="node '$PWD/apps/cli/dist/invisible-dots.mjs'"
  ```

- in **PowerShell**, type `npx invisible-dots` from the repository folder.

## Using the web UI

The web UI is the same control plane as the command line, with a page for what
you would otherwise read as text. It is set in Geist (bundled with it), has a light
and a dark theme that follows your system unless you choose, and fits a phone
screen.

**First run.** On a computer that is not ready for a Dot yet, Home shows a
setup checklist: each check of `doctor` that fails, with the command that fixes
it and a button that copies it, and a field for the OpenRouter key while none is
stored. `setup` and `image build` stay commands you run in a terminal (one needs
administrator rights and the other takes long). The checklist checks again when
you return to the window and stays on the page, turned green, once the last
thing is done; a computer that is ready shows none of it. The Settings page
(in the left rail) shows the same checks, takes a new key (and pushes it to the
Dots that are running), and has the theme.

**Create a Dot.** The Create a Dot page is a form in three steps (Identity,
Brain, Computer and safety) or the same configuration as YAML, and it refuses
what the configuration schema refuses before anything is sent. The permissions
start from one of three presets:

| preset | what it does |
|---|---|
| Careful | Asks you before it runs a command or changes a file. |
| Balanced | The defaults: works freely on its own computer, and asks before it deletes a browser identity or adds an automation. |
| Autonomous | Never asks, except before it deletes a browser identity. |

A panel beside the form shows what the new Dot depends on (the control plane,
the database, the key, QEMU, the accelerator, the disk, the images), with the
command that fixes each failing row.

**The Inbox** (in the rail) is everything that needs you, from every Dot: the
approvals that wait (the one that has waited longest first), a Dot in an error
state, a task that failed in the last 24 hours, and a channel that has to be
linked again. The same count is on the rail's Inbox badge, in the tab title and
on the favicon. An approval says what the Dot wants to do, under which
permission and why, shows a command, a diff of a file change, an address or a
schedule in the form that reads best (the raw arguments are under Details, a
proxy's password never), and answers with Allow once, Always allow (it asks
first, naming what the permission covers) or Deny with a note. With the
keyboard, `j` and `k` move between the cards, `a` allows the selected one once
and `d` denies it; a command or a deletion is not allowed by a key press alone.
History lists the answered ones.

**A Dot's page** has seven tabs:

- **Chat**: the one persistent conversation, with a quiet line for each tool the
  Dot used to answer, approvals you can answer in place, and a "via Telegram"
  mark on a message that came through a channel. The Dot's computer is always
  beside it (above it on a narrow screen), with the desktop and each open
  browser; both fill the window to the bottom.
- **Tasks**: what is running (with its latest progress line and its cost), what
  is scheduled and queued, and the history. Create a task, cancel one after a
  question, and open one for its result and its story.
- **Computer**: Screen, Browser, Files and Usage. Browser lists the Dot's
  browser identities and shows the window of an open one. Files is a read-only
  walk through `/home/dot`. Usage shows what the computer was given and what it
  uses, the model spend today and in total, and Start, Reboot and Stop.
- **Channels**: Telegram and WhatsApp, below.
- **Activity**: the whole event log as readable lines, filtered by kind,
  searchable, and exportable as JSON Lines.
- **Settings**: the Dot's configuration, as a form or as YAML. Nothing is saved
  until you have seen the list of what changes, and a configuration changed
  somewhere else in the meantime is never overwritten. The permission editor
  shows each permission's risk and which tools it covers. Deleting the Dot asks
  you to type its name.

**Watching the computer.** The desktop and each open browser are shown as
pictures that the control plane reads from the guest every few seconds while the
page is in view, with a LIVE badge, a warning when a picture is more than 15
seconds old, and a mark on the browser the Dot is using right now. It is a view
and not a remote desktop: it says "The Dot has control", because nothing you do
in it reaches the computer.

**Stopping.** Stop asks first, and says that the computer's automations do not
run while you have stopped it. The Usage view and the Automations view show it
(paused because you stopped the computer) or, otherwise, when the next
automation is due.

**Channels.** The Channels tab connects a Dot to Telegram (paste the bot's
token) and, when the server was started with `INVISIBLE_DOTS_WHATSAPP=1`, to
WhatsApp (scan a QR code the page draws). It pairs a chat with a link, a QR code
and the words to type, lists the people paired with a Revoke for each, has the
three switches of a channel's settings, and can pause or disconnect it. A
channel that was refused (a revoked token, a device removed on the phone) says
so, and so do the rail and the Inbox. More under
[Talk to it from your phone](#talk-to-it-from-your-phone).

## Using a Dot day to day

| command | what it does |
|---|---|
| `invisible-dots list` | every Dot, with its state |
| `invisible-dots status <dot>` | a Dot, its computer and its recent tasks |
| `invisible-dots message <dot> <text>` | a message in its one persistent conversation |
| `invisible-dots task <dot> <text> [--priority N] [--at ISO-8601]` | a queued task; a higher priority runs first, `--at` sets the earliest start |
| `invisible-dots tasks <dot>` | its tasks and their status |
| `invisible-dots logs <dot> [--tail N] [--no-follow]` | its events, then new ones as they come |
| `invisible-dots approvals [--all]` | pending approvals (all of them with `--all`) |
| `invisible-dots approve <id> [--always] [--note text]` | let that one call run; `--always` also allows its permission for the Dot from now on |
| `invisible-dots reject <id> [--note text]` | refuse it; the model is told no |
| `invisible-dots computer <dot> start\|stop\|reboot` | power its computer on or off by hand |
| `invisible-dots browser <dot> identities` | its browser identities |
| `invisible-dots channel list [--dot <dot>]` | linked chats and who is paired |
| `invisible-dots channel remove telegram\|whatsapp --dot <dot>` | unlink a chat; its token or keys and paired people are deleted |
| `invisible-dots secret openrouter --dot <dot>` | a key for one Dot instead of the global one |

`<dot>` is a Dot's name or id, and `--json` gives machine-readable output.
Editing a Dot's configuration and deleting a Dot are done in the web UI (its
settings tab) or through the API (`PATCH` and `DELETE /api/dots/:id`); the
command line has no command for either yet.

## What a Dot can do

Its tools, each behind a permission
([architecture: tools](docs/architecture.md#83-tools)):

- **Run commands** on its own computer: a shell with a timeout, background
  jobs, and programs on a pseudo-terminal that it reads as a screen of text.
- **Read and write files**: read, list, find, grep, write, edit, apply a patch.
- **Keep its memory**: one file per note in `/home/dot/memory`, kept by the Dot
  itself as Claude Code keeps its own: there is nothing to set. It finds them
  again with its file tools, and the newest ones are named in its prompt.
- **Schedule itself**: add, list and remove its own automations (at a time,
  every interval, or a cron expression). This one asks you first by default;
  to pause or remove one, ask the Dot.
- **Use its browsers**: create, launch and close identities; navigate (http
  and https only), read the page, take screenshots, click, type, select,
  scroll, go back and forward.
- **Look at its desktop** with a screenshot.

Work reaches it three ways: a message in its one persistent conversation, a
queued task (with a priority and an optional start time), or one of its own
automations firing. Each task has limits on steps, on context and on cost
(`max_cost_per_task_usd`). Long threads are summarized, by the Dot's model or
by another model you name (`models.summary`).

> [!NOTE]
> Automations run inside the Dot's computer, and the control plane starts the
> computer for them. A Dot that is asleep is started shortly before an
> automation is due (90 seconds ahead by default), and it is not put to sleep
> while one is due, so a job every minute keeps it up. A run whose time passed
> while the computer or the server was down is made once, late, when the
> computer starts, never once for each occurrence it missed. A computer you
> stopped yourself (`invisible-dots computer <dot> stop`, or Stop in the web UI)
> stays off, and its automations are paused until you start it again; a message
> or a task still starts it.

For example, the configuration in
[architecture: Dot configuration](docs/architecture.md#7-dot-configuration)
describes a Dot whose goal is:

> Check one-way fares from Milan to Lisbon every morning and report the
> cheapest day. Write findings to ~/workspace/fares.csv.

Once the Dot has set that automation up (it asks you first), its computer is
started each morning for it, and sleeps again afterwards.

A Dot has no web search or fetch tool, no sub-agents and no tool to message
anyone: it reads the web through its own browser, and only the control plane
talks to chats.

## Approvals

- Every tool call goes through one policy gate. `allow` runs it, `deny` tells
  the model no, `ask` stops the turn and records the call with its arguments
  ([architecture: policy](docs/architecture.md#84-policy)).
- The defaults are permissive for the Dot's own computer: running commands,
  files and the browser are allowed, except deleting a browser
  identity, which asks; automations ask; anything unknown is denied. Set any
  permission to `ask` or `deny` in the YAML to be asked first or to forbid it.
- An approval can be answered in the web UI, the command line, a Telegram
  button or a WhatsApp reply. The first answer wins, a second is ignored, and
  the approved call runs at most once. `approve --always` turns that ask into
  an allow for the Dot.
- Pending approvals survive a restart of the server or of the Dot.

## Security model and known limits

What protects you:

- The OpenRouter key is never written to the image, the disk or the seed. It
  is pushed to the Dot after every start and held in the engine's memory only
  ([architecture: secrets](docs/architecture.md#43-secrets)).
- The engine and the computer daemon each run as a user of their own, and the
  model's commands as a third, `dot`, which can reach neither: it cannot read
  the engine's state or the Dot's token, cannot connect to the engine's socket
  (so it cannot change the Dot's permissions or approve its own calls), cannot
  stop either daemon and cannot become root
  ([architecture: processes](docs/architecture.md#41-processes-systemd-each-unit-as-the-user-it-names)).
  The one thing it may do as root is install Ubuntu packages it is missing,
  `sudo dot-install <package>...`: the command takes package names and nothing
  else, so no option reaches apt; the packages' own install scripts run as root,
  and they come from the Ubuntu archive.
- The channel between host and guest goes one way: the host calls the guest
  on a loopback port, with the Dot's token, and only after the guest proves it
  holds that token. The API needs a bearer token (the command line reads it
  from `config/api.token` itself); the web UI needs none and listens on
  127.0.0.2, which no Dot's VM reaches.
- Files the host shows from a Dot come only from `/home/dot`, at most 16 MiB,
  never served as a type a browser would run.
- The proxy of an identity, when it has one, is not shown by the host: an
  identity says only that it has one, an approval shows it as `***`, and no
  event carries it.
- Secrets on the host (the OpenRouter key, channel tokens, WhatsApp keys) are
  stored encrypted; see [Configuration](#configuration).

What it does not protect against, by design or not yet:

- The model's commands run as `dot`, which can read the proxy of an identity
  that was given one, password included, from the open browser's environment
  and from the browser server's own session file, and what the browser server
  says of a proxy it refuses reaches the model and the engine's log as it is.
  An identity with no proxy, the default, has nothing to read.
- The split between the three users is the guest operating system's. A flaw in
  the guest's kernel, or a way to become root that this repository does not
  know of, would end it. The VM is what stands between the Dot and your PC
  then, with the reach into your PC's loopback listed below.
- The computer daemon holds three capabilities (`CAP_SETUID`, `CAP_SETGID` and
  `CAP_KILL`, to run the model's work as `dot`) and may run one command as
  root, the power-off. A flaw in the daemon would be worth more than one in an
  ordinary program. Its one door, a TCP port inside the guest, needs the Dot's
  token, which `dot` cannot read.
- Nothing limits how much disk, memory or processor time the model's commands
  use of their own VM, so a runaway command can starve the Dot's own daemons
  until the VM is stopped or restarted.
- When typing in the browser is set to `ask`, the approval shows the text being
  typed, password or not.
- Each Dot can reach services on your PC's loopback through `10.0.2.2`.
  Everything invisible_dots listens on there needs a credential the Dot lacks,
  but nothing else should listen there unauthenticated
  ([architecture: networking](docs/architecture.md#36-networking-and-its-limits),
  [architecture: browser identities](docs/architecture.md#6-browser-identities)).

## The browser

Each browser identity is a separate Firefox profile under
`/home/dot/browsers/<id>/`, with its own cookies, storage, logins and
fingerprint, the same fingerprint at every launch. It runs on the Dot's desktop, so it appears in screenshots of the desktop.

A Dot can have a VM proxy: the whole computer of the Dot, browser, commands and
the engine's requests to OpenRouter included, then goes out through it. Set it
in the Dot's settings (VM proxy) or with
`invisible-dots secret proxy --dot <dot>` (asked for like the key; `--clear`
removes it). It is a SOCKS5 URL, `socks5://user:password@host:port`, stored
encrypted and never shown again, and the Dot uses it from its next start. If the
proxy cannot be reached, nothing leaves the VM. What the provider does behind its
address is not the Dot's business: nothing compares or tracks the exit.

A browser has no proxy of its own by default, and nothing asks for one: it
inherits the egress of the Dot's VM (through the VM proxy when the Dot has one,
directly otherwise), and its time zone, language and location follow the exit
it actually uses. A proxy for one identity is an explicit option, set when that
identity is created, as the URL the browser library reads (`http://user:pass@host:port`
or `socks5://host:port`); the library, not this project, judges it when the identity
launches. When a VM proxy and an identity proxy are both set, the identity's proxy is
reached through the VM's tunnel.

In the web UI (Computer, Browser) you can create an identity with an optional
proxy, close one, delete one (asked first), and watch the window of each open
one, as a picture refreshed every 2 seconds while the page is in view. The
proxy field does not show what you type, and a proxy's password is shown nowhere
afterwards.

Launching is explicit: a page action on an identity that is not open fails, so
denying `browser.identity.launch` cannot be undone by navigating. At most
`max_open` identities are open at once (default 3, roughly 0.8 GB each), the
least recently used one closing first, and at most `max_identities` exist
(default 20). Screenshots go to the model and are never stored.

How well the browser holds up against bot checks is measured in
[invisible_playwright's README](https://github.com/feder-cr/invisible_playwright),
on the suites it names. invisible_dots adds no claim of its own: a site can
still refuse a Dot for what it does, and the terms of the sites you point it at
still apply.

## Talk to it from your phone

**Telegram.** Make a bot with @BotFather (one bot per Dot), then:

```sh
invisible-dots channel add telegram --dot my-first-dot
invisible-dots channel pair telegram --dot my-first-dot
```

`channel add` asks for the bot's token and stores it encrypted. `channel pair`
prints a one-time link, valid ten minutes: open it in Telegram and press Start,
and that account is the Dot's owner from then on. Messages from anyone else are
dropped before they cost anything. Approvals arrive with Approve and Reject
buttons, the arguments cut to 300 characters. Telegram bot chats are not
end-to-end encrypted. Text only.

A channel has three settings, all on by default: `approvals` (ask approvals in
the chat), `show_arguments` (show the tool's arguments in them) and
`notify_tasks` (what the Dot says on its own: finished and failed tasks, and
the answers to its automations). The Channels tab of the web UI has a switch
for each; there is no command for them, and the API sets them too:

```bash
curl -X PATCH http://127.0.0.1:8787/api/dots/my-first-dot/channels/telegram \
  -H "Authorization: Bearer $(head -1 ~/.invisible-dots/config/api.token)" \
  -H "Content-Type: application/json" \
  -d '{"settings": {"show_arguments": false}}'
```

**WhatsApp** is opt-in, and it needs a warning first.

> [!WARNING]
> This is not an official way to use WhatsApp. It links the Dot as a device of
> a personal account through an unofficial client (Baileys, pinned to one
> release candidate), which WhatsApp's terms do not allow for automation and
> which can get the account restricted or banned. Use a number of its own, such
> as a spare SIM or eSIM, never the one you live on.

The WhatsApp client is not part of the default install (see below). Install it
once, from the repository folder, then start the server with
`INVISIBLE_DOTS_WHATSAPP=1`:

```sh
npm run whatsapp:install
```

```sh
invisible-dots channel link whatsapp --dot my-first-dot
invisible-dots channel pair whatsapp --dot my-first-dot
```

`channel link` shows a QR code to scan under WhatsApp > Settings > Linked
devices; the linked device's keys are stored encrypted. `channel pair` prints a
link that opens a chat with the number and `pair <code>` ready to send. The Dot
never writes first, to anyone, answers only people who paired, in private
chats, and takes text only. Approvals are answered in words
(`yes ap-xxxxxx` or `no ap-xxxxxx`); a bare `yes` is an ordinary message.

Baileys depends on `libsignal`, which is GPL-3.0, so nothing of it is installed
by default: `npm ci` installs neither, and neither is in the bundled command.
`npm run whatsapp:install` installs them into `optional/whatsapp/`, pinned to
one release by a lock file with the integrity of every package, and the server
loads them from there only when WhatsApp is linked. Without them, or with a
release other than the pinned one (after a `git pull` that moves the pin, run the
command again), linking says how to enable it ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

The details of both:
[architecture: messaging channels](docs/architecture.md#98-messaging-channels).

## How it works

In short: the web UI and the command line call the HTTP API; the scheduler
behind it keeps the queue in a database and starts and stops one QEMU VM per
Dot; inside the VM, the engine reasons with OpenRouter, runs the model's
commands through the computer daemon and drives its browsers on the VM's
desktop; Telegram and WhatsApp reach the scheduler through the channel hub.

```mermaid
flowchart LR
  subgraph PC["Your PC: one invisible-dots server process"]
    WEB["Web UI<br/>127.0.0.2:3000"]
    CLI["CLI"]
    API["HTTP API and SSE<br/>127.0.0.1:8787"]
    SCH["Scheduler<br/>queue, outbox, approvals, sleep and wake"]
    HUB["Channel hub"]
    VMM["vm-manager<br/>the QEMU driver"]
    DB[("PostgreSQL<br/>embedded PGlite by default")]
  end
  subgraph VM["One QEMU VM per Dot"]
    AGD["dot-agentd<br/>the computer daemon, user dotagentd"]
    ENG["Engine, a nanobot fork<br/>user dotengine, key in memory"]
    DESK["Xvfb and XFCE desktop"]
    BR["invisible-playwright-mcp<br/>one per open identity"]
  end
  WEB -->|"API calls with the token"| API
  CLI -->|"API calls with the token"| API
  API -->|"messages, tasks, answers"| SCH
  HUB -->|"chat messages and approvals"| SCH
  SCH -->|"queue, events, approvals"| DB
  SCH -->|"start, stop, reboot"| VMM
  VMM -->|"starts and stops"| VM
  SCH -->|"loopback port forward<br/>token after an HMAC proof"| AGD
  AGD <-->|"proxy, and the model's commands"| ENG
  ENG -->|"browser tools over MCP"| BR
  BR -->|"windows on"| DESK
  ENG -->|"model requests"| OR["OpenRouter"]
  HUB <-->|"bot messages"| TG["Telegram"]
  HUB <-->|"linked device"| WA["WhatsApp, opt-in"]
  BR -->|"pages, from the VM's egress"| SITES["The web"]
```

- **One process on the host.** `invisible-dots server` runs the API, the
  scheduler, the VM driver and the channel hub, and starts the web client as a
  child (`--no-web` leaves it out). The database is an embedded PostgreSQL
  (PGlite) in the data directory, or an external PostgreSQL 16 or newer through
  `DATABASE_URL`.
- **One VM per Dot.** QEMU with KVM or the Windows Hypervisor Platform; never
  software emulation. A copy-on-write disk over a golden image, plus a
  read-only runtime disk with our code. Both images are built on your machine
  from pinned, hashed inputs
  ([architecture: two images](docs/architecture.md#33-two-images-two-lifetimes)).
- **The engine** is a hard fork of [nanobot](https://github.com/HKUDS/nanobot)
  in Python, cut down to its core: the turn runner, OpenRouter, the tools above,
  automations, and an MCP client that serves only the browser
  ([invisible_engine_dots/UPSTREAM.md](invisible_engine_dots/UPSTREAM.md)).
- **Durable on both sides.** The host writes what it tells a guest in the
  same transaction as the decision, so a restart loses nothing you saw
  accepted ([architecture: durable queue](docs/architecture.md#92-durable-queue)).
  The engine keeps its state in one SQLite file and commits each step with the
  events that describe it; its event stream keeps its order across a
  `kill -9`. A task cut short by a crash is started again with a note that the
  last attempt was interrupted, and fails once it has been started three times
  ([architecture: crash recovery](docs/architecture.md#87-crash-recovery)).
- **The server can restart without stopping Dots.** QEMU runs detached, and a
  new server adopts the VMs it finds running. A VM that dies while its Dot has
  work is started again.

The full contract every part is written against:
[docs/architecture.md](docs/architecture.md).

## Configuration

A Dot is one YAML file, checked by one schema: name, goal, instructions,
model, computer (cpu, memory, disk, idle timeout), browser identities,
permissions and limits. Every field and its range is in
[architecture: Dot configuration](docs/architecture.md#7-dot-configuration);
`invisible-dots init` writes a sample.

One server runs per data directory. Secrets (the OpenRouter key, channel
tokens, WhatsApp keys) are stored with AES-256-GCM under
`config/master.key`; anyone who can read the data directory can decrypt them,
so it is kept private to your user.

<details>
<summary>The environment variables the host reads</summary>

| variable | default | what |
|---|---|---|
| `INVISIBLE_DOTS_HOME` | `~/.invisible-dots` | the data directory: keys, database, images, VM disks, logs. Plain ASCII, no comma |
| `INVISIBLE_DOTS_LISTEN` | `127.0.0.1:8787` | where the server's API listens |
| `INVISIBLE_DOTS_URL` | `http://127.0.0.1:8787` | where the CLI finds the server |
| `INVISIBLE_DOTS_TOKEN` | first line of `config/api.token` | the API token, instead of the file |
| `INVISIBLE_DOTS_WEB_LISTEN` | `127.0.0.2:3000` | where the web client listens; keep it off 127.0.0.1, which every Dot's VM reaches |
| `INVISIBLE_DOTS_WEB_ALLOWED_HOSTS` | loopback only | other host names the web client answers to |
| `INVISIBLE_DOTS_QEMU_DIR` | official installer's folder, then `PATH` | the one folder QEMU is looked for in |
| `INVISIBLE_DOTS_WHATSAPP` | off | `1` offers the WhatsApp channel (after `npm run whatsapp:install`) |
| `DATABASE_URL` | embedded PGlite | an external PostgreSQL 16 or newer |
| `INVISIBLE_DOTS_DEBUG` | off | `1` adds debug lines to the server's log |

</details>

## Troubleshooting

- `invisible-dots doctor` first: one line per check, and the command that fixes
  a failure.
- The server logs to the terminal it runs in; `INVISIBLE_DOTS_DEBUG=1` adds
  debug lines.
- A Dot that does not start: QEMU's own output is in
  `~/.invisible-dots/logs/qemu-<dot_id>.log`, and the guest's serial console in
  `~/.invisible-dots/vms/<dot_id>/serial.log` (rewritten at each start).
  `invisible-dots list` shows each Dot's id.
- What a Dot did and why it stopped: `invisible-dots logs <dot>` and
  `invisible-dots tasks <dot>`, or the Dot's Activity tab in the web UI.
- The web UI does not open: `invisible-dots server` says why it did not start
  it (not built, port taken) in its output; build it as in step 1. Its
  address is http://127.0.0.2:3000, not 127.0.0.1.

## Updating and uninstalling

**Updating.** Stop the server (Ctrl+C), then in the repository folder:
`git pull`, `npm ci`, the three builds of step 1 (the command, the web client
and dot-agentd), `invisible-dots image build`, and `invisible-dots server`
again. Running Dots keep running meanwhile: QEMU is not a child of the server.
Each VM start takes the newest runtime image (our code), so
`invisible-dots computer <dot> reboot` moves a Dot to it. A Dot keeps the
golden image it was created on, and new Dots get the newest one. When an update
changes the engine's dependencies, a Dot on an older golden image needs a new
one; this version has no way to move a Dot to a new golden image.

**Uninstalling.** Stop each Dot's computer (`invisible-dots computer <dot>
stop`) while the server runs, since a VM outlives the server, then stop the
server and delete the data directory (`~/.invisible-dots`, or your
`INVISIBLE_DOTS_HOME`) and the repository folder. What `setup` installed stays
until you remove it yourself: QEMU, the Windows Hypervisor Platform feature on
Windows, and your membership of the `kvm` group on Linux.

## Privacy

invisible_dots runs on your machine and has no server of its own. What leaves
it, and to whom:

- **OpenRouter** gets the conversation, the tool results and what the Dot
  reads, under your key. Requests carry the headers
  `HTTP-Referer: https://github.com/feder-cr/dots` and `X-Title: invisible_dots`.
- **Telegram and WhatsApp** carry the messages and approval prompts of a
  linked channel, and can read them. Link previews are off, so neither
  service fetches a link of a message on its own (an approval prompt shows
  the address a call is about to open); a person who taps a link opens it
  themselves.
- **The sites a Dot visits** see its browser, coming from the egress of the Dot's
  VM, or from the identity's proxy when you gave that one identity a proxy.
- **Publishers of what the images are made of** (Ubuntu, uv, the Python
  packages, the browser engine) serve the downloads
  when you build them; on Windows, `setup` downloads the official QEMU
  installer.
- **The browser layer.**
  [invisible-playwright-mcp's privacy policy](https://github.com/feder-cr/invisible_playwright_mcp#privacy-policy)
  says each browser launch fetches a one-line counter file from a GitHub
  release, carrying no identifier.
- **Address-echo services** (`api.ipify.org`, `icanhazip.com`,
  `checkip.amazonaws.com`) are asked by the browser library at each launch for
  the public address the browser exits from (the VM's egress, or through the
  identity's proxy when it has one), to set the time zone and locale, and it
  keeps its GeoIP database current from its GitHub release.
- **The web UI** loads nothing from other sites: its pages, scripts and styles
  come from the server on your PC, its fonts (Geist) included. A link you
  press (to @BotFather, to an OpenRouter page) opens that site.
- **Next.js** may send its anonymous build telemetry when the web client is
  built. `setup --all` turns it off for its build; set
  `NEXT_TELEMETRY_DISABLED=1` yourself when you run
  `npm run build --workspace @invisible-dots/web` by hand.

Your Dots' disks, memory and conversations stay in the data directory and
inside their VMs.

## Development and tests

Besides the quick start's tools, development needs Python 3.11 or newer for the
engine, and Docker for the smokes.

```sh
npm ci
npm run typecheck
npm test                                   # vitest over the TypeScript workspace and tests/repo
git config core.hooksPath .githooks        # the pre-push gate: typecheck, vitest, go test, prose checks
```

The pre-push gate's prose checks need Python with the pinned invisible-core.
The hook looks for it in `tmp/gates-venv` first:

```sh
python -m venv tmp/gates-venv
tmp/gates-venv/bin/python -m pip install -r .github/gates-requirements.txt
```

(on Windows the interpreter is `tmp\gates-venv\Scripts\python.exe`).

- The engine: `pip install -e ".[dev]"` and `pytest` in
  `invisible_engine_dots/` (Linux only: it uses unix sockets).
- dot-agentd: `go test ./...` in `guest/dot-agentd/`.
- The web client's browser tests: build it (`npm run build --workspace
  @invisible-dots/web`), install the browser they drive (`npx playwright install
  chromium`) and run `npm run test:e2e --workspace @invisible-dots/web`. Each run
  starts the real control plane over a fake VM layer and the built web client as
  the product runs it: the standalone server that `invisible-dots server` starts,
  with its copied static files and the reduced environment it is given.
- The engine smoke and the browser smoke run the guest's two daemons, and the
  real invisible-playwright-mcp with its Firefox, in Linux containers:
  `bash guest/image-builder/test/smoke/run.sh` (add `--suite browser`); only
  Docker is needed
  ([the smoke tests README](guest/image-builder/test/smoke/README.md)).
- The acceptance run on a real VM, `node tests/e2e/run.ts`, needs a Linux host
  with KVM and an OpenRouter key, and is not part of CI
  ([the acceptance run README](tests/e2e/README.md)).

<details>
<summary>What CI runs, and where the code lives</summary>

CI runs on pushes to main and on pull requests: typecheck and vitest on Linux
and Windows, the database layer against a real PostgreSQL, dot-agentd's Go
tests and static build, the engine's pytest, the ISO images read by the Linux
kernel, both smokes, the web build with its Playwright tests, and two prose gates (English only, and a
README that promises nothing it cannot support). The vitest, Go, pytest and
Playwright runs are counted against the floors in `.github/test-floors.json`, and the
smokes fail on a skipped check, so a test that stops running fails the build.

| folder | what |
|---|---|
| `apps/` | `api`, `scheduler`, `vm-manager`, `web`, `cli` |
| `packages/` | shared types and schemas, database, events, channels, the ISO writer, the SDK |
| `guest/` | `dot-agentd` (Go) and the image builder |
| `invisible_engine_dots/` | the Dot's engine (Python) |
| `virtualization/` | the pinned QEMU, cloud-init templates, base image metadata |
| `tests/` | checks over the whole repository, and the real-VM run |

</details>

## Status and what is not done yet

Alpha. Nothing is released yet; the golden image is the one thing published.

- **The real-VM acceptance run has not been run yet.** It exists
  (`tests/e2e/run.ts`: build, create, browse, approve, kill the VM, restart,
  scan the disk for the key) and CI keeps its contract in step with the
  product, but the machine it was written on has no accelerated QEMU. Until it
  passes on real hardware, the guest is tested by the container smokes, which
  run its daemons without a VM.
- **Windows is not verified end to end on real hardware**: the VM boots
  under WHPX (top of this page), the rest is not measured. It runs the same code path as Linux, and
  every difference between the two is listed in
  [architecture: one mechanism on every host](docs/architecture.md#11-one-mechanism-on-every-host).
- **The install is one command after the checkout, not before it.** Node, Go
  and Git, the clone, `npm ci` and the build of the command line itself are
  still typed by hand, because the command needs them to exist before it can
  run. It does not install Go for you (the Windows installer and snap each ask for
  administrator rights of their own, and the quick start keeps to one).
- **A computer you stopped by hand does not wake for its automations** until
  you start it again.
- **Channels carry text only**, one Telegram bot per Dot; the official
  WhatsApp Cloud API is a later adapter on the same hub.
- **Not in this version**: snapshots and rollback, backups, quotas, network
  policies, MCP integrations beyond the browser, controlling the desktop or an
  interactive terminal for you (the web UI shows the desktop and the browsers
  as pictures, and nothing you do there reaches the computer), artifacts,
  several hosts, organisations and roles, macOS hosts
  ([architecture: out of scope](docs/architecture.md#10-out-of-scope-for-this-version)).

## License

MIT ([LICENSE](LICENSE)). The engine under `invisible_engine_dots/` is a fork
of nanobot, also MIT, under its own [LICENSE](invisible_engine_dots/LICENSE);
parts of this repository's history come from Open Multi-Agent, also MIT. Their
notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). QEMU (GPL-2.0)
is installed from its official installer or your distribution and only run as
a separate program, never bundled. The guest operating system, the browser
engine and the packages in the golden image keep their own licenses; the
published golden image is Ubuntu with those packages, and whoever copies it
takes on those licenses
([architecture: licensing](docs/architecture.md#113-licensing)). Nothing under
the GPL is installed by the default `npm install`; the WhatsApp client, which
brings a GPL-3.0 dependency, is an opt-in install. The Dot's computer is
another matter: the VM image holds the Ubuntu guest operating system and the
packages the golden image installs on it (the Linux kernel, Xvfb, XFCE and the
rest), which are mostly GPL and LGPL software under their own licenses and are
downloaded from their publishers on your machine, as described above.

invisible_dots is an independent project, not affiliated with OpenRouter,
Telegram, WhatsApp or Meta.
