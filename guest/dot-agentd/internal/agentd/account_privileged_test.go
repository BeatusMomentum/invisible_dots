//go:build linux && privileged

package agentd

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// The tests of running as another user, which need to become one: they take
// root (the guest's daemon holds CAP_SETUID, CAP_SETGID and CAP_KILL instead)
// and a binary built without cgo (ForgetAmbientCapabilities), so they are built
// only with the tag `privileged`, and the smoke's run.sh runs them as root in
// its Go container, where a skipped one fails the run. The smoke then runs the
// same checks against the daemon as its unit starts it, with those three
// capabilities and nothing else.

// testAccount is a user that is not the one running the tests.
func testAccount(t *testing.T) *Account {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("running as another user needs root here")
	}
	acct, err := LookupAccount("nobody")
	if err != nil {
		t.Skip("no user nobody: " + err.Error())
	}
	return acct
}

// accountHome is a directory the account owns and nobody else may enter, below
// parents the account may walk through.
func accountHome(t *testing.T, acct *Account) string {
	t.Helper()
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(home, int(acct.UID), int(acct.GID)); err != nil {
		t.Fatal(err)
	}
	for dir := filepath.Dir(home); dir != "/"; dir = filepath.Dir(dir) {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(dir, info.Mode().Perm()|0o755); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func TestExecRunsAsTheAccountWithItsEnvironment(t *testing.T) {
	requireBash(t)
	acct := testAccount(t)
	home := accountHome(t, acct)
	f := newFixture(t, func(o *Options) { o.RunAs = acct; o.Home = home })
	t.Setenv("HOME", "/root")
	got := runExec(t, f, map[string]any{"command": `echo "$(id -u):$(id -g):$(id -G) $HOME $USER $LOGNAME $SHELL"; pwd -P`})
	var groups []string
	for _, g := range acct.Groups {
		groups = append(groups, strconv.Itoa(int(g)))
	}
	want := fmt.Sprintf("%d:%d:%s %s %s %s %s\n%s\n", acct.UID, acct.GID, strings.Join(groups, " "), home, acct.Name, acct.Name, acct.Shell, realPath(t, home))
	if got.ExitCode != 0 || got.Stdout != want {
		t.Fatalf("got %+v\nwant %q", got, want)
	}
}

func TestExecCwdIsCheckedAsTheAccount(t *testing.T) {
	requireBash(t)
	acct := testAccount(t)
	home := accountHome(t, acct)
	// A directory inside one of root's that the account cannot enter: it cannot see it, so it is not a cwd.
	rootsOwn := filepath.Join(t.TempDir(), "rootsown")
	closed := filepath.Join(rootsOwn, "closed")
	if err := os.MkdirAll(closed, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(rootsOwn, 0o700); err != nil {
		t.Fatal(err)
	}
	f := newFixture(t, func(o *Options) { o.RunAs = acct; o.Home = home })
	wantStatus(t, f.postJSON("/v1/exec", map[string]any{"command": "pwd", "cwd": closed}), http.StatusBadRequest)
}

func TestFilesAreOpenedCreatedAndOwnedAsTheAccount(t *testing.T) {
	acct := testAccount(t)
	home := accountHome(t, acct)
	f := newFixture(t, func(o *Options) { o.RunAs = acct; o.Home = home })

	// A file the route makes is the account's, and so is the directory it made for it.
	wantStatus(t, f.do(http.MethodPut, "/v1/files?path=notes/a.txt", strings.NewReader("hello")), http.StatusNoContent)
	for _, p := range []string{filepath.Join(home, "notes"), filepath.Join(home, "notes", "a.txt")} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st := info.Sys().(*syscall.Stat_t); st.Uid != acct.UID || st.Gid != acct.GID {
			t.Errorf("%s belongs to %d:%d, not to the account %d:%d", p, st.Uid, st.Gid, acct.UID, acct.GID)
		}
	}

	// A file of root's that the account may not read stays closed, though the test's own user is root.
	secret := filepath.Join(home, "secret")
	if err := os.WriteFile(secret, []byte("no"), 0o600); err != nil {
		t.Fatal(err)
	}
	wantStatus(t, f.do(http.MethodGet, "/v1/files?path=secret", nil), http.StatusForbidden)
	wantStatus(t, f.do(http.MethodGet, "/v1/files/list?path=notes", nil), http.StatusOK)

	// The engine's socket acts as the account too, and is not limited to home.
	outside := filepath.Join(t.TempDir(), "root-only")
	if err := os.WriteFile(outside, []byte("no"), 0o600); err != nil {
		t.Fatal(err)
	}
	wantStatus(t, f.doLocal(http.MethodGet, "/v1/files?path="+outside, nil), http.StatusForbidden)
}

func TestHomeConfinementHoldsWhenActingAsTheAccount(t *testing.T) {
	acct := testAccount(t)
	home := accountHome(t, acct)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("o"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, "link")); err != nil {
		t.Fatal(err)
	}
	f := newFixture(t, func(o *Options) { o.RunAs = acct; o.Home = home })
	wantStatus(t, f.do(http.MethodGet, "/v1/files?path=link", nil), http.StatusForbidden)
}

func TestActAsGivesTheThreadBack(t *testing.T) {
	acct := testAccount(t)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	fsuid := func() uintptr { n, _, _ := syscall.RawSyscall(syscall.SYS_SETFSUID, ^uintptr(0), 0, 0); return n }
	before := fsuid()
	restore, err := actAs(acct)
	if err != nil {
		t.Fatal(err)
	}
	if got := fsuid(); got != uintptr(acct.UID) {
		t.Errorf("acting as %d, the thread's user is %d", acct.UID, got)
	}
	restore()
	if got := fsuid(); got != before {
		t.Errorf("the thread's user is %d after restore, was %d", got, before)
	}
}

func TestProcRunsAsTheAccountOnPipesAndOnATerminalItOwns(t *testing.T) {
	acct := testAccount(t)
	home := accountHome(t, acct)
	sock, _ := localSocketWith(t, Options{Home: home, RunAs: acct})
	code, out, _ := relay(t, sock, RelayOptions{Argv: []string{"/bin/sh", "-c", `id -u; echo $HOME`}}, "")
	if want := fmt.Sprintf("%d\n%s\n", acct.UID, home); code != 0 || out != want {
		t.Fatalf("code %d, out %q, want %q", code, out, want)
	}
	// On a terminal, which the account must own: a program that opens it again by name is the account.
	code, out, _ = relay(t, sock, RelayOptions{
		Argv: []string{"/bin/sh", "-c", `tty=$(readlink /proc/self/fd/0); id -u; stat -c %u "$tty"; test -r "$tty" && test -w "$tty" && echo rw`},
		TTY:  &ProcTTY{Cols: 80, Rows: 24},
	}, "")
	out = strings.ReplaceAll(out, "\r", "")
	if want := fmt.Sprintf("%d\n%d\nrw\n", acct.UID, acct.UID); code != 0 || out != want {
		t.Fatalf("code %d, out %q, want %q", code, out, want)
	}
}

func TestProcCallerGoneKillsTheGroupOfAnotherUser(t *testing.T) {
	acct := testAccount(t)
	home := accountHome(t, acct)
	sock, _ := localSocketWith(t, Options{Home: home, RunAs: acct})
	procDiesWithItsCaller(t, sock, filepath.Join(home, "pid"))
}

func TestScreenshotRunsAsTheAccount(t *testing.T) {
	acct := testAccount(t)
	home := accountHome(t, acct)
	bin := filepath.Join(home, "import")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nid -u >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(bin, int(acct.UID), int(acct.GID)); err != nil {
		t.Fatal(err)
	}
	f := newFixture(t, func(o *Options) { o.RunAs = acct; o.Home = home; o.ImportBin = bin })
	resp := f.do(http.MethodGet, "/v1/screenshot", nil)
	wantStatus(t, resp, http.StatusServiceUnavailable)
	if body := decode[ErrorAnswer](t, resp); !strings.Contains(body.Message, strconv.Itoa(int(acct.UID))) {
		t.Errorf("import did not run as the account: %q", body.Message)
	}
}

func TestForgetAmbientCapabilitiesLeavesTheSetEmpty(t *testing.T) {
	if err := ForgetAmbientCapabilities(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if rest, ok := strings.CutPrefix(line, "CapAmb:"); ok && strings.Trim(strings.TrimSpace(rest), "0") != "" {
			t.Errorf("the ambient set is not empty: %s", line)
		}
	}
}

func TestProcFindsAProgramInADirectoryOnlyTheAccountSees(t *testing.T) {
	acct := testAccount(t)
	home := accountHome(t, acct)
	bin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	tool := filepath.Join(bin, "invisible-tool")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nid -u\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The daemon's user (root here, dotagentd in the guest) is not the owner of the home, which is closed to others.
	for _, p := range []string{filepath.Join(home, ".local"), bin, tool} {
		if err := os.Chown(p, int(acct.UID), int(acct.GID)); err != nil {
			t.Fatal(err)
		}
	}
	sock, _ := localSocketWith(t, Options{Home: home, RunAs: acct})
	code, out, _ := relay(t, sock, RelayOptions{Argv: []string{"invisible-tool"}, Env: map[string]string{"PATH": bin + ":/usr/bin:/bin"}}, "")
	if want := fmt.Sprintf("%d\n", acct.UID); code != 0 || out != want {
		t.Fatalf("code %d, out %q, want %q", code, out, want)
	}
}
