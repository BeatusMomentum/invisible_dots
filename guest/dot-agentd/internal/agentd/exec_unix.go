//go:build unix

package agentd

import (
	"os/exec"
	"syscall"
)

// credentialOf is what a started process changes to before it runs: the
// account's user, group and supplementary groups (the ones the daemon has are
// cleared, not inherited). Nothing when the daemon already is that user.
func credentialOf(as *Account) *syscall.Credential {
	if as == nil || as.isCaller() {
		return nil
	}
	return &syscall.Credential{Uid: as.UID, Gid: as.GID, Groups: as.Groups}
}

// setProcessGroup puts the command in a new process group, makes the context
// cancellation kill that whole group, not just bash, and runs it as the account.
func setProcessGroup(cmd *exec.Cmd, as *Account) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: credentialOf(as)}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// setAccount runs the command as the account, in the daemon's own process group.
func setAccount(cmd *exec.Cmd, as *Account) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: credentialOf(as)}
}
