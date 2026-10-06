//go:build linux && privileged

package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Built only with the tag `privileged` (see internal/agentd/account_privileged_test.go): it needs root to hand a
// process the ambient capabilities the unit gives the daemon, and a build without cgo to empty them.

const ambientChild = "DOT_AGENTD_TEST_AMBIENT_CHILD"

func ambientSet(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if rest, ok := strings.CutPrefix(line, "CapAmb:"); ok {
			return strings.TrimSpace(rest)
		}
	}
	t.Fatal("/proc/self/status has no CapAmb")
	return ""
}

// The daemon empties the ambient set at start whoever the model's commands run as. With `--run-as=` (the
// daemon's own user) it once did not, and every command of the model kept CAP_SETUID and could become root.
// The test starts itself with the three capabilities of the unit's AmbientCapabilities, exactly as the unit
// grants them, and the child is the daemon with an empty run-as.
func TestServeEmptiesTheAmbientCapabilitiesWithNoUserToRunAs(t *testing.T) {
	if os.Getenv(ambientChild) != "" {
		if ambientSet(t) == "0000000000000000" {
			t.Fatal("the test was not started with ambient capabilities: it would prove nothing")
		}
		if _, err := startDaemon(t, testToken); err != nil {
			t.Fatal(err)
		}
		if got := ambientSet(t); got != "0000000000000000" {
			t.Fatalf("the daemon serves with the ambient set %s: every command of the model would hold it", got)
		}
		return
	}
	if os.Geteuid() != 0 {
		t.Skip("handing out ambient capabilities takes root")
	}
	setpriv, err := exec.LookPath("setpriv")
	if err != nil {
		t.Skip("no setpriv: " + err.Error())
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(setpriv, "--inh-caps=+setuid,+setgid,+kill", "--ambient-caps=+setuid,+setgid,+kill",
		self, "-test.run=^TestServeEmptiesTheAmbientCapabilitiesWithNoUserToRunAs$", "-test.v")
	cmd.Env = append(os.Environ(), ambientChild+"=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
