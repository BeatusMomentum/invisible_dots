package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/feder-cr/dots/guest/dot-agentd/internal/agentd"
)

// envFlags collects repeated --env NAME=VALUE flags.
type envFlags map[string]string

func (e envFlags) String() string { return "" }

func (e envFlags) Set(v string) error {
	name, value, ok := strings.Cut(v, "=")
	if !ok || name == "" {
		return fmt.Errorf("--env takes NAME=VALUE, got %q", v)
	}
	e[name] = value
	return nil
}

// runRelay is `dot-agentd relay [flags] -- PROGRAM [ARGS...]`: run a program
// through the daemon's local socket as the Dot's user, with this process's
// stdin, stdout, stderr and exit code (architecture 5.2, POST /v1/proc). With
// --tty and a terminal on stdin, the terminal goes raw and its size follows.
func runRelay(args []string) int {
	fs := flag.NewFlagSet("dot-agentd relay", flag.ContinueOnError)
	socket := fs.String("socket", agentd.RelaySocketDefault(), "dot-agentd's local socket (INVISIBLE_DOTS_AGENTD_SOCKET)")
	cwd := fs.String("cwd", "", "working directory, relative to the Dot's home; home when empty")
	tty := fs.Bool("tty", false, "run the program on a pseudo-terminal")
	env := envFlags{}
	fs.Var(env, "env", "NAME=VALUE added to the program's environment; repeatable")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	argv := fs.Args()
	if len(argv) == 0 {
		fmt.Fprintln(os.Stderr, "dot-agentd relay: name the program to run after --")
		return 2
	}
	opts := agentd.RelayOptions{Socket: *socket, Argv: argv, Cwd: *cwd, Env: env}
	var stdin io.Reader = os.Stdin
	if *tty {
		size, isTerminal := agentd.TerminalSize(os.Stdin.Fd())
		if !isTerminal {
			size = agentd.ProcTTY{Cols: 80, Rows: 24}
		} else if restore, err := agentd.MakeRaw(os.Stdin.Fd()); err == nil {
			defer restore()
		}
		opts.TTY = &size
		if isTerminal {
			opts.Resize = agentd.WatchTerminalSize(os.Stdin.Fd())
		}
	}
	opts.Signals = agentd.ForwardedSignals()
	code, err := agentd.RunRelay(context.Background(), opts, stdin, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dot-agentd relay:", err)
		return 255
	}
	return code
}
