//go:build !unix

package agentd

import (
	"errors"
	"runtime"
)

// diskUsage is only implemented for unix; the daemon ships for linux/amd64.
func diskUsage(string) (uint64, uint64, error) {
	return 0, 0, errors.New("disk usage is not implemented on " + runtime.GOOS)
}
