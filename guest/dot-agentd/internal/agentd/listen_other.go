//go:build !unix

package agentd

import "net"

func listenUnixPrivate(path string) (net.Listener, error) {
	return net.Listen("unix", path)
}
