package agentd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	// ExecOutputCap is the per-stream cap of POST /v1/exec (architecture 5.2).
	ExecOutputCap = 1 << 20
	// DefaultExecTimeout applies when the request names none.
	DefaultExecTimeout = 2 * time.Minute
	// MaxExecTimeout bounds a single command; longer work belongs in a
	// background process the command starts itself.
	MaxExecTimeout = time.Hour
	// execPipeGrace is how long Wait keeps reading output after bash has
	// exited. A command such as `server &` leaves a child holding stdout open;
	// without this bound the request would hang for the child's lifetime.
	execPipeGrace = 2 * time.Second
)

// ExecRequest is the body of POST /v1/exec.
type ExecRequest struct {
	Command   string  `json:"command"`
	Cwd       *string `json:"cwd,omitempty"`
	TimeoutMs *int64  `json:"timeout_ms,omitempty"`
}

// ExecAnswer is the answer of POST /v1/exec. ExitCode is -1 when the process
// was killed (timeout, a signal, or the caller going away).
type ExecAnswer struct {
	ExitCode        int    `json:"exit_code"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	TimedOut        bool   `json:"timed_out"`
	StdoutTruncated bool   `json:"stdout_truncated"`
	StderrTruncated bool   `json:"stderr_truncated"`
}

// cappedBuffer keeps the first limit bytes and silently drops the rest. It
// always reports a full write, because a short write would make the copying
// goroutine stop and the command would die of SIGPIPE instead of finishing.
type cappedBuffer struct {
	buf       []byte
	limit     int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	room := c.limit - len(c.buf)
	if room >= len(p) {
		c.buf = append(c.buf, p...)
	} else {
		if room > 0 {
			c.buf = append(c.buf, p[:room]...)
		}
		c.truncated = true
	}
	return len(p), nil
}

func (s *Server) handleExec(w http.ResponseWriter, r *http.Request) {
	var req ExecRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "command is required")
		return
	}
	timeout := DefaultExecTimeout
	if req.TimeoutMs != nil {
		ms := *req.TimeoutMs
		if ms <= 0 || time.Duration(ms)*time.Millisecond > MaxExecTimeout {
			writeError(w, http.StatusBadRequest, "invalid_body",
				fmt.Sprintf("timeout_ms must be between 1 and %d", MaxExecTimeout.Milliseconds()))
			return
		}
		timeout = time.Duration(ms) * time.Millisecond
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
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		writeError(w, http.StatusBadRequest, "invalid_cwd", "cwd "+cwd+" is not an existing directory")
		return
	}

	answer, err := s.runCommand(r.Context(), req.Command, cwd, timeout)
	if err != nil {
		s.log.Error("exec failed to start", "error", err)
		writeError(w, http.StatusInternalServerError, "exec_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, answer)
}

// runCommand runs `bash -lc command` in its own process group. The timeout
// and a disconnected caller both kill the whole group, so children started by
// the command die with it instead of outliving the request.
func (s *Server) runCommand(parent context.Context, command, cwd string, timeout time.Duration) (ExecAnswer, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, s.opts.Bash, "-lc", command)
	cmd.Dir = cwd
	cmd.Env = s.execEnv()
	stdout := &cappedBuffer{limit: ExecOutputCap}
	stderr := &cappedBuffer{limit: ExecOutputCap}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = execPipeGrace
	setProcessGroup(cmd)

	start := time.Now()
	if err := cmd.Start(); err != nil {
		return ExecAnswer{}, fmt.Errorf("start %s: %w", s.opts.Bash, err)
	}
	waitErr := cmd.Wait()

	answer := ExecAnswer{
		ExitCode:        -1,
		Stdout:          string(stdout.buf),
		Stderr:          string(stderr.buf),
		TimedOut:        errors.Is(ctx.Err(), context.DeadlineExceeded),
		StdoutTruncated: stdout.truncated,
		StderrTruncated: stderr.truncated,
	}
	if cmd.ProcessState != nil {
		answer.ExitCode = cmd.ProcessState.ExitCode()
	}
	if answer.TimedOut || ctx.Err() != nil {
		answer.ExitCode = -1
	}
	if waitErr != nil && !errors.Is(waitErr, exec.ErrWaitDelay) {
		var exitErr *exec.ExitError
		if !errors.As(waitErr, &exitErr) && ctx.Err() == nil {
			s.log.Warn("exec wait", "error", waitErr)
		}
	}
	s.log.Info("exec", "cwd", cwd, "exit_code", answer.ExitCode, "timed_out", answer.TimedOut,
		"duration_ms", time.Since(start).Milliseconds())
	return answer, nil
}

// execEnv is the daemon's environment plus DISPLAY, so a GUI program started
// from a command lands on the Dot's desktop.
func (s *Server) execEnv() []string {
	env := os.Environ()
	for _, kv := range env {
		if strings.HasPrefix(kv, "DISPLAY=") {
			return env
		}
	}
	return append(env, "DISPLAY="+s.opts.Display)
}
