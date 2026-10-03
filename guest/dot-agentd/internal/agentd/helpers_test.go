package agentd

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testToken = "test-token-0123456789"

type fixture struct {
	t           *testing.T
	home        string
	runDir      string
	agentSocket string
	srv         *Server
	// baseURL is the remote handler served by ListenTCP and NewHTTPServer,
	// the same pieces the daemon runs, so every test goes over real TCP.
	baseURL string
	client  *http.Client
}

// newFixture builds a server whose every path lives in temporary directories.
func newFixture(t *testing.T, mutate ...func(*Options)) *fixture {
	t.Helper()
	home := t.TempDir()
	runDir := shortTempDir(t)
	opts := Options{
		Token:        testToken,
		Home:         home,
		AgentSocket:  filepath.Join(runDir, "agent.sock"),
		CheckTimeout: time.Second,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, m := range mutate {
		m(&opts)
	}
	srv := New(opts)
	ln, err := ListenTCP("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	hs := NewHTTPServer(srv.RemoteHandler(), opts.Logger)
	go func() { _ = hs.Serve(ln) }()
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	t.Cleanup(func() {
		client.CloseIdleConnections()
		_ = hs.Close()
	})
	return &fixture{
		t: t, home: home, runDir: runDir, agentSocket: opts.AgentSocket, srv: srv,
		baseURL: "http://" + ln.Addr().String(), client: client,
	}
}

// shortTempDir keeps unix socket paths under the 108-byte sun_path limit,
// which t.TempDir names derived from long test names can exceed.
func shortTempDir(t *testing.T) string {
	t.Helper()
	base := ""
	if runtime.GOOS != "windows" {
		base = "/tmp"
	}
	dir, err := os.MkdirTemp(base, "agentd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func (f *fixture) do(method, path string, body io.Reader, headers ...string) *http.Response {
	f.t.Helper()
	req, err := http.NewRequest(method, f.baseURL+path, body)
	if err != nil {
		f.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := f.client.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func (f *fixture) postJSON(path string, v any) *http.Response {
	f.t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		f.t.Fatal(err)
	}
	return f.do(http.MethodPost, path, strings.NewReader(string(raw)), "Content-Type", "application/json")
}

// startAgent serves h on the fixture's agent socket, standing in for
// invisible-dots-agent.
func (f *fixture) startAgent(h http.Handler) {
	f.t.Helper()
	ln, err := net.Listen("unix", f.agentSocket)
	if err != nil {
		f.t.Fatal(err)
	}
	hs := &http.Server{Handler: h}
	go func() { _ = hs.Serve(ln) }()
	f.t.Cleanup(func() { _ = hs.Close() })
}

func unixClient(socket string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
	}}
}

func decode[T any](t *testing.T, resp *http.Response) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatalf("decode %T: %v", v, err)
	}
	return v
}

func wantStatus(t *testing.T, resp *http.Response, want int) {
	t.Helper()
	if resp.StatusCode != want {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d, want %d; body %s", resp.StatusCode, want, body)
	}
}

func requireBash(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("exec runs bash with unix process groups; the guest is linux")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not found")
	}
}
