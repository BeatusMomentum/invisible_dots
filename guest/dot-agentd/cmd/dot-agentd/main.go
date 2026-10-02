// Command dot-agentd is the computer daemon of a Dot's VM. It serves the
// routes of architecture section 5.2 on vsock (token required) and on a local
// unix socket for the agent (no token, no agent proxy).
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
	"strconv"
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
	vsockPort    uint
	noVsock      bool
	listenTCP    string
	display      string
	importBin    string
	logLevel     string
}

func parseFlags(args []string) (settings, error) {
	var s settings
	fs := flag.NewFlagSet("dot-agentd", flag.ContinueOnError)
	port, err := strconv.ParseUint(envOr("INVISIBLE_DOTS_VSOCK_PORT", strconv.Itoa(agentd.DefaultVsockPort)), 10, 32)
	if err != nil {
		return s, fmt.Errorf("INVISIBLE_DOTS_VSOCK_PORT: %w", err)
	}
	fs.StringVar(&s.configPath, "config", envOr("INVISIBLE_DOTS_GUEST_CONFIG", agentd.DefaultConfigPath), "guest config with the Dot token (INVISIBLE_DOTS_GUEST_CONFIG)")
	fs.StringVar(&s.home, "home", envOr("INVISIBLE_DOTS_HOME", agentd.DefaultHome), "home directory relative paths resolve against (INVISIBLE_DOTS_HOME)")
	fs.StringVar(&s.runDir, "run-dir", envOr("INVISIBLE_DOTS_RUN_DIR", agentd.DefaultRunDir), "directory of agentd.sock and agent.sock (INVISIBLE_DOTS_RUN_DIR)")
	fs.StringVar(&s.agentdSocket, "agentd-socket", os.Getenv("INVISIBLE_DOTS_AGENTD_SOCKET"), "local socket of this daemon, default <run-dir>/agentd.sock (INVISIBLE_DOTS_AGENTD_SOCKET)")
	fs.StringVar(&s.agentSocket, "agent-socket", os.Getenv("INVISIBLE_DOTS_AGENT_SOCKET"), "socket of the agent, default <run-dir>/agent.sock (INVISIBLE_DOTS_AGENT_SOCKET)")
	fs.UintVar(&s.vsockPort, "vsock-port", uint(port), "vsock port (INVISIBLE_DOTS_VSOCK_PORT)")
	fs.BoolVar(&s.noVsock, "no-vsock", envOr("INVISIBLE_DOTS_NO_VSOCK", "") == "1", "do not listen on vsock, for development outside a VM (INVISIBLE_DOTS_NO_VSOCK=1)")
	fs.StringVar(&s.listenTCP, "listen-tcp", os.Getenv("INVISIBLE_DOTS_AGENTD_LISTEN_TCP"), "development only: also serve the token-protected routes on 127.0.0.1:<port> (INVISIBLE_DOTS_AGENTD_LISTEN_TCP)")
	fs.StringVar(&s.display, "display", envOr("INVISIBLE_DOTS_DISPLAY", agentd.DefaultDisplay), "X display for screenshots and exec (INVISIBLE_DOTS_DISPLAY)")
	fs.StringVar(&s.importBin, "import-bin", envOr("INVISIBLE_DOTS_IMPORT_BIN", "import"), "ImageMagick import executable (INVISIBLE_DOTS_IMPORT_BIN)")
	fs.StringVar(&s.logLevel, "log-level", envOr("INVISIBLE_DOTS_LOG_LEVEL", "info"), "debug, info, warn or error (INVISIBLE_DOTS_LOG_LEVEL)")
	if err := fs.Parse(args); err != nil {
		return s, err
	}
	if fs.NArg() > 0 {
		return s, fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if s.vsockPort > 1<<32-1 {
		return s, fmt.Errorf("--vsock-port %d is out of range", s.vsockPort)
	}
	if s.agentdSocket == "" {
		s.agentdSocket = filepath.Join(s.runDir, "agentd.sock")
	}
	if s.agentSocket == "" {
		s.agentSocket = filepath.Join(s.runDir, "agent.sock")
	}
	return s, nil
}

func parseLevel(s string) (slog.Level, error) {
	var l slog.Level
	err := l.UnmarshalText([]byte(s))
	return l, err
}

func main() {
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

	needToken := !s.noVsock || s.listenTCP != ""
	var token string
	if needToken {
		cfg, err := agentd.LoadBootConfig(s.configPath)
		if err != nil {
			return err
		}
		token = cfg.Token
		log.Info("guest config loaded", "path", s.configPath, "dot_id", cfg.DotID)
	}

	srv := agentd.New(agentd.Options{
		Token:       token,
		Home:        s.home,
		AgentSocket: s.agentSocket,
		Display:     s.display,
		ImportBin:   s.importBin,
		Logger:      log,
	})

	// The unix listener goes first: it changes the process umask briefly,
	// which is only safe while nothing else runs.
	localLn, err := agentd.ListenUnix(s.agentdSocket)
	if err != nil {
		return err
	}
	defer os.Remove(s.agentdSocket)

	type served struct {
		name string
		ln   net.Listener
		h    http.Handler
	}
	listeners := []served{{"unix " + s.agentdSocket, localLn, srv.LocalHandler()}}
	if !s.noVsock {
		ln, err := agentd.ListenVsock(uint32(s.vsockPort))
		if err != nil {
			_ = localLn.Close()
			return err
		}
		listeners = append(listeners, served{fmt.Sprintf("vsock port %d", s.vsockPort), ln, srv.RemoteHandler()})
	}
	if s.listenTCP != "" {
		ln, err := agentd.ListenLoopbackTCP(s.listenTCP)
		if err != nil {
			for _, l := range listeners {
				_ = l.ln.Close()
			}
			return err
		}
		listeners = append(listeners, served{"tcp " + ln.Addr().String(), ln, srv.RemoteHandler()})
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var wg sync.WaitGroup
	errs := make(chan error, len(listeners))
	servers := make([]*http.Server, 0, len(listeners))
	for _, l := range listeners {
		hs := &http.Server{
			Handler: l.h,
			// No WriteTimeout: the agent event stream and long exec calls
			// legitimately keep a response open for minutes or hours.
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       2 * time.Minute,
			ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
		}
		servers = append(servers, hs)
		wg.Add(1)
		go func(name string, ln net.Listener) {
			defer wg.Done()
			log.Info("listening", "on", name)
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
