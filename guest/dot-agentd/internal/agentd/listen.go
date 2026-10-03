package agentd

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
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

// ListenTCP opens the listener the host reaches through QEMU's port forward
// (architecture section 5.1). The default binds every guest interface because
// the forward targets the guest's user-network address, which DHCP assigns
// and the daemon cannot know when it starts; nothing but the host's forward
// and processes inside the guest can reach that interface, and every request
// still needs the Dot's token.
//
// The host must be an IP literal: a name would be resolved once at boot,
// possibly before the network is configured, and could bind something other
// than what was written. Port 0 is accepted so tests can let the kernel pick.
func ListenTCP(addr string) (net.Listener, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("listen address %q: %w", addr, err)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil, errors.New("listen address " + addr + ": the host must be an IP address such as 0.0.0.0 or 127.0.0.1")
	}
	n, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return nil, fmt.Errorf("listen address %s: port %q is not a number from 0 to 65535", addr, port)
	}
	// tcp4 for an IPv4 literal: QEMU's user network forwards IPv4, and "tcp"
	// on 0.0.0.0 would also open the IPv6 side of a dual-stack socket.
	network := "tcp6"
	if ip.To4() != nil {
		network = "tcp4"
	}
	ln, err := net.Listen(network, net.JoinHostPort(ip.String(), strconv.FormatUint(n, 10)))
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", addr, err)
	}
	return ln, nil
}
