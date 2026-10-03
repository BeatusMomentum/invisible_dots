//go:build unix

package agentd

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func runExec(t *testing.T, f *fixture, body map[string]any) ExecAnswer {
	t.Helper()
	resp := f.postJSON("/v1/exec", body)
	wantStatus(t, resp, http.StatusOK)
	return decode[ExecAnswer](t, resp)
}

func TestExecExitCodeAndStreams(t *testing.T) {
	requireBash(t)
	f := newFixture(t)
	got := runExec(t, f, map[string]any{"command": "echo out; echo err >&2; exit 3"})
	if got.ExitCode != 3 || got.Stdout != "out\n" || got.Stderr != "err\n" || got.TimedOut {
		t.Fatalf("got %+v", got)
	}
}

func TestExecDefaultAndRelativeCwd(t *testing.T) {
	requireBash(t)
	f := newFixture(t)
	if got := runExec(t, f, map[string]any{"command": "pwd -P"}); strings.TrimSpace(got.Stdout) != realPath(t, f.home) {
		t.Errorf("default cwd %q, want %q", got.Stdout, f.home)
	}
	if err := os.MkdirAll(filepath.Join(f.home, "workspace", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := runExec(t, f, map[string]any{"command": "pwd -P", "cwd": "workspace/sub"})
	if want := realPath(t, filepath.Join(f.home, "workspace", "sub")); strings.TrimSpace(got.Stdout) != want {
		t.Errorf("relative cwd %q, want %q", got.Stdout, want)
	}
}

func TestExecSetsDisplay(t *testing.T) {
	requireBash(t)
	t.Setenv("DISPLAY", "")
	os.Unsetenv("DISPLAY")
	f := newFixture(t, func(o *Options) { o.Display = ":7" })
	if got := runExec(t, f, map[string]any{"command": "printf %s \"$DISPLAY\""}); got.Stdout != ":7" {
		t.Errorf("DISPLAY = %q", got.Stdout)
	}
}

func TestExecTimeoutKillsTheProcessGroup(t *testing.T) {
	requireBash(t)
	f := newFixture(t)
	pidFile := filepath.Join(f.home, "child.pid")
	start := time.Now()
	got := runExec(t, f, map[string]any{
		// The background sleep is a grandchild with its own copy of stdout:
		// killing bash alone would leave it running and the pipe open.
		"command":    "sleep 30 & echo $! > " + pidFile + "; echo started; sleep 30",
		"timeout_ms": 300,
	})
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("exec took %s after a 300 ms timeout", elapsed)
	}
	if !got.TimedOut || got.ExitCode != -1 {
		t.Fatalf("got %+v, want timed_out and exit_code -1", got)
	}
	if got.Stdout != "started\n" {
		t.Errorf("output before the timeout was lost: %q", got.Stdout)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		// Signal 0 probes existence; a zombie still answers, so also accept
		// that it is no longer a sleeping child of ours by waiting a little.
		if err := syscall.Kill(pid, 0); err != nil {
			break
		}
		if isZombie(pid) {
			break
		}
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("background child %d survived the timeout", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A caller that goes away (a cancelled call, an agent that died) takes its
// command with it: the whole process group is killed, long before the
// command's own timeout.
func TestExecCallerGoneKillsTheProcessGroup(t *testing.T) {
	requireBash(t)
	f := newFixture(t)
	pidFile := filepath.Join(f.home, "child.pid")
	raw, err := json.Marshal(map[string]any{
		"command":    "sleep 30 & echo $! > " + pidFile + "; wait",
		"timeout_ms": 60_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.baseURL+"/v1/exec", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "application/json")
	done := make(chan error, 1)
	go func() {
		resp, err := f.client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
		}
		done <- err
	}()

	var pid int
	deadline := time.Now().Add(10 * time.Second)
	for pid == 0 {
		if raw, err := os.ReadFile(pidFile); err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		}
		if time.Now().After(deadline) {
			t.Fatal("the command never started")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("the request answered although its caller went away")
	}

	deadline = time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil && !isZombie(pid) {
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("child %d outlived its caller", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestExecCapsEachStreamAtOneMiB(t *testing.T) {
	requireBash(t)
	f := newFixture(t)
	got := runExec(t, f, map[string]any{
		"command": "head -c 3000000 /dev/zero | tr '\\0' a; head -c 1500000 /dev/zero | tr '\\0' b >&2; echo done >&2; exit 0",
	})
	if got.ExitCode != 0 {
		t.Fatalf("a capped command must still finish normally, got exit %d", got.ExitCode)
	}
	if len(got.Stdout) != ExecOutputCap || !got.StdoutTruncated {
		t.Errorf("stdout %d bytes, truncated %v", len(got.Stdout), got.StdoutTruncated)
	}
	if len(got.Stderr) != ExecOutputCap || !got.StderrTruncated {
		t.Errorf("stderr %d bytes, truncated %v", len(got.Stderr), got.StderrTruncated)
	}
	if strings.Trim(got.Stdout, "a") != "" || strings.Trim(got.Stderr, "b") != "" {
		t.Error("the cap must keep the first bytes")
	}

	small := runExec(t, f, map[string]any{"command": "echo hi"})
	if small.StdoutTruncated || small.StderrTruncated {
		t.Errorf("small output marked truncated: %+v", small)
	}
}

func TestExecDoesNotWaitForDetachedChildren(t *testing.T) {
	requireBash(t)
	f := newFixture(t)
	pidFile := filepath.Join(f.home, "bg.pid")
	start := time.Now()
	got := runExec(t, f, map[string]any{"command": "sleep 30 & echo $! > " + pidFile + "; echo ok"})
	if raw, err := os.ReadFile(pidFile); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
		}
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("exec waited %s for a background child", elapsed)
	}
	if got.ExitCode != 0 || got.Stdout != "ok\n" || got.TimedOut {
		t.Errorf("got %+v", got)
	}
}

func TestExecRejectsBadRequests(t *testing.T) {
	f := newFixture(t)
	cases := map[string]map[string]any{
		"empty command":    {"command": "  "},
		"zero timeout":     {"command": "true", "timeout_ms": 0},
		"huge timeout":     {"command": "true", "timeout_ms": 10 * 3600 * 1000},
		"missing cwd":      {"command": "true", "cwd": "does/not/exist"},
		"cwd with NUL":     {"command": "true", "cwd": "a\x00b"},
		"unknown field":    {"command": "true", "shell": "zsh"},
		"command not text": {"command": 5},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			resp := f.postJSON("/v1/exec", body)
			wantStatus(t, resp, http.StatusBadRequest)
		})
	}
	resp := f.do(http.MethodPost, "/v1/exec", strings.NewReader("command=ls"), "Content-Type", "text/plain")
	wantStatus(t, resp, http.StatusUnsupportedMediaType)
}

func TestCappedBuffer(t *testing.T) {
	c := &cappedBuffer{limit: 5}
	for _, chunk := range []string{"ab", "cde", "fg"} {
		if n, err := c.Write([]byte(chunk)); n != len(chunk) || err != nil {
			t.Fatalf("Write(%q) = %d, %v", chunk, n, err)
		}
	}
	if string(c.buf) != "abcde" || !c.truncated {
		t.Errorf("buf %q truncated %v", c.buf, c.truncated)
	}
}

func realPath(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func isZombie(pid int) bool {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true
	}
	// The state is the field after the parenthesised command name.
	s := string(raw)
	i := strings.LastIndexByte(s, ')')
	return i >= 0 && i+2 < len(s) && s[i+2] == 'Z'
}
