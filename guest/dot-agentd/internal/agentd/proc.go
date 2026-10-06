package agentd

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ProcRequest is the body of POST /v1/proc: a program to run as the Dot's
// user (Options.RunAs), streamed both ways over the connection that asked for it.
type ProcRequest struct {
	// Argv is the program and its arguments, run as they are (no shell).
	Argv []string `json:"argv"`
	// Cwd resolves like the exec route's; home when absent.
	Cwd *string `json:"cwd,omitempty"`
	// Env adds to the daemon's environment (the one exec commands get).
	Env map[string]string `json:"env,omitempty"`
	// TTY runs the program on a pseudo-terminal of that size; without it,
	// stdin, stdout and stderr are pipes.
	TTY *ProcTTY `json:"tty,omitempty"`
}

// ProcTTY is the initial size of a process's terminal.
type ProcTTY struct {
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// procHandle is a started process, whatever its stdio.
type procHandle struct {
	pid   int
	stdin io.Writer
	// endInput is the caller's end of input: the pipe closes, or a terminal gets ^D.
	endInput func()
	outputs  []procOutput
	wait     func() (*os.ProcessState, error)
	resize   func(cols, rows uint16) error
	// closeOutputs stops output reads that a detached child keeps open.
	closeOutputs func()
}

type procOutput struct {
	kind byte
	r    io.Reader
}

// handleProc serves POST /v1/proc on the local socket only. The request asks
// to switch protocols; the answer is 101 and the connection then carries the
// frames of frames.go. The process lives exactly as long as that connection:
// the caller going away kills its whole process group, as with the exec route
// (architecture 5.2), so a background process of the engine dies with the
// engine. This is how the engine's exec, process and terminal tools run the
// model's commands as the Dot's user.
func (s *Server) handleProc(w http.ResponseWriter, r *http.Request) {
	if !headerHasToken(r.Header, "Connection", "upgrade") ||
		!strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), ProcUpgradeProtocol) {
		w.Header().Set("Upgrade", ProcUpgradeProtocol)
		writeError(w, http.StatusUpgradeRequired, "upgrade_required",
			"POST /v1/proc switches the connection to "+ProcUpgradeProtocol)
		return
	}
	var req ProcRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Argv) == 0 || req.Argv[0] == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "argv must name a program")
		return
	}
	for _, a := range req.Argv {
		if strings.ContainsRune(a, 0) {
			writeError(w, http.StatusBadRequest, "invalid_body", "argv may not contain a NUL byte")
			return
		}
	}
	env := s.execEnv()
	for k, v := range req.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") || strings.ContainsRune(v, 0) {
			writeError(w, http.StatusBadRequest, "invalid_body", "invalid environment variable "+k)
			return
		}
		env = append(env, k+"="+v)
	}
	if req.TTY != nil {
		if req.TTY.Cols == 0 || req.TTY.Rows == 0 {
			writeError(w, http.StatusBadRequest, "invalid_body", "tty cols and rows must be positive")
			return
		}
		if _, ok := req.Env["TERM"]; !ok {
			env = append(env, "TERM=xterm-256color")
		}
	}
	cwd := s.opts.Home
	if req.Cwd != nil && *req.Cwd != "" {
		p, err := resolvePath(s.opts.Home, *req.Cwd)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_cwd", err.Error())
			return
		}
		cwd = p
	}
	if !s.isDirectory(cwd) {
		writeError(w, http.StatusBadRequest, "invalid_cwd", "cwd "+cwd+" is not an existing directory")
		return
	}

	proc, err := startProc(req.Argv, cwd, env, req.TTY, s.opts.RunAs)
	if err != nil {
		s.log.Error("proc failed to start", "error", err)
		writeError(w, http.StatusInternalServerError, "proc_failed", err.Error())
		return
	}
	conn, rw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		killGroup(proc.pid, syscall.SIGKILL)
		_, _ = proc.wait()
		s.log.Error("proc: cannot take over the connection", "error", err)
		return
	}
	s.log.Info("proc started", "pid", proc.pid, "program", req.Argv[0], "tty", req.TTY != nil, "cwd", cwd)
	start := time.Now()
	exit := runProcStream(conn, rw, proc)
	s.log.Info("proc ended", "pid", proc.pid, "exit_code", exit.ExitCode, "signal", exit.Signal,
		"duration_ms", time.Since(start).Milliseconds())
}

// runProcStream relays one process over a hijacked connection until the
// process ends or the connection does, and returns how the process ended.
func runProcStream(conn net.Conn, rw *bufio.ReadWriter, proc *procHandle) ProcExit {
	defer conn.Close()
	var writeMu sync.Mutex
	send := func(kind byte, payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := writeFrame(rw, kind, payload); err != nil {
			return err
		}
		return rw.Flush()
	}

	writeMu.Lock()
	_, err := rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: " +
		ProcUpgradeProtocol + "\r\n\r\n")
	if err == nil {
		err = rw.Flush()
	}
	writeMu.Unlock()
	if err != nil {
		killGroup(proc.pid, syscall.SIGKILL)
	}

	var outputs sync.WaitGroup
	for _, out := range proc.outputs {
		outputs.Add(1)
		go func(out procOutput) {
			defer outputs.Done()
			buf := make([]byte, 32*1024)
			for {
				n, err := out.r.Read(buf)
				if n > 0 {
					if send(out.kind, buf[:n]) != nil {
						return
					}
				}
				if err != nil {
					return
				}
			}
		}(out)
	}

	// The caller's frames: input, size, signals. A read error is the caller
	// gone, and the process group goes with it.
	go func() {
		for {
			kind, payload, err := readFrame(rw.Reader)
			if err != nil {
				killGroup(proc.pid, syscall.SIGKILL)
				return
			}
			switch kind {
			case frameStdin:
				if proc.stdin != nil {
					_, _ = proc.stdin.Write(payload)
				}
			case frameStdinEOF:
				if proc.endInput != nil {
					proc.endInput()
				}
			case frameResize:
				if len(payload) == 4 && proc.resize != nil {
					_ = proc.resize(binary.BigEndian.Uint16(payload[:2]), binary.BigEndian.Uint16(payload[2:]))
				}
			case frameSignal:
				if len(payload) == 1 {
					killGroup(proc.pid, syscall.Signal(payload[0]))
				}
			}
		}
	}()

	state, waitErr := proc.wait()
	// A child the program left behind may hold the output open; it gets a
	// moment to finish writing, not the connection for its lifetime.
	drained := make(chan struct{})
	go func() {
		outputs.Wait()
		close(drained)
	}()
	select {
	case <-drained:
	case <-time.After(execPipeGrace):
		proc.closeOutputs()
		<-drained
	}
	exit := ProcExit{ExitCode: -1}
	if state != nil {
		if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			exit.Signal = ws.Signal().String()
		} else {
			exit.ExitCode = state.ExitCode()
		}
	} else if waitErr != nil {
		exit.Signal = "unknown"
	}
	payload, _ := json.Marshal(exit)
	_ = send(frameExit, payload)
	return exit
}

// headerHasToken reports whether a comma-separated header lists token.
func headerHasToken(h http.Header, name, token string) bool {
	for _, value := range h.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

var errProcUnsupported = errors.New("POST /v1/proc needs Linux")
