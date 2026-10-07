//go:build !unix

package agentd

import "os/exec"

// setProcessGroup has no process groups to use outside unix; the context
// cancellation kills the direct child only. The guest is always Linux, and no
// Account exists elsewhere (LookupAccount).
func setProcessGroup(cmd *exec.Cmd, _ *Account) {}

func setAccount(cmd *exec.Cmd, _ *Account) {}
