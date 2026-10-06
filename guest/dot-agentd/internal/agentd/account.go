package agentd

import (
	"os"
	"strings"
)

// DefaultRunAs is the user the model's commands, the file routes and the
// screenshot run as (architecture 4.1). The daemon itself runs as a user of
// its own, so that nothing the model runs shares its uid.
const DefaultRunAs = "dot"

// Account is a user of the guest, read from its passwd and group entries: who
// the model's commands, the file operations done for the model and the
// screenshot run as. A Server with no Account runs them as the daemon's own
// user, which is how the tests and a development machine run it.
type Account struct {
	Name   string
	UID    uint32
	GID    uint32
	Groups []uint32 // every group of the user, as initgroups would set them
	Shell  string
}

// isCaller reports whether the daemon already is this user: nothing then needs
// to change, and nothing may be tried (setting groups takes a privilege the
// daemon may not have).
func (a *Account) isCaller() bool {
	return int(a.UID) == os.Geteuid() && int(a.GID) == os.Getegid()
}

// shellOf is the login shell of the passwd line of name, or "" when it has none.
func shellOf(passwd, name string) string {
	for _, line := range strings.Split(passwd, "\n") {
		fields := strings.Split(line, ":")
		if len(fields) == 7 && fields[0] == name {
			return fields[6]
		}
	}
	return ""
}

// SharesDaemonUser reports whether the daemon runs as this very user, which
// leaves the model's commands with the daemon's uid: the arrangement before
// the daemon had a user of its own, kept for development and the tests.
func (a *Account) SharesDaemonUser() bool { return a.isCaller() }

// ResolveRunAs is how the daemon starts to run the model's work as the user
// name: it reads the account, and unless the daemon already is that user it
// checks that it holds the capabilities that takes and empties its ambient set,
// so that nothing it starts inherits them (account_linux.go).
func ResolveRunAs(name string) (*Account, error) {
	acct, err := LookupAccount(name)
	if err != nil {
		return nil, err
	}
	if acct.isCaller() {
		return acct, nil
	}
	if err := RequireCapabilities(); err != nil {
		return nil, err
	}
	if err := ForgetAmbientCapabilities(); err != nil {
		return nil, err
	}
	return acct, nil
}
