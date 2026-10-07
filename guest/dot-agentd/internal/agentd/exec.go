package agentd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
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
	if !s.isDirectory(cwd) {
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
	setProcessGroup(cmd, s.opts.RunAs)

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

// SystemPath is the directories of the system, which only root writes.
const SystemPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// modelPath is the PATH of everything that runs for the model: the Dot's own
// ~/.local/bin (uv linked invisible-playwright-mcp there) in front of the
// system's. It is built here, from the Dot's home, and is not the daemon's PATH:
// that one holds no directory the model can write, because what the daemon starts
// as itself (the poweroff) is found through it (DefaultPowerOff names paths too).
func modelPath(home string) string {
	return path.Join(home, ".local", "bin") + ":" + SystemPath
}

// execEnv is the environment of what runs for the model: the daemon's, with
// the account's own HOME, USER, LOGNAME and SHELL in place of the daemon's
// (the unit gives the daemon's user those) and the PATH of the Dot (modelPath),
// plus DISPLAY, so a GUI program started from a command lands on the Dot's
// desktop.
func (s *Server) execEnv() []string {
	env := withVariables(os.Environ(), "PATH="+modelPath(s.opts.Home))
	if as := s.opts.RunAs; as != nil {
		env = withVariables(env, "HOME="+s.opts.Home, "USER="+as.Name, "LOGNAME="+as.Name, "SHELL="+as.Shell)
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, "DISPLAY=") {
			return env
		}
	}
	return append(env, "DISPLAY="+s.opts.Display)
}

// withVariables is env with each NAME=value set, replacing a variable of the same name.
func withVariables(env []string, set ...string) []string {
	out := make([]string, 0, len(env)+len(set))
next:
	for _, kv := range env {
		for _, s := range set {
			name, _, _ := strings.Cut(s, "=")
			if strings.HasPrefix(kv, name+"=") {
				continue next
			}
		}
		out = append(out, kv)
	}
	return append(out, set...)
}

// isDirectory reports whether p is a directory the account can see: the
// daemon's own user may not be able to (the Dot's home is closed to others).
func (s *Server) isDirectory(p string) bool {
	restore, err := actAs(s.opts.RunAs)
	if err != nil {
		s.log.Error("act as the Dot's user", "error", err)
		return false
	}
	defer restore()
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// lookProgram is the file a name on argv[0] stands for, found the way the
// account's own shell would find it: a name with a slash is left to the exec,
// any other is searched for in the PATH the program is started with, in the
// directories the account can see. The daemon's own user may not see them (the
// Dot's home, where uv put invisible-playwright-mcp, is closed to others), and
// the daemon's own PATH is not the program's, so the daemon's lookup is not the
// answer.
func lookProgram(name string, env []string, as *Account) (string, error) {
	if strings.Contains(name, "/") {
		return name, nil
	}
	path := ""
	for _, kv := range env {
		if value, ok := strings.CutPrefix(kv, "PATH="); ok {
			path = value
		}
	}
	restore, err := actAs(as)
	if err != nil {
		return "", err
	}
	defer restore()
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			dir = "."
		}
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", &exec.Error{Name: name, Err: exec.ErrNotFound}
}
