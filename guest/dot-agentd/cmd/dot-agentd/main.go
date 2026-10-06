// Command dot-agentd is the computer daemon of a Dot's VM. It serves the
// routes of architecture section 5.2 on TCP port 1024, which the host reaches
// through QEMU's port forward (token required), and on a local unix socket for
// the engine (no token, no agent proxy, plus the process route).
//
// `dot-agentd relay [flags] -- PROGRAM [ARGS...]` is the client of that
// process route: the engine runs the model's commands through it, so they run
// as the Dot's user, not as the engine's.
//
// Every flag can also be set through the environment variable named in its
// help text; a flag given on the command line wins over the variable.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/feder-cr/dots/guest/dot-agentd/internal/agentd"
)

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

type settings struct {
	configPath   string
	home         string
	runDir       string
	agentdSocket string
	agentSocket  string
	listen       string
	display      string
	importBin    string
	logLevel     string
	// runAs is the user the model's commands run as; empty runs them as the daemon's own.
	runAs string
}

func parseFlags(args []string) (settings, error) {
	var s settings
	fs := flag.NewFlagSet("dot-agentd", flag.ContinueOnError)
	fs.StringVar(&s.configPath, "config", envOr("INVISIBLE_DOTS_GUEST_CONFIG", agentd.DefaultConfigPath), "guest config with the Dot token (INVISIBLE_DOTS_GUEST_CONFIG)")
	// DOT_HOME, not INVISIBLE_DOTS_HOME: that name is the host's data
	// directory (architecture 3.2), and one name must not mean two places.
	fs.StringVar(&s.home, "home", envOr("DOT_HOME", agentd.DefaultHome), "the Dot's home directory, which relative paths resolve against (DOT_HOME)")
	fs.StringVar(&s.runDir, "run-dir", envOr("INVISIBLE_DOTS_RUN_DIR", agentd.DefaultRunDir), "directory of agentd.sock and agent.sock (INVISIBLE_DOTS_RUN_DIR)")
	fs.StringVar(&s.agentdSocket, "agentd-socket", os.Getenv("INVISIBLE_DOTS_AGENTD_SOCKET"), "local socket of this daemon, default <run-dir>/agentd.sock (INVISIBLE_DOTS_AGENTD_SOCKET)")
	fs.StringVar(&s.agentSocket, "agent-socket", envOr("INVISIBLE_DOTS_AGENT_SOCKET", agentd.DefaultAgentSocket), "socket of the agent, in a directory of the engine's user (INVISIBLE_DOTS_AGENT_SOCKET)")
	fs.StringVar(&s.listen, "listen", envOr("INVISIBLE_DOTS_AGENTD_LISTEN", agentd.DefaultListenAddr), "IP address and TCP port of the token-protected routes (INVISIBLE_DOTS_AGENTD_LISTEN)")
	fs.StringVar(&s.display, "display", envOr("INVISIBLE_DOTS_DISPLAY", agentd.DefaultDisplay), "X display for screenshots and exec (INVISIBLE_DOTS_DISPLAY)")
	fs.StringVar(&s.importBin, "import-bin", envOr("INVISIBLE_DOTS_IMPORT_BIN", agentd.DefaultImportBin), "path of ImageMagick's import executable (INVISIBLE_DOTS_IMPORT_BIN)")
	fs.StringVar(&s.runAs, "run-as", envOr("INVISIBLE_DOTS_RUN_AS", agentd.DefaultRunAs), "user the model's commands, the files done for the model and screenshots run as; the daemon needs CAP_SETUID, CAP_SETGID and CAP_KILL for it; --run-as= (empty) runs them as the daemon's own user (INVISIBLE_DOTS_RUN_AS)")
	fs.StringVar(&s.logLevel, "log-level", envOr("INVISIBLE_DOTS_LOG_LEVEL", "info"), "debug, info, warn or error (INVISIBLE_DOTS_LOG_LEVEL)")
	if err := fs.Parse(args); err != nil {
		return s, err
	}
	if fs.NArg() > 0 {
		return s, fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if s.agentdSocket == "" {
		s.agentdSocket = filepath.Join(s.runDir, "agentd.sock")
	}
	return s, nil
}

func parseLevel(s string) (slog.Level, error) {
	var l slog.Level
	err := l.UnmarshalText([]byte(s))
	return l, err
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "relay" {
		os.Exit(runRelay(os.Args[2:]))
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "dot-agentd:", err)
		os.Exit(1)
	}
}

