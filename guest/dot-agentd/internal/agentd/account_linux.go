//go:build linux

package agentd

import (
	"fmt"
	"os"
	"os/user"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// LookupAccount reads the user name from the guest's passwd and group files.
func LookupAccount(name string) (*Account, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return nil, fmt.Errorf("the user %s: %w", name, err)
	}
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("the user %s has uid %q", name, u.Uid)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("the user %s has gid %q", name, u.Gid)
	}
	ids, err := u.GroupIds()
	if err != nil {
		return nil, fmt.Errorf("the groups of the user %s: %w", name, err)
	}
	acct := &Account{Name: name, UID: uint32(uid), GID: uint32(gid)}
	for _, id := range ids {
		g, err := strconv.ParseUint(id, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("the user %s has group %q", name, id)
		}
		acct.Groups = append(acct.Groups, uint32(g))
	}
	if passwd, err := os.ReadFile("/etc/passwd"); err == nil {
		acct.Shell = shellOf(string(passwd), name)
	}
	if acct.Shell == "" {
		return nil, fmt.Errorf("the user %s has no login shell in /etc/passwd", name)
	}
	return acct, nil
}

// prCapAmbient and its clear-all operation: prctl(2). The syscall package has no names for them.
const (
	prCapAmbient         = 47
	prCapAmbientClearAll = 4
)

// ForgetAmbientCapabilities empties the ambient capability set of every thread
// of the daemon. The unit gives the daemon CAP_SETUID, CAP_SETGID and CAP_KILL
// as ambient capabilities, which is how a process that is not root has them at
// all; left in the set, every program the daemon starts would keep them across
// exec, and a command of the model could become any user. With the set empty
// the daemon keeps what it has (they are in its effective set until it ends)
// and what it starts has none. A set that is empty already is left alone, so a
// build with cgo (the tests) runs where nothing is granted; with something to
// clear it needs the static build the guest has (AllThreadsSyscall).
func ForgetAmbientCapabilities() error {
	ambient, err := capabilitySet("CapAmb")
	if err != nil {
		return err
	}
	if ambient == 0 {
		return nil
	}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prCapAmbient, prCapAmbientClearAll, 0); errno != 0 {
		return fmt.Errorf("clear the ambient capabilities: %w", errno)
	}
	return nil
}

// capabilitySet reads one capability set of the daemon (CapEff, CapAmb) from /proc/self/status.
func capabilitySet(field string) (uint64, error) {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if rest, ok := strings.CutPrefix(line, field+":"); ok {
			var set uint64
			if _, err := fmt.Sscanf(strings.TrimSpace(rest), "%x", &set); err != nil {
				return 0, fmt.Errorf("read %s: %w", field, err)
			}
			return set, nil
		}
	}
	return 0, fmt.Errorf("/proc/self/status has no %s", field)
}

// Capabilities of linux/capability.h that the daemon needs to act as another user.
const (
	capSetGID = 6
	capSetUID = 7
	capKill   = 5
)

// RequireCapabilities fails when the daemon cannot do what running as another
// user takes: start a process as the account (CAP_SETUID, CAP_SETGID) and kill
// its process group (CAP_KILL). It says so at start, where the unit's
// AmbientCapabilities line is the thing to look at, and not at the model's
// first command.
func RequireCapabilities() error {
	effective, err := capabilitySet("CapEff")
	if err != nil {
		return err
	}
	for _, c := range []struct {
		bit  uint
		name string
	}{{capSetUID, "CAP_SETUID"}, {capSetGID, "CAP_SETGID"}, {capKill, "CAP_KILL"}} {
		if effective&(1<<c.bit) == 0 {
			return fmt.Errorf("the daemon lacks %s, which running commands as another user needs (AmbientCapabilities of its unit)", c.name)
		}
	}
	return nil
}

// actAs makes file operations of the calling goroutine act as the account:
// the thread is locked to the goroutine and its file system user, group and
// supplementary groups are the account's (what an NFS server does for a
// client), so every file the goroutine opens, creates, renames or changes is
// checked and owned as the account's, and the daemon's own user is never
// what the kernel sees. Opening a file is the check: the descriptor then
// carries the answer, so only the thread that opens needs to be switched.
// restore gives the thread back; it panics when it cannot, because a thread
// left as the account would serve the daemon's next request (the HTTP server
// ends the connection and with it the goroutine, and with the goroutine the
// thread, which is still locked to it).
func actAs(as *Account) (restore func(), err error) {
	if as == nil || as.isCaller() {
		return func() {}, nil
	}
	runtime.LockOSThread()
	prevGroups, err := syscall.Getgroups()
	if err != nil {
		runtime.UnlockOSThread()
		return nil, err
	}
	// The ids that are in force now, which setfs* answers when given -1.
	prevUID, _, _ := syscall.RawSyscall(syscall.SYS_SETFSUID, ^uintptr(0), 0, 0)
	prevGID, _, _ := syscall.RawSyscall(syscall.SYS_SETFSGID, ^uintptr(0), 0, 0)
	if err := setThreadIdentity(as.Groups, uintptr(as.UID), uintptr(as.GID)); err != nil {
		// Whatever was changed is put back before the thread is given up.
		if back := setThreadIdentity(toUint32(prevGroups), prevUID, prevGID); back != nil {
			panic(fmt.Sprintf("a thread could not be given back after %v: %v", err, back))
		}
		runtime.UnlockOSThread()
		return nil, err
	}
	return func() {
		if err := setThreadIdentity(toUint32(prevGroups), prevUID, prevGID); err != nil {
			panic(fmt.Sprintf("a thread could not be given back: %v", err))
		}
		runtime.UnlockOSThread()
	}, nil
}

func toUint32(ids []int) []uint32 {
	out := make([]uint32, len(ids))
	for i, id := range ids {
		out[i] = uint32(id)
	}
	return out
}

// setThreadIdentity sets the supplementary groups, the file system group and
// the file system user of the calling thread, in that order (the groups need a
// privilege that the user change does not take away), and checks each one: the
// setfs* calls return the previous value and no error.
func setThreadIdentity(groups []uint32, uid, gid uintptr) error {
	var first *uint32
	if len(groups) > 0 {
		first = &groups[0]
	}
	if _, _, errno := syscall.RawSyscall(syscall.SYS_SETGROUPS, uintptr(len(groups)), uintptr(unsafe.Pointer(first)), 0); errno != 0 {
		return fmt.Errorf("setgroups: %w", errno)
	}
	syscall.RawSyscall(syscall.SYS_SETFSGID, gid, 0, 0)
	if now, _, _ := syscall.RawSyscall(syscall.SYS_SETFSGID, ^uintptr(0), 0, 0); now != gid {
		return fmt.Errorf("setfsgid %d: the thread's group is %d", gid, now)
	}
	syscall.RawSyscall(syscall.SYS_SETFSUID, uid, 0, 0)
	if now, _, _ := syscall.RawSyscall(syscall.SYS_SETFSUID, ^uintptr(0), 0, 0); now != uid {
		return fmt.Errorf("setfsuid %d: the thread's user is %d", uid, now)
	}
	return nil
}
