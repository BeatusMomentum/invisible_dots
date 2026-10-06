//go:build !linux

package agentd

import "errors"

// The guest is Linux, and so is everything that runs commands as another user: no Account exists elsewhere.
func LookupAccount(string) (*Account, error) {
	return nil, errors.New("running commands as another user needs Linux")
}

// There is no other user to act as outside Linux (LookupAccount), so these have nothing to do.
func actAs(*Account) (func(), error) { return func() {}, nil }

func ForgetAmbientCapabilities() error { return nil }

func RequireCapabilities() error { return errors.New("running commands as another user needs Linux") }
