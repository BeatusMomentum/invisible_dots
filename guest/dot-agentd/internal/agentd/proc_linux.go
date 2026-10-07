//go:build linux

package agentd

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"unsafe"
)

// startProc starts argv as the account, as its own process group: with pipes,
// or as the session leader of a new pseudo-terminal when tty is set.
func startProc(argv []string, cwd string, env []string, tty *ProcTTY, as *Account) (*procHandle, error) {
	program, err := lookProgram(argv[0], env, as)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(program, argv[1:]...)
	cmd.Args[0] = argv[0]
	cmd.Dir = cwd
	cmd.Env = env
	if tty != nil {
		return startProcOnPTY(cmd, tty, as)
	}
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		closeAll(stdinR, stdinW)
		return nil, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		closeAll(stdinR, stdinW, stdoutR, stdoutW)
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, stderrW
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: credentialOf(as)}
	if err := cmd.Start(); err != nil {
		closeAll(stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW)
		return nil, fmt.Errorf("start %s: %w", argv[0], err)
	}
	// The child holds its ends; the parent keeps only the other side.
	closeAll(stdinR, stdoutW, stderrW)
	return &procHandle{
		pid:      cmd.Process.Pid,
		stdin:    stdinW,
		endInput: func() { _ = stdinW.Close() },
		outputs: []procOutput{
			{kind: frameStdout, r: stdoutR},
			{kind: frameStderr, r: stderrR},
		},
		wait: func() (*os.ProcessState, error) {
			err := cmd.Wait()
			_ = stdinW.Close()
			return cmd.ProcessState, err
		},
		closeOutputs: func() { closeAll(stdoutR, stderrR) },
	}, nil
}

func startProcOnPTY(cmd *exec.Cmd, tty *ProcTTY, as *Account) (*procHandle, error) {
	master, slave, err := openPTYAs(as)
	if err != nil {
		return nil, err
	}
	if err := setWinsize(master, tty.Cols, tty.Rows); err != nil {
		closeAll(master, slave)
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	// A new session whose controlling terminal is the slave (fd 0 in the
	// child): the shell gets job control, and the session id is the group id.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0, Credential: credentialOf(as)}
	if err := cmd.Start(); err != nil {
		closeAll(master, slave)
		return nil, fmt.Errorf("start %s: %w", cmd.Path, err)
	}
	_ = slave.Close()
	return &procHandle{
		pid:      cmd.Process.Pid,
		stdin:    master,
		endInput: func() { _, _ = master.Write([]byte{4}) },
		outputs:  []procOutput{{kind: frameStdout, r: ptyReader{master}}},
		wait: func() (*os.ProcessState, error) {
			err := cmd.Wait()
			return cmd.ProcessState, err
		},
		resize:       func(cols, rows uint16) error { return setWinsize(master, cols, rows) },
		closeOutputs: func() { _ = master.Close() },
	}, nil
}

// ptyReader ends at EIO, which is how Linux says the last slave was closed.
type ptyReader struct{ f *os.File }

func (p ptyReader) Read(b []byte) (int, error) {
	n, err := p.f.Read(b)
	if err != nil && n == 0 {
		if pe, ok := err.(*os.PathError); ok && pe.Err == syscall.EIO {
			return 0, os.ErrClosed
		}
	}
	return n, err
}

// openPTYAs opens the pseudo-terminal as the account: the kernel makes the
// slave belong to the user that opens /dev/ptmx, and a program that opens it
// again by name (/dev/pts/N) has to be that user.
func openPTYAs(as *Account) (*os.File, *os.File, error) {
	restore, err := actAs(as)
	if err != nil {
		return nil, nil, err
	}
	defer restore()
	return openPTY()
}

func openPTY() (*os.File, *os.File, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	var unlock int32
	if err := ioctl(master.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("unlock pty: %w", err)
	}
	var n uint32
	if err := ioctl(master.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("pty number: %w", err)
	}
	slave, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("open pty slave: %w", err)
	}
	return master, slave, nil
}

type winsize struct{ rows, cols, x, y uint16 }

func setWinsize(f *os.File, cols, rows uint16) error {
	ws := winsize{rows: rows, cols: cols}
	return ioctl(f.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

func getWinsize(fd uintptr) (cols, rows uint16, err error) {
	var ws winsize
	if err := ioctl(fd, syscall.TIOCGWINSZ, uintptr(unsafe.Pointer(&ws))); err != nil {
		return 0, 0, err
	}
	return ws.cols, ws.rows, nil
}

func ioctl(fd, request, arg uintptr) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, request, arg); errno != 0 {
		return errno
	}
	return nil
}

// killGroup signals the process group the process leads.
func killGroup(pid int, sig syscall.Signal) {
	if pid > 0 {
		_ = syscall.Kill(-pid, sig)
	}
}

func closeAll(files ...*os.File) {
	for _, f := range files {
		_ = f.Close()
	}
}

// TerminalSize is the size of the terminal on fd; ok is false when fd is not one.
func TerminalSize(fd uintptr) (size ProcTTY, ok bool) {
	cols, rows, err := getWinsize(fd)
	if err != nil || cols == 0 || rows == 0 {
		return ProcTTY{}, false
	}
	return ProcTTY{Cols: cols, Rows: rows}, true
}

// MakeRaw puts the terminal on fd in raw mode, the way a remote shell's
// client does, so keys reach the remote terminal unchanged; restore undoes it.
func MakeRaw(fd uintptr) (restore func(), err error) {
	var old syscall.Termios
	if err := ioctl(fd, syscall.TCGETS, uintptr(unsafe.Pointer(&old))); err != nil {
		return nil, err
	}
	raw := old
	raw.Iflag &^= syscall.IGNBRK | syscall.BRKINT | syscall.PARMRK | syscall.ISTRIP | syscall.INLCR |
		syscall.IGNCR | syscall.ICRNL | syscall.IXON
	raw.Oflag &^= syscall.OPOST
	raw.Lflag &^= syscall.ECHO | syscall.ECHONL | syscall.ICANON | syscall.ISIG | syscall.IEXTEN
	raw.Cflag &^= syscall.CSIZE | syscall.PARENB
	raw.Cflag |= syscall.CS8
	raw.Cc[syscall.VMIN] = 1
	raw.Cc[syscall.VTIME] = 0
	if err := ioctl(fd, syscall.TCSETS, uintptr(unsafe.Pointer(&raw))); err != nil {
		return nil, err
	}
	return func() { _ = ioctl(fd, syscall.TCSETS, uintptr(unsafe.Pointer(&old))) }, nil
}

// WatchTerminalSize sends the terminal's size whenever it changes (SIGWINCH).
func WatchTerminalSize(fd uintptr) <-chan ProcTTY {
	out := make(chan ProcTTY, 1)
	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	go func() {
		for range winch {
			if size, ok := TerminalSize(fd); ok {
				select {
				case out <- size:
				default:
				}
			}
		}
	}()
	return out
}

// ForwardedSignals passes an interrupt, a hangup or a termination of the
// relay on to the remote process group, which then ends the relay by exiting.
func ForwardedSignals() <-chan syscall.Signal {
	out := make(chan syscall.Signal, 4)
	in := make(chan os.Signal, 4)
	signal.Notify(in, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT)
	go func() {
		for s := range in {
			if sig, ok := s.(syscall.Signal); ok {
				out <- sig
			}
		}
	}()
	return out
}
