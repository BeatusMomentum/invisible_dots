# dot-agentd

The computer daemon that runs inside every Dot's VM (see `docs/architecture.md`,
sections 4 and 5.2). It serves:

- TCP `0.0.0.0:1024`, for the host, which reaches it through QEMU's
  `hostfwd` port forward (architecture sections 3.4 and 5.1): every request
  needs `Authorization: Bearer <token>`, with the token read from
  `/etc/invisible-dots/config.json`. `/v1/agent/*` is reverse proxied to the
  agent's unix socket, with streaming responses (SSE) flushed chunk by chunk.
  The daemon refuses to start without a token, since the port is always open.
  It binds every interface because the forward targets the guest's
  DHCP-assigned user-network address; nothing outside the host's forward can
  reach that interface.
- `/run/invisible-dots/agentd.sock` (mode 0600), for the agent: the same
  routes, no token, no `/v1/agent` proxy and no `POST /v1/system/poweroff`
  (powering the VM off is the control plane's decision).

## Build

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/dot-agentd ./cmd/dot-agentd
```

The result is a static linux/amd64 binary with no dependencies outside the
Go standard library. The unix-only pieces (socket umask, process groups,
`statfs`) sit behind build tags, so `go vet ./...` also works on other systems.

## Test

```sh
go vet ./... && go test -count=1 ./...
```

The exec and screenshot tests need a unix system with `bash`; on Windows they
are compiled out or skipped.

## Configuration

Every flag has an environment variable; a flag on the command line wins.

| flag | variable | default |
|---|---|---|
| `--config` | `INVISIBLE_DOTS_GUEST_CONFIG` | `/etc/invisible-dots/config.json` |
| `--home` | `DOT_HOME` | `/home/dot` |
| `--run-dir` | `INVISIBLE_DOTS_RUN_DIR` | `/run/invisible-dots` |
| `--agentd-socket` | `INVISIBLE_DOTS_AGENTD_SOCKET` | `<run-dir>/agentd.sock` |
| `--agent-socket` | `INVISIBLE_DOTS_AGENT_SOCKET` | `<run-dir>/agent.sock` |
| `--listen` | `INVISIBLE_DOTS_AGENTD_LISTEN` | `0.0.0.0:1024`; an IP literal and a port, e.g. `127.0.0.1:18024` for development outside a VM |
| `--display` | `INVISIBLE_DOTS_DISPLAY` | `:0` |
| `--import-bin` | `INVISIBLE_DOTS_IMPORT_BIN` | `import` |
| `--log-level` | `INVISIBLE_DOTS_LOG_LEVEL` | `info` |

The token is always required: there is no mode that serves the remote routes
without it.

## Guest packages it relies on

- `bash`, for `POST /v1/exec` (`bash -lc <command>`).
- `sudo` and systemd, for `POST /v1/system/poweroff`: it runs
  `sudo -n systemctl poweroff`, which the seed allows the user `dot` without a
  password, and which is the only command `dot` may run as root.
- `imagemagick`, for `GET /v1/screenshot`: it runs
  `import -window root -display :0 png:-` against the Xvfb display.

## Route details beyond the contract

- `GET /v1/proof?nonce=<hex>`: the one route served without the token, on the
  TCP listener only. It answers `{ "proof": HMAC-SHA256(token, "invisible-dots
  guest proof v1\n" + nonce) }` in hex; a nonce that is not 32 to 128
  lowercase hex characters is a `400 invalid_nonce`. The host asks it before
  it sends the token to a port (architecture section 5.1), and the answer
  says nothing about the token to whoever asks.

- `GET /v1/health`: when the agent does not answer within 2 s, `agent` is
  `{ "status": "down", "error": "<why>" }`. The guest's readiness checks
  (filesystem writable, network reachable, browser layer installed) are in the
  agent's own `/health` answer, passed through here untouched: the agent is the
  process that writes the state, reaches OpenRouter and starts the browser.
- `POST /v1/exec`: `timeout_ms` defaults to 120000 and may not exceed one hour.
  The command runs in its own process group, and a timeout or a disconnected
  caller kills the whole group. The answer adds `stdout_truncated` and
  `stderr_truncated`. Background children that keep stdout open are not
  waited for longer than 2 s after bash exits.
- File paths: relative paths and `~/...` resolve against home, absolute paths
  are used as they are, a NUL byte is refused. `PUT` creates parent directories
  and replaces the file atomically, keeping an existing file's mode.
  `GET /v1/files/list` without `path` lists home.
- `POST /v1/system/poweroff`: starts the poweroff command without waiting for
  it and answers `202 { "status": "powering_off" }`; a command that cannot be
  started is a `500 poweroff_failed`. The host sees the rest as QEMU exiting
  once the guest is off (architecture section 3.4).
- Errors are `{ "error": <code>, "message": <text> }`.
