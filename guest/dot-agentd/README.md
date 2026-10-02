# dot-agentd

The computer daemon that runs inside every Dot's VM (see `docs/architecture.md`,
sections 4 and 5.2). It serves:

- vsock port 1024, for the host: every request needs
  `Authorization: Bearer <token>`, with the token read from
  `/etc/invisible-dots/config.json`. `/v1/agent/*` is reverse proxied to the
  agent's unix socket, with streaming responses (SSE) flushed chunk by chunk.
- `/run/invisible-dots/agentd.sock` (mode 0600), for the agent: the same
  routes, no token, no `/v1/agent` proxy.

## Build

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/dot-agentd ./cmd/dot-agentd
```

The result is a static linux/amd64 binary. vsock code is linux-only behind
build tags, so `go vet ./...` also works on other systems.

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
| `--home` | `INVISIBLE_DOTS_HOME` | `/home/dot` |
| `--run-dir` | `INVISIBLE_DOTS_RUN_DIR` | `/run/invisible-dots` |
| `--agentd-socket` | `INVISIBLE_DOTS_AGENTD_SOCKET` | `<run-dir>/agentd.sock` |
| `--agent-socket` | `INVISIBLE_DOTS_AGENT_SOCKET` | `<run-dir>/agent.sock` |
| `--vsock-port` | `INVISIBLE_DOTS_VSOCK_PORT` | `1024` |
| `--no-vsock` | `INVISIBLE_DOTS_NO_VSOCK=1` | off |
| `--listen-tcp` | `INVISIBLE_DOTS_AGENTD_LISTEN_TCP` | off; development only, `127.0.0.1:<port>` and nothing else |
| `--display` | `INVISIBLE_DOTS_DISPLAY` | `:0` |
| `--import-bin` | `INVISIBLE_DOTS_IMPORT_BIN` | `import` |
| `--log-level` | `INVISIBLE_DOTS_LOG_LEVEL` | `info` |

The token is only required when vsock or the TCP listener is enabled.

## Guest packages it relies on

- `bash`, for `POST /v1/exec` (`bash -lc <command>`).
- `imagemagick`, for `GET /v1/screenshot`: it runs
  `import -window root -display :0 png:-` against the Xvfb display.

## Route details beyond the contract

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
- Errors are `{ "error": <code>, "message": <text> }`.