func run() error {
	s, err := parseFlags(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	level, err := parseLevel(s.logLevel)
	if err != nil {
		return fmt.Errorf("--log-level: %w", err)
	}
	// journald adds its own timestamps; keep the lines short.
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return serve(ctx, s, log, nil)
}

// serve runs the daemon until ctx is done or a listener fails. onListen, when
// set, learns each listener's address once it accepts connections; the tests
// use it to find the port the kernel picked for ":0".
func serve(ctx context.Context, s settings, log *slog.Logger, onListen func(name string, addr net.Addr)) error {
	// The TCP port is always open, so the token is always required: there is
	// no mode that serves the remote routes unauthenticated.
	cfg, err := agentd.LoadBootConfig(s.configPath)
	if err != nil {
		return err
	}
	log.Info("guest config loaded", "path", s.configPath, "dot_id", cfg.DotID)

	// Whatever the unit granted as ambient capabilities (CAP_SETUID, CAP_SETGID, CAP_KILL) is
	// emptied before anything is started, whoever the model's commands run as: left in the set,
	// every command of the model would keep them across exec and could become root. The daemon
	// keeps what it holds, which is all it needs to act as another user.
	if err := agentd.ForgetAmbientCapabilities(); err != nil {
		return err
	}

	var account *agentd.Account
	if s.runAs != "" {
		if account, err = agentd.ResolveRunAs(s.runAs); err != nil {
			return err
		}
		log.Info("the model's commands run as", "user", account.Name, "uid", account.UID)
	}
	if account == nil || account.SharesDaemonUser() {
		log.Warn("the model's commands run as the daemon's own user: they can read the Dot's token and reach the engine's socket (architecture 4.1)")
	}

	srv := agentd.New(agentd.Options{
		Token:       cfg.Token,
		Home:        s.home,
		RunAs:       account,
		AgentSocket: s.agentSocket,
		Display:     s.display,
		ImportBin:   s.importBin,
		Logger:      log,
	})

	// The unix listener goes first: it changes the process umask briefly,
	// which is only safe while nothing else creates files.
	localLn, err := agentd.ListenUnix(s.agentdSocket)
	if err != nil {
		return err
	}
	defer os.Remove(s.agentdSocket)
	tcpLn, err := agentd.ListenTCP(s.listen)
	if err != nil {
		_ = localLn.Close()
		return err
	}

	type served struct {
		name string
		ln   net.Listener
		h    http.Handler
	}
	listeners := []served{
		{"unix " + s.agentdSocket, localLn, srv.LocalHandler()},
		{"tcp " + tcpLn.Addr().String(), tcpLn, srv.RemoteHandler()},
	}

	var wg sync.WaitGroup
	errs := make(chan error, len(listeners))
	servers := make([]*http.Server, 0, len(listeners))
	for _, l := range listeners {
		hs := agentd.NewHTTPServer(l.h, log)
		servers = append(servers, hs)
		log.Info("listening", "on", l.name)
		if onListen != nil {
			onListen(l.name, l.ln.Addr())
		}
		wg.Add(1)
		go func(name string, ln net.Listener) {
			defer wg.Done()
			if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errs <- fmt.Errorf("serve %s: %w", name, err)
			}
		}(l.name, l.ln)
	}

	var runErr error
	select {
	case <-ctx.Done():
		log.Info("shutting down")
	case runErr = <-errs:
		log.Error("listener failed", "error", runErr)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, hs := range servers {
		// Open event streams never finish on their own; after the grace
		// period they are cut.
		if err := hs.Shutdown(shutdownCtx); err != nil {
			_ = hs.Close()
		}
	}
	wg.Wait()
	return runErr
}
