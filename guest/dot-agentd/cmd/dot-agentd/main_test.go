package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const testToken = "main-test-token-abcdef"

// shortTempDir keeps unix socket paths under the 108-byte sun_path limit.
func shortTempDir(t *testing.T) string {
	t.Helper()
	base := ""
	if runtime.GOOS != "windows" {
		base = "/tmp"
	}
	dir, err := os.MkdirTemp(base, "agentdmain")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func clearEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"INVISIBLE_DOTS_GUEST_CONFIG", "DOT_HOME", "INVISIBLE_DOTS_HOME", "INVISIBLE_DOTS_RUN_DIR",
		"INVISIBLE_DOTS_AGENTD_SOCKET", "INVISIBLE_DOTS_AGENT_SOCKET", "INVISIBLE_DOTS_AGENTD_LISTEN",
		"INVISIBLE_DOTS_DISPLAY", "INVISIBLE_DOTS_IMPORT_BIN", "INVISIBLE_DOTS_LOG_LEVEL", "INVISIBLE_DOTS_RUN_AS",
	} {
		t.Setenv(name, "")
	}
}

func TestParseFlagsDefaultsMatchTheContract(t *testing.T) {
	clearEnv(t)
	s, err := parseFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	// Architecture 3.4 forwards the host port to guest port 1024.
	if s.listen != "0.0.0.0:1024" {
		t.Errorf("listen %q", s.listen)
	}
	if s.configPath != "/etc/invisible-dots/config.json" || s.home != "/home/dot" {
		t.Errorf("got %+v", s)
	}
	// The model's commands run as dot, not as the daemon's own user (architecture 4.1).
	if s.runAs != "dot" {
		t.Errorf("run-as %q", s.runAs)
	}
	if filepath.ToSlash(s.agentdSocket) != "/run/invisible-dots/agentd.sock" ||
		filepath.ToSlash(s.agentSocket) != "/run/invisible-dots-agent/agent.sock" {
		t.Errorf("sockets %q %q", s.agentdSocket, s.agentSocket)
	}
}

func TestParseFlagsEnvironmentAndFlagPrecedence(t *testing.T) {
	clearEnv(t)
	t.Setenv("INVISIBLE_DOTS_AGENTD_LISTEN", "127.0.0.1:2000")
	s, err := parseFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.listen != "127.0.0.1:2000" {
		t.Errorf("from the environment: %q", s.listen)
	}
	s, err = parseFlags([]string{"--listen", "10.0.2.15:3000"})
	if err != nil {
		t.Fatal(err)
	}
	if s.listen != "10.0.2.15:3000" {
		t.Errorf("the flag must win over the environment: %q", s.listen)
	}
}

func TestParseFlagsReadsTheHomeFromDotHomeOnly(t *testing.T) {
	clearEnv(t)
	// The host's variable means the host's data directory; the guest never reads it.
	t.Setenv("INVISIBLE_DOTS_HOME", "/home/someone/.invisible-dots")
	s, err := parseFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.home != "/home/dot" {
		t.Errorf("INVISIBLE_DOTS_HOME changed the home to %q", s.home)
	}
	t.Setenv("DOT_HOME", "/srv/dot")
	if s, err = parseFlags(nil); err != nil || s.home != "/srv/dot" {
		t.Errorf("DOT_HOME: %q, %v", s.home, err)
	}
}

func TestParseFlagsRejectsUnknownFlagsAndStrayArguments(t *testing.T) {
	clearEnv(t)
	for _, args := range [][]string{{"--no-such-flag"}, {"--listen"}, {"extra"}} {
		if _, err := parseFlags(args); err == nil {
			t.Errorf("%v was accepted", args)
		}
	}
}

type daemon struct {
	tcpAddr string
	unix    string
	cancel  context.CancelFunc
	done    chan error
}

