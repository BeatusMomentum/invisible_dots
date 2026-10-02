// Package agentd implements dot-agentd, the computer daemon that runs inside
// every Dot's VM: the vsock endpoint the host talks to (architecture section
// 5.2) and the local unix socket the agent uses for the same operations.
package agentd

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Options configures a Server. Every path is configurable so the daemon and
// its tests can run without root and outside a VM.
type Options struct {
	// Token is the Dot's bearer token. Required by the remote handler.
	Token string
	// Home is the directory relative file paths and the exec cwd resolve against.
	Home string
	// AgentSocket is the unix socket of invisible-dots-agent.
	AgentSocket string
	// Display is the X display screenshots capture and exec children inherit.
	Display string
	// ImportBin is ImageMagick's `import`, used for screenshots.
	ImportBin string
	// Bash runs exec commands as `bash -lc <command>`.
	Bash string
	// ProcDir is normally /proc; tests point it at fake files.
	ProcDir string
	// CheckTimeout bounds the agent call of the health route.
	CheckTimeout time.Duration
	Logger       *slog.Logger
}

// Server serves the dot-agentd routes.
type Server struct {
	opts    Options
	log     *slog.Logger
	started time.Time
	agent   *agentClient
}

// New fills defaults and returns a Server.
func New(o Options) *Server {
	if o.Home == "" {
		o.Home = DefaultHome
	}
	if o.AgentSocket == "" {
		o.AgentSocket = DefaultAgentSocket
	}
	if o.Display == "" {
		o.Display = DefaultDisplay
	}
	if o.ImportBin == "" {
		o.ImportBin = "import"
	}
	if o.Bash == "" {
		o.Bash = "bash"
	}
	if o.ProcDir == "" {
		o.ProcDir = "/proc"
	}
	if o.CheckTimeout <= 0 {
		o.CheckTimeout = 2 * time.Second
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return &Server{opts: o, log: o.Logger, started: time.Now(), agent: newAgentClient(o.AgentSocket)}
}

// Defaults match the guest filesystem of architecture section 4.2.
const (
	DefaultConfigPath    = "/etc/invisible-dots/config.json"
	DefaultHome          = "/home/dot"
	DefaultRunDir        = "/run/invisible-dots"
	DefaultAgentdSocket  = DefaultRunDir + "/agentd.sock"
	DefaultAgentSocket   = DefaultRunDir + "/agent.sock"
	DefaultDisplay       = ":0"
	DefaultVsockPort     = 1024
	agentProxyPrefix     = "/v1/agent"
	maxJSONBodyBytes     = 1 << 20
	healthLogLevelQuiet  = slog.LevelDebug
	accessLogLevelNormal = slog.LevelInfo
)

func (s *Server) routes(withAgentProxy bool) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("GET /v1/system", s.handleSystem)
	mux.HandleFunc("POST /v1/exec", s.handleExec)
	mux.HandleFunc("GET /v1/files", s.handleFileGet)
	mux.HandleFunc("PUT /v1/files", s.handleFilePut)
	mux.HandleFunc("GET /v1/files/list", s.handleFileList)
	mux.HandleFunc("GET /v1/screenshot", s.handleScreenshot)
	if withAgentProxy {
		proxy := s.newAgentProxy()
		mux.Handle(agentProxyPrefix, proxy)
		mux.Handle(agentProxyPrefix+"/", proxy)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no route for "+r.Method+" "+r.URL.Path)
	})
	return mux
}

// LocalHandler serves agentd.sock: no token (the socket file is 0600 and
// owned by the agent's user) and no agent proxy, since the agent would only be
// talking to itself.
func (s *Server) LocalHandler() http.Handler {
	return s.accessLog("local", s.routes(false))
}

// RemoteHandler serves vsock (and the development TCP listener): every
// request must carry the Dot's bearer token.
func (s *Server) RemoteHandler() http.Handler {
	return s.accessLog("remote", s.requireToken(s.routes(true)))
}

func (s *Server) requireToken(next http.Handler) http.Handler {
	// Comparing digests keeps the comparison constant-time in the token
	// length too, which a plain ConstantTimeCompare would leak.
	want := sha256.Sum256([]byte("Bearer " + s.opts.Token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		if s.opts.Token == "" || subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="dot-agentd"`)
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach Flush on the real writer, which
// the SSE passthrough depends on.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (s *Server) accessLog(listener string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		level := accessLogLevelNormal
		// The host polls health while it waits for READY; at Info it would
		// drown everything else in the journal.
		if r.URL.Path == "/v1/health" && rec.status == http.StatusOK {
			level = healthLogLevelQuiet
		}
		if rec.status >= 500 {
			level = slog.LevelWarn
		}
		s.log.Log(r.Context(), level, "request",
			"listener", listener, "method", r.Method, "path", r.URL.Path,
			"status", rec.status, "duration_ms", time.Since(start).Milliseconds())
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// ErrorAnswer is the error body shared with the rest of the platform.
type ErrorAnswer struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, ErrorAnswer{Error: code, Message: message})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if ct := r.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "application/json") {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "expected application/json, got "+ct)
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}
