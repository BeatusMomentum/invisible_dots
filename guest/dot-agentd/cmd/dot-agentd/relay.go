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

// envFromFlags collects repeated --env-from NAME flags.
type envFromFlags []string

func (e *envFromFlags) String() string { return "" }

func (e *envFromFlags) Set(v string) error {
	if v == "" || strings.Contains(v, "=") {
		// Not echoed: a caller that wrote NAME=VALUE here has put a secret on a command line.
		return fmt.Errorf("--env-from takes a variable name, not NAME=VALUE")
	}
	*e = append(*e, v)
	return nil
}

// forwardEnv adds to env each variable of names with the value lookup finds: the way a secret reaches the
// program without being on the relay's command line, which every user of the machine can read in /proc.
// The relay's environment is readable by its owner only.
func forwardEnv(env envFlags, names []string, lookup func(string) (string, bool)) error {
	for _, name := range names {
		value, ok := lookup(name)
		if !ok {
			return fmt.Errorf("--env-from %s: not set in the relay's environment", name)
		}
		env[name] = value
	}
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
	var envFrom envFromFlags
	fs.Var(&envFrom, "env-from", "NAME of a variable of this process's own environment, added to the program's environment; for secrets; repeatable")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := forwardEnv(env, envFrom, os.LookupEnv); err != nil {
		fmt.Fprintln(os.Stderr, "dot-agentd relay:", err)
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