// startDaemon runs serve exactly as main does, on a kernel-chosen loopback port.
func startDaemon(t *testing.T, token string) (*daemon, error) {
	t.Helper()
	dir := shortTempDir(t)
	cfg := filepath.Join(dir, "config.json")
	if err := os.WriteFile(cfg, []byte(`{"dotId":"dot_test","token":"`+token+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := settings{
		configPath:   cfg,
		home:         dir,
		runDir:       dir,
		agentdSocket: filepath.Join(dir, "agentd.sock"),
		agentSocket:  filepath.Join(dir, "agent.sock"),
		listen:       "127.0.0.1:0",
		display:      ":0",
		importBin:    "import",
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &daemon{unix: s.agentdSocket, cancel: cancel, done: make(chan error, 1)}
	var mu sync.Mutex
	ready := make(chan struct{})
	seen := 0
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	go func() {
		d.done <- serve(ctx, s, log, func(name string, addr net.Addr) {
			mu.Lock()
			defer mu.Unlock()
			if strings.HasPrefix(name, "tcp ") {
				d.tcpAddr = addr.String()
			}
			if seen++; seen == 2 {
				close(ready)
			}
		})
	}()
	select {
	case <-ready:
	case err := <-d.done:
		cancel()
		return nil, err
	case <-time.After(10 * time.Second):
		cancel()
		t.Fatal("the daemon never listened")
	}
	t.Cleanup(func() {
		cancel()
		<-d.done
	})
	return d, nil
}

func get(t *testing.T, client *http.Client, url, auth string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.StatusCode
}

func TestServeTCPNeedsTheTokenAndTheUnixSocketDoesNot(t *testing.T) {
	d, err := startDaemon(t, testToken)
	if err != nil {
		t.Fatal(err)
	}
	tcp := &http.Client{Timeout: 5 * time.Second}
	base := "http://" + d.tcpAddr
	if code := get(t, tcp, base+"/v1/health", ""); code != http.StatusUnauthorized {
		t.Errorf("tcp without token: %d", code)
	}
	if code := get(t, tcp, base+"/v1/health", "Bearer wrong"); code != http.StatusUnauthorized {
		t.Errorf("tcp with a wrong token: %d", code)
	}
	if code := get(t, tcp, base+"/v1/health", "Bearer "+testToken); code != http.StatusOK {
		t.Errorf("tcp with the token: %d", code)
	}

	local := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dl net.Dialer
			return dl.DialContext(ctx, "unix", d.unix)
		},
	}}
	if code := get(t, local, "http://agentd/v1/health", ""); code != http.StatusOK {
		t.Errorf("unix socket: %d", code)
	}

	d.cancel()
	select {
	case err := <-d.done:
		d.done <- err // for the cleanup
		if err != nil {
			t.Errorf("serve returned %v after cancel", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not stop")
	}
	if _, err := os.Lstat(d.unix); !os.IsNotExist(err) {
		t.Errorf("agentd.sock left behind: %v", err)
	}
	if _, err := net.DialTimeout("tcp", d.tcpAddr, time.Second); err == nil {
		t.Error("the TCP port still accepts connections after shutdown")
	}
}

func TestServeRefusesToStartWithoutAToken(t *testing.T) {
	if _, err := startDaemon(t, ""); err == nil || !strings.Contains(err.Error(), "no token") {
		t.Fatalf("got %v, want a missing token error", err)
	}
}

func TestServeReportsAnInvalidListenAddress(t *testing.T) {
	dir := shortTempDir(t)
	cfg := filepath.Join(dir, "config.json")
	if err := os.WriteFile(cfg, []byte(`{"dotId":"d","token":"t"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := settings{configPath: cfg, home: dir, agentdSocket: filepath.Join(dir, "agentd.sock"), agentSocket: filepath.Join(dir, "agent.sock"), listen: "localhost:1024"}
	err := serve(context.Background(), s, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err == nil || !strings.Contains(err.Error(), "IP address") {
		t.Fatalf("got %v", err)
	}
	// A failed start must not leave the unix socket it already opened.
	if _, err := os.Lstat(s.agentdSocket); !os.IsNotExist(err) {
		t.Errorf("agentd.sock left behind: %v", err)
	}
}

func TestServeRefusesToStartWhenTheUserForTheModelDoesNotExist(t *testing.T) {
	dir := shortTempDir(t)
	cfg := filepath.Join(dir, "config.json")
	if err := os.WriteFile(cfg, []byte(`{"dotId":"d","token":"t"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := settings{
		configPath: cfg, home: dir, agentdSocket: filepath.Join(dir, "agentd.sock"), agentSocket: filepath.Join(dir, "agent.sock"),
		listen: "127.0.0.1:0", runAs: "no-such-user-for-the-model",
	}
	err := serve(context.Background(), s, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err == nil {
		t.Fatal("the daemon started with nobody to run the model's commands as")
	}
	// Refused before anything listens: a daemon that cannot change to the Dot's user must not serve.
	if _, err := os.Lstat(s.agentdSocket); !os.IsNotExist(err) {
		t.Errorf("agentd.sock opened: %v", err)
	}
}
