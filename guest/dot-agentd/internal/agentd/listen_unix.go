//go:build unix

package agentd

import (
	"net"
	"syscall"
)

// listenUnixPrivate creates the socket under umask 0117 so it is never
// world accessible, not even between bind and the chmod that follows. The umask is process-wide, so this must run before the daemon
// starts any other goroutine that creates files.
func listenUnixPrivate(path string) (net.Listener, error) {
	old := syscall.Umask(0o117)
	defer syscall.Umask(old)
	return net.Listen("unix", path)
}
