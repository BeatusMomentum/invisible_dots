# The engine smoke

A Dot's guest runs two daemons as two users: `dot-agentd` as `dot`, the engine
(`invisible_engine_dots`, run as `python -m nanobot`) as `dotengine`. The unit tests of
each side cannot show that the two work together as the golden image and the runtime
disk lay them out. This smoke does, in one Linux container, with no QEMU:

- the engine's Python environment is built exactly as `builder/provision.sh` builds
  it: the pinned `uv` (checked against `pins.json`), then
  `builder/build-engine-env.sh` on the hashed `builder/engine-requirements.lock`;
- the engine's source is staged as the runtime ISO stages it (every `.py`, the `.md`
  templates, the lock, `LICENSE`, `UPSTREAM.md`) and every module imports with what
  the lock installed and nothing else;
- `dot-agentd`, built from the same tree, and the engine run under their two users
  with `install.sh`'s directories and socket modes, a fake host talking to
  `dot-agentd`'s TCP port with the Dot's token, and a stand-in for OpenRouter;
- the checks (`smoke.sh`) are about the seams: privileges (the engine has no sudo
  rule and cannot read the host's token, `dot` cannot read the engine's state),
  the event stream (`seq` 1..N across `kill -9`, no loss, no repeat), commands
  that run as `dot` and end with the call that started them (cancel, terminate,
  SIGTERM within systemd's 30 s), a program on a pseudo-terminal (`exec` with `tty`) that
  sees an 80x24 terminal and is answered through `exec_session`, its output read as the
  screen's text with no escape sequence and whose `tool.called` says `tty`, approvals that survive a crash, the cost cap that
  stops a task and a chat turn and still holds after a crash, the `spent_usd` the
  events of tasks and chat answers carry, the `target` of `tool.called` (the command with
  its credential masked, a token flag and a `curl -U` proxy login alike, the path a file tool wrote and none of the content), the tools offered
  for each permission map, the summary of an outgrown thread going to the
  `models.summary` model with no tool in the request, the text sent to the model, the key reaching no file,
  log or process environment, and the engine refusing to start on a lock that is not
  the golden image's or on a key in a dotenv file.

## Run it

Only docker is needed, with the images `golang:1.26` and `ubuntu:24.04` (pulled when
absent; the container downloads the pinned `uv` and the locked wheels).

```sh
guest/image-builder/test/smoke/run.sh                  # the repository this script is in
guest/image-builder/test/smoke/run.sh /path/to/tree    # another checkout
git archive --format=tar -o head.tar HEAD
guest/image-builder/test/smoke/run.sh --archive head.tar   # the commit as committed
```

The same command runs from a Linux shell and from WSL on a Windows host (use the
`/mnt/c/...` path of the repository there). The last line is

```
SMOKE: <passed> passed, <failed> failed, <skipped> skipped
```

and the exit status is 0 only for `0 failed, 0 skipped` and at least one check passed:
a failed check, a skipped check, and a run that never reached the summary all exit 1.
Nothing is kept between runs: the tree is mounted read-only (an archive is unpacked into
a docker volume), what is built goes to a docker volume made for the run, and `run.sh`
removes the volume and the container on exit.

## The files

| file | what it is |
|---|---|
| `run.sh` | the entry: builds `dot-agentd` in `golang:1.26`, starts `ubuntu:24.04` with the tree, checks the exit status and the summary line |
| `prepare-engine.sh` | in the container: `uv`, the engine's environment, the staged engine source; then it runs `smoke.sh` |
| `smoke.sh` | the checks; prints `PASS:` or `FAIL:` per check and the summary line |
| `fake_openrouter.py` | the stand-in for OpenRouter's chat completions: answers by the last message (`RUN-EXEC <cmd>` makes it call the engine's `exec` tool, `SAY-RUN-EXEC <text> :: <cmd>` the same with `<text>` written beside the call, `WRITE-NOTE <path> :: <text>` a `write_file` into `/home/dot/memory/<path>`, `FIND-NOTE <word>` a `memory_search`, `REPEAT-EXEC <cmd>` an `exec` after every result too, a `COST <usd>` line the cost every response reports in its usage) and logs every request whole |
| `host-stream.sh` | the fake host's event reader: reads `/v1/agent/events/stream` from its last `seq`, reconnects after a drop, pushes the key and the config on every `agent.started` |

`smoke.sh` is written against the engine as it is: a check that pins something the
engine no longer has is deleted with it. `PIN_REMOVALS` (see the top of `smoke.sh`)
is the one switch left; it reaches the container only when it is set in the
environment of `run.sh`, and a check it leaves out counts as skipped, which fails the
run.

## In CI

The `smoke` job of `.github/workflows/tests.yml` runs `run.sh` on the checkout, on
`ubuntu-latest`, and the `gate` job needs it like every other job.
`tests/repo/engine-smoke.test.ts` keeps the files, the job and the exit rule from
drifting apart.
