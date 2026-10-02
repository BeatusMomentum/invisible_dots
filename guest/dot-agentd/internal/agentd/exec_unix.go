//go:build unix

package agentd

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the command in a new process group and makes the
// context cancellation kill that whole group, not just bash.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
