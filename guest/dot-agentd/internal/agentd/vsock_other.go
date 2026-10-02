//go:build !linux

package agentd

import (
	"errors"
	"net"
	"runtime"
)

// ListenVsock fails outside linux; use --no-vsock with --listen-tcp there.
func ListenVsock(uint32) (net.Listener, error) {
	return nil, errors.New("vsock is only available on linux, not " + runtime.GOOS + "; run with --no-vsock")
}
