// Package agentd implements dot-agentd, the computer daemon that runs inside
// every Dot's VM: the TCP endpoint the host reaches through QEMU's port
// forward (architecture sections 5.1 and 5.2) and the local unix socket the
// agent uses for the same operations.
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
	// RunAs is the user the model's commands, the file operations done for
	// the model and the screenshot run as. The daemon runs as a user of its
	// own and changes to this one for each of them (architecture 4.1); nil
	// runs them as the daemon's own user, for tests and development.
	RunAs *Account
	// AgentSocket is the unix socket of invisible-dots-agent.
	AgentSocket string
	// Display is the X display screenshots capture and exec children inherit.
	Display string
	// ImportBin is ImageMagick's `import`, used for screenshots: a path, never a name
	// looked up in a PATH (DefaultImportBin).
	ImportBin string
	// Bash runs exec commands as `bash -lc <command>`: a path (DefaultBash).
	Bash string
	// ProcDir is normally /proc; tests point it at fake files.
	ProcDir string
	// CheckTimeout bounds the agent call of the health route.
	CheckTimeout time.Duration
	// PowerOff is the command POST /v1/system/poweroff starts, as an argv.
	PowerOff []string
	Logger   *slog.Logger
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
		o.ImportBin = DefaultImportBin
	}
	if o.Bash == "" {
		o.Bash = DefaultBash
	}
	if o.ProcDir == "" {
		o.ProcDir = "/proc"
	}
	if o.CheckTimeout <= 0 {
		o.CheckTimeout = 2 * time.Second
	}
	if len(o.PowerOff) == 0 {
		o.PowerOff = DefaultPowerOff
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return &Server{opts: o, log: o.Logger, started: time.Now(), agent: newAgentClient(o.AgentSocket)}
}

// Defaults match the guest filesystem of architecture section 4.2.
const (
	DefaultConfigPath   = "/etc/invisible-dots/config.json"
	DefaultHome         = "/home/dot"
	DefaultRunDir       = "/run/invisible-dots"
	DefaultAgentdSocket = DefaultRunDir + "/agentd.sock"
	// DefaultAgentSocket is the engine's API, in a directory the engine's user
	// owns and only this daemon's group may enter (architecture 4.2): nothing
	// of the model's can reach it or put another socket in its place and take
	// the key the host pushes.
	DefaultAgentSocket = "/run/invisible-dots-agent/agent.sock"
	DefaultDisplay     = ":0"
	// The programs the daemon starts are named by path: a name would be looked up in the
	// daemon's PATH, and what the daemon finds there it runs with its own privileges
	// (DefaultPowerOff runs as the daemon's user and may become root).
	DefaultBash      = "/bin/bash"
	DefaultImportBin = "/usr/bin/import"
	// DefaultListenAddr uses port 1024, the one QEMU's forward targets
	// (architecture sections 3.4 and 5.1), on every interface; ListenTCP
	// says why every interface.
	DefaultListenAddr    = "0.0.0.0:1024"
	agentProxyPrefix     = "/v1/agent"
	maxJSONBodyBytes     = 1 << 20
	healthLogLevelQuiet  = slog.LevelDebug
	accessLogLevelNormal = slog.LevelInfo
)

// DefaultPowerOff is how the guest powers itself off when the host stops the
// VM (architecture 3.4). The daemon's user runs it through sudo, which the
// seed grants without a password; -n makes a missing grant fail at once
// instead of waiting for a password nobody will type. Every program is a path:
// this one runs as the daemon's user, which no name looked up in a PATH may reach.
var DefaultPowerOff = []string{"/usr/bin/sudo", "-n", "/usr/bin/systemctl", "poweroff"}

// routes builds the mux of either listener. The remote one (the TCP port,
// token required) also carries the agent proxy and the poweroff: the agent
// would only be talking to itself through the proxy, and the poweroff route
// is how the control plane stops a VM. The control plane records an exit
// nobody asked for and starts the VM again when work waits (architecture
// section 5.2).
func (s *Server) routes(remote bool) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("GET /v1/system", s.handleSystem)
	mux.HandleFunc("POST /v1/exec", s.handleExec)
	files := fileRoutes{s: s, confined: remote}
	mux.HandleFunc("GET /v1/files", files.get)
	mux.HandleFunc("PUT /v1/files", files.put)
	mux.HandleFunc("GET /v1/files/list", files.list)
	mux.HandleFunc("GET /v1/screenshot", s.handleScreenshot)
	if !remote {
		// The engine's commands for the model; the host has no use for them.
		mux.HandleFunc("POST /v1/proc", s.handleProc)
	}
	if remote {
		mux.HandleFunc("POST /v1/system/poweroff", s.handlePowerOff)
		proxy := s.newAgentProxy()
		mux.Handle(agentProxyPrefix, proxy)
		mux.Handle(agentProxyPrefix+"/", proxy)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no route for "+r.Method+" "+r.URL.Path)
	})
	return mux
}

// LocalHandler serves agentd.sock: no token (the socket is 0660, owned by the
// daemon's user with the engine's group, in a directory only they reach), no
// agent proxy and no poweroff, and the process route.
func (s *Server) LocalHandler() http.Handler {
	return s.accessLog("local", s.routes(false))
}

// RemoteHandler serves the TCP listener: every request must carry the Dot's
// bearer token, because the port is reachable by anything on the host's
// loopback, including other Dots (architecture section 3.6). The one
// exception is GET /v1/proof, which the host asks before it sends the token
// at all (proof.go).
func (s *Server) RemoteHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/proof", s.handleProof)
	mux.Handle("/", s.requireToken(s.routes(true)))
	return s.accessLog("remote", mux)
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
		// The host polls health while it waits for READY, and asks for a
		// proof before the first request of every client; at Info they
		// would drown everything else in the journal.
		if (r.URL.Path == "/v1/health" || r.URL.Path == "/v1/proof") && rec.status == http.StatusOK {
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

// NewHTTPServer is the http.Server behind every listener. The daemon and the
// tests both build theirs here, so the tests run against the real timeouts.
func NewHTTPServer(h http.Handler, log *slog.Logger) *http.Server {
	if log == nil {
		log = slog.Default()
	}
	return &http.Server{
		Handler: h,
		// No WriteTimeout: the agent event stream and long exec calls
		// legitimately keep a response open for minutes or hours.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
}
