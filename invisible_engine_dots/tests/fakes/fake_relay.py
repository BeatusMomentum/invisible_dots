"""A stand-in for `dot-agentd relay`, run by the tests as the relay binary.

It parses the flags the way guest/dot-agentd/cmd/dot-agentd/relay.go does:

    relay [--socket P] [--cwd DIR] [--tty] [--env NAME=VALUE]... [--env-from NAME]... -- PROGRAM [ARGS...]

appends the invocation as one JSON line to the file named by FAKE_RELAY_LOG
(when set), and replaces itself with PROGRAM, so the relay's process group and
exit status are the program's, as with the real relay. FAKE_RELAY_LOG belongs to
the test, not to the program: it is dropped before the exec.
"""

from __future__ import annotations

import json
import os
import sys

LOG_VARIABLE = "FAKE_RELAY_LOG"


def parse_relay_args(args: list[str]) -> dict[str, object]:
    """Parse the arguments after `relay` as Go's flag package does for relay.go.

    Flags may use one or two dashes and `--flag value` or `--flag=value`; the
    first argument that is not a flag, or `--`, starts the program.
    """
    socket = ""
    cwd = ""
    tty = False
    env: list[str] = []
    env_from: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            index += 1
            break
        if not arg.startswith("-") or arg == "-":
            break
        name, has_value, value = arg.lstrip("-").partition("=")
        if name == "tty":
            tty = value != "false" if has_value else True
        elif name in ("socket", "cwd", "env", "env-from"):
            if not has_value:
                index += 1
                if index >= len(args):
                    raise ValueError(f"flag needs an argument: -{name}")
                value = args[index]
            if name == "socket":
                socket = value
            elif name == "cwd":
                cwd = value
            elif name == "env-from":
                if not value or "=" in value:
                    raise ValueError("--env-from takes a variable name, not NAME=VALUE")
                env_from.append(value)
            else:
                if not value.partition("=")[0] or "=" not in value:
                    raise ValueError(f"--env takes NAME=VALUE, got {value!r}")
                env.append(value)
        else:
            raise ValueError(f"flag provided but not defined: -{name}")
        index += 1
    program = args[index:]
    if not program:
        raise ValueError("name the program to run after --")
    return {"socket": socket, "cwd": cwd, "tty": tty, "env": env, "env_from": env_from, "program": program}


def main(argv: list[str]) -> int:
    args = argv[1:]
    if args and args[0] == "relay":
        args = args[1:]
    try:
        parsed = parse_relay_args(args)
    except ValueError as exc:
        sys.stderr.write(f"fake relay: {exc}\n")
        return 2

    log_path = os.environ.pop(LOG_VARIABLE, "")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(json.dumps({"argv": args, **parsed}) + "\n")

    for pair in parsed["env"]:  # type: ignore[union-attr]
        name, _, value = pair.partition("=")
        os.environ[name] = value
    for name in parsed["env_from"]:  # type: ignore[union-attr]
        if name not in os.environ:
            sys.stderr.write(f"fake relay: --env-from {name}: not set in the relay's environment\n")
            return 2
    if parsed["cwd"]:
        try:
            os.chdir(str(parsed["cwd"]))
        except OSError as exc:
            sys.stderr.write(f"fake relay: cwd {parsed['cwd']}: {exc.strerror}\n")
            return 125
    program = parsed["program"]
    try:
        os.execvp(program[0], program)  # type: ignore[index]
    except OSError as exc:
        sys.stderr.write(f"fake relay: {program[0]}: {exc.strerror}\n")  # type: ignore[index]
        return 127


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
