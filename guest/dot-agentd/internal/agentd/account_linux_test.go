//go:build linux

package agentd

import (
	"os"
	"testing"
)

func TestLookupAccountReadsTheUserTheGroupsAndTheShell(t *testing.T) {
	acct, err := LookupAccount("root")
	if err != nil {
		t.Fatal(err)
	}
	if acct.Name != "root" || acct.UID != 0 || acct.GID != 0 || acct.Shell == "" || len(acct.Groups) == 0 {
		t.Fatalf("got %+v", acct)
	}
	if _, err := LookupAccount("no-such-user-for-the-model"); err == nil {
		t.Fatal("an unknown user was found")
	}
}

func TestExecWithoutAnAccountKeepsTheDaemonsEnvironment(t *testing.T) {
	requireBash(t)
	t.Setenv("HOME", "/somewhere")
	f := newFixture(t)
	if got := runExec(t, f, map[string]any{"command": `printf %s "$HOME"`}); got.Stdout != "/somewhere" {
		t.Errorf("HOME = %q", got.Stdout)
	}
}

func TestActAsNobodyOrTheCallerChangesNothing(t *testing.T) {
	restore, err := actAs(nil)
	if err != nil {
		t.Fatal(err)
	}
	restore()
	self := &Account{UID: uint32(os.Geteuid()), GID: uint32(os.Getegid())}
	restore, err = actAs(self)
	if err != nil {
		t.Fatal(err)
	}
	restore()
}
