//go:build linux

package agentd

import (
	"fmt"
	"net"

	"github.com/mdlayher/vsock"
)

// ListenVsock listens on the given vsock port for any host CID.
func ListenVsock(port uint32) (net.Listener, error) {
	ln, err := vsock.Listen(port, nil)
	if err != nil {
		return nil, fmt.Errorf("vsock listen on port %d (is the virtio-vsock device attached?): %w", port, err)
	}
	return ln, nil
}
