package agentd

import (
	"bytes"
	"context"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const screenshotTimeout = 15 * time.Second

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// handleScreenshot captures the whole X display with ImageMagick's
// `import -window root`, as the Dot's user. Xvfb runs without an auth file, so
// DISPLAY alone is enough to reach it.
func (s *Server) handleScreenshot(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), screenshotTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.opts.ImportBin, "-window", "root", "-display", s.opts.Display, "png:-")
	cmd.Env = append(s.execEnv(), "DISPLAY="+s.opts.Display)
	// The display belongs to the Dot's user: Xvfb admits that user's clients and no other.
	setAccount(cmd, s.opts.RunAs)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		s.log.Warn("screenshot failed", "display", s.opts.Display, "error", err, "stderr", msg)
		writeError(w, http.StatusServiceUnavailable, "screenshot_failed",
			"capturing display "+s.opts.Display+" failed: "+msg)
		return
	}
	if !bytes.HasPrefix(stdout.Bytes(), pngMagic) {
		s.log.Warn("screenshot is not a PNG", "bytes", stdout.Len())
		writeError(w, http.StatusServiceUnavailable, "screenshot_failed",
			s.opts.ImportBin+" did not produce a PNG image")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(stdout.Len()))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(stdout.Bytes())
}
