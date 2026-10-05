//go:build !linux

package agentd

import "syscall"

// The process route and the relay run on the Linux guest only; elsewhere they
// say so, which keeps `go vet ./...` working on a developer's machine.
func startProc([]string, string, []string, *ProcTTY) (*procHandle, error) {
	return nil, errProcUnsupported
}

func killGroup(int, syscall.Signal) {}

// TerminalSize reports no terminal outside Linux.
func TerminalSize(uintptr) (ProcTTY, bool) { return ProcTTY{}, false }

// MakeRaw is not available outside Linux.
func MakeRaw(uintptr) (func(), error) { return nil, errProcUnsupported }

// WatchTerminalSize reports no size changes outside Linux.
func WatchTerminalSize(uintptr) <-chan ProcTTY { return nil }

// ForwardedSignals forwards nothing outside Linux.
func ForwardedSignals() <-chan syscall.Signal { return nil }
