//go:build !unix

package agentd

import "os/exec"

// setProcessGroup has no process groups to use outside unix; the context
// cancellation kills the direct child only. The guest is always Linux.
func setProcessGroup(cmd *exec.Cmd) {}
