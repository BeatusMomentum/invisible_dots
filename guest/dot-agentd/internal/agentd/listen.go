package agentd

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
)

// ListenUnix listens on a unix socket readable and writable by the owner only.
// A stale socket file left by a previous run is removed first; anything else
// at that path is refused rather than deleted.
func ListenUnix(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create socket directory: %w", err)
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode().Type() != fs.ModeSocket {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("remove stale socket %s: %w", path, err)
		}
	}
	ln, err := listenUnixPrivate(path)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("chmod %s: %w", path, err)
	}
	return ln, nil
}

// ListenLoopbackTCP is the development listener. It only binds 127.0.0.1:
// the remote routes run commands as the Dot's user, so a typo that exposed
// them on a real interface would be a remote shell guarded by one token.
func ListenLoopbackTCP(addr string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("--listen-tcp %q: %w", addr, err)
	}
	if host != "127.0.0.1" {
		return nil, errors.New("--listen-tcp must bind 127.0.0.1, got " + addr)
	}
	return net.Listen("tcp4", addr)
}
