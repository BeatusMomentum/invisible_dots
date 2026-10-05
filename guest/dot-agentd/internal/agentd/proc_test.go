//go:build linux

package agentd

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// localSocket serves the local handler on a unix socket, as the daemon does.
func localSocket(t *testing.T) (string, *Server) {
	t.Helper()
	home := t.TempDir()
	srv := New(Options{Home: home, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	sock := filepath.Join(shortTempDir(t), "agentd.sock")
	ln, err := ListenUnix(sock)
	if err != nil {
		t.Fatal(err)
	}
	hs := NewHTTPServer(srv.LocalHandler(), nil)
	go func() { _ = hs.Serve(ln) }()
	t.Cleanup(func() { _ = hs.Close() })
	return sock, srv
}

func relay(t *testing.T, sock string, opts RelayOptions, stdin string) (int, string, string) {
	t.Helper()
	opts.Socket = sock
	var out, errOut bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var in io.Reader
	if stdin != "" {
		in = strings.NewReader(stdin)
	}
	code, err := RunRelay(ctx, opts, in, &out, &errOut)
	if err != nil {
		t.Fatal(err)
	}
	return code, out.String(), errOut.String()
}

func TestProcRunsAProgramWithItsOutputsAndExitCode(t *testing.T) {
	sock, srv := localSocket(t)
	code, out, errOut := relay(t, sock, RelayOptions{
		Argv: []string{"/bin/sh", "-c", `echo "out $FOO $(pwd)"; echo err >&2; exit 3`},
		Env:  map[string]string{"FOO": "bar"},
	}, "")
	if code != 3 || out != "out bar "+srv.opts.Home+"\n" || errOut != "err\n" {
		t.Fatalf("code %d, out %q, err %q", code, out, errOut)
	}
}

func TestProcPassesInputThroughAndEndsIt(t *testing.T) {
	sock, _ := localSocket(t)
	code, out, _ := relay(t, sock, RelayOptions{Argv: []string{"/bin/sh", "-c", "tr a-z A-Z"}}, "hello\n")
	if code != 0 || out != "HELLO\n" {
		t.Fatalf("code %d, out %q", code, out)
	}
}

func TestProcRunsOnATerminalOfTheAskedSize(t *testing.T) {
	sock, _ := localSocket(t)
	code, out, _ := relay(t, sock, RelayOptions{
		Argv: []string{"/bin/sh", "-c", `test -t 0 && echo tty; stty size; echo "$TERM"`},
		TTY:  &ProcTTY{Cols: 100, Rows: 30},
	}, "")
	out = strings.ReplaceAll(out, "\r", "")
	if code != 0 || out != "tty\n30 100\nxterm-256color\n" {
		t.Fatalf("code %d, out %q", code, out)
	}
}

func TestProcFollowsAResizeAndForwardsSignals(t *testing.T) {
	sock, _ := localSocket(t)
	resize := make(chan ProcTTY, 1)
	signals := make(chan syscall.Signal, 1)
	resize <- ProcTTY{Cols: 50, Rows: 10}
	go func() {
		time.Sleep(500 * time.Millisecond)
		signals <- syscall.SIGTERM
	}()
	code, out, _ := relay(t, sock, RelayOptions{
		Argv:    []string{"/bin/sh", "-c", `sleep 0.3; stty size; sleep 30`},
		TTY:     &ProcTTY{Cols: 80, Rows: 24},
		Resize:  resize,
		Signals: signals,
	}, "")
	if !strings.Contains(out, "10 50") {
		t.Errorf("the resize did not reach the terminal: %q", out)
	}
	if code != 128+int(syscall.SIGTERM) {
		t.Errorf("code %d, want %d", code, 128+int(syscall.SIGTERM))
	}
}

func TestProcDiesWithItsCaller(t *testing.T) {
	sock, _ := localSocket(t)
	pidFile := filepath.Join(t.TempDir(), "pid")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = RunRelay(ctx, RelayOptions{
			Socket: sock,
			Argv:   []string{"/bin/sh", "-c", `sleep 300 & echo $! > ` + pidFile + `; wait`},
		}, nil, io.Discard, io.Discard)
	}()
	var pid int
	for i := 0; i < 100 && pid == 0; i++ {
		time.Sleep(50 * time.Millisecond)
		if raw, err := os.ReadFile(pidFile); err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		}
	}
	if pid == 0 {
		t.Fatal("the command never started")
	}
	cancel()
	<-done
	for i := 0; i < 100; i++ {
		if syscall.Kill(pid, 0) != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the background child %d outlived the caller", pid)
}

func TestProcRefusesBadRequestsAndIsNotOnTheTCPPort(t *testing.T) {
	sock, _ := localSocket(t)
	_, err := RunRelay(context.Background(), RelayOptions{Socket: sock, Argv: []string{"/bin/true"}, Cwd: "nope/missing"},
		nil, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "invalid_cwd") {
		t.Errorf("a missing cwd: %v", err)
	}
	_, err = RunRelay(context.Background(), RelayOptions{Socket: sock, Argv: []string{""}}, nil, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "invalid_body") {
		t.Errorf("an empty program: %v", err)
	}
	f := newFixture(t)
	resp := f.postJSON("/v1/proc", ProcRequest{Argv: []string{"/bin/true"}})
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("the TCP port answered %d to /v1/proc", resp.StatusCode)
	}
}

func TestProcAsksForTheProtocolSwitch(t *testing.T) {
	sock, _ := localSocket(t)
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	resp, err := client.Post("http://agentd/v1/proc", "application/json", strings.NewReader(`{"argv":["/bin/true"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUpgradeRequired || resp.Header.Get("Upgrade") != ProcUpgradeProtocol {
		t.Errorf("status %d, upgrade %q", resp.StatusCode, resp.Header.Get("Upgrade"))
	}
}
