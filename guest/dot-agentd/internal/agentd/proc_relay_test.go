//go:build linux

package agentd

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The engine ends a command of the model by killing the relay it started, in
// the relay's own process group (nanobot/dots/computer.py kill_process_group,
// after a cancelled turn, a terminated exec session or a timeout). Nothing
// tells dot-agentd: the kernel closes the relay's socket, and dot-agentd must
// end the remote process group, background children included. These tests run
// the relay the way the engine does, as a process of its own, and kill it the
// way the engine does.

const (
	relayHelperSocket = "AGENTD_TEST_RELAY_SOCKET"
	relayHelperScript = "AGENTD_TEST_RELAY_SCRIPT"
	relayHelperTTY    = "AGENTD_TEST_RELAY_TTY"
)

// TestMain turns the test binary into the relay when a test starts it as one.
func TestMain(m *testing.M) {
	if socket := os.Getenv(relayHelperSocket); socket != "" {
		opts := RelayOptions{Socket: socket, Argv: []string{"/bin/sh", "-c", os.Getenv(relayHelperScript)}}
		if os.Getenv(relayHelperTTY) != "" {
			opts.TTY = &ProcTTY{Cols: 80, Rows: 24}
		}
		code, err := RunRelay(context.Background(), opts, nil, os.Stdout, os.Stderr)
		if err != nil {
			os.Stderr.WriteString(err.Error() + "\n")
			os.Exit(1)
		}
		os.Exit(code)
	}
	os.Exit(m.Run())
}

// gone reports whether pid no longer runs: it is not there, or it is a zombie
// nobody has collected yet (a process whose parent died is reparented to an init
// that may not reap at once).
func gone(pid int) bool {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true
	}
	stat := string(raw)
	end := strings.LastIndexByte(stat, ')')
	return end >= 0 && len(stat) > end+2 && stat[end+2] == 'Z'
}

func readPID(t *testing.T, file string) int {
	t.Helper()
	for i := 0; i < 200; i++ {
		if raw, err := os.ReadFile(file); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
				return pid
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never got a pid: the command did not start", file)
	return 0
}

func TestKillingTheRelayProcessEndsTheRemoteProcessGroup(t *testing.T) {
	for _, tty := range []bool{false, true} {
		name := "pipes"
		if tty {
			name = "terminal"
		}
		t.Run(name, func(t *testing.T) {
			sock, _ := localSocket(t)
			dir := t.TempDir()
			shellPID, childPID := filepath.Join(dir, "shell"), filepath.Join(dir, "child")
			// The command's shell, a background child it leaves behind and a foreground wait: what a model's
			// `server & tail -f log` looks like.
			script := `echo $$ > ` + shellPID + `; sleep 300 & echo $! > ` + childPID + `; wait`

			relay := exec.Command(os.Args[0])
			relay.Env = append(os.Environ(), relayHelperSocket+"="+sock, relayHelperScript+"="+script)
			if tty {
				relay.Env = append(relay.Env, relayHelperTTY+"=1")
			}
			// start_new_session=True: the relay leads its own group, as the engine starts it.
			relay.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if err := relay.Start(); err != nil {
				t.Fatal(err)
			}
			waited := make(chan struct{})
			go func() { _ = relay.Wait(); close(waited) }()
			t.Cleanup(func() { _ = syscall.Kill(-relay.Process.Pid, syscall.SIGKILL) })

			shell, child := readPID(t, shellPID), readPID(t, childPID)
			if gone(shell) || gone(child) {
				t.Fatalf("the command is not running before the kill (shell %d, child %d)", shell, child)
			}

			// os.killpg(relay.pid, SIGKILL): the relay dies without a word to dot-agentd.
			if err := syscall.Kill(-relay.Process.Pid, syscall.SIGKILL); err != nil {
				t.Fatal(err)
			}
			<-waited

			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) && !(gone(shell) && gone(child)) {
				time.Sleep(50 * time.Millisecond)
			}
			if !gone(shell) {
				t.Errorf("the remote shell %d outlived its relay", shell)
			}
			if !gone(child) {
				t.Errorf("the remote background child %d outlived its relay", child)
			}
		})
	}
}

func TestACancelledTerminalCommandLeavesNoBackgroundChild(t *testing.T) {
	// The terminal leads a session, not a group made by Setpgid: the cancel of a caller that
	// is still attached must end it all the same.
	sock, _ := localSocket(t)
	dir := t.TempDir()
	childPID := filepath.Join(dir, "child")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = RunRelay(ctx, RelayOptions{
			Socket: sock,
			Argv:   []string{"/bin/sh", "-c", `sleep 300 & echo $! > ` + childPID + `; wait`},
			TTY:    &ProcTTY{Cols: 80, Rows: 24},
		}, nil, io.Discard, io.Discard)
	}()
	child := readPID(t, childPID)
	cancel()
	<-done
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !gone(child) {
		time.Sleep(50 * time.Millisecond)
	}
	if !gone(child) {
		t.Fatalf("the background child %d of a terminal command outlived the caller", child)
	}
}
