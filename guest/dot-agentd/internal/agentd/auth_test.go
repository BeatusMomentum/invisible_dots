package agentd

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestRemoteRejectsMissingOrWrongToken(t *testing.T) {
	f := newFixture(t)
	cases := map[string]string{
		"missing":       "",
		"wrong token":   "Bearer not-the-token",
		"no scheme":     testToken,
		"wrong scheme":  "Basic " + testToken,
		"token prefix":  "Bearer " + testToken[:len(testToken)-1],
		"token suffix":  "Bearer " + testToken + "x",
		"lowercase key": "bearer " + testToken,
	}
	for name, header := range cases {
		t.Run(name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, f.baseURL+"/v1/health", nil)
			if header != "" {
				req.Header.Set("Authorization", header)
			}
			resp, err := f.client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			wantStatus(t, resp, http.StatusUnauthorized)
			if !strings.HasPrefix(resp.Header.Get("WWW-Authenticate"), "Bearer") {
				t.Errorf("WWW-Authenticate = %q", resp.Header.Get("WWW-Authenticate"))
			}
			if body := decode[ErrorAnswer](t, resp); body.Error != "unauthorized" {
				t.Errorf("error code %q", body.Error)
			}
		})
	}
}

func TestRemoteRejectsEveryRouteWithoutToken(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{"/v1/system", "/v1/exec", "/v1/files?path=x", "/v1/files/list", "/v1/screenshot", "/v1/agent/health", "/nope"} {
		resp, err := f.client.Get(f.baseURL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", path, resp.StatusCode)
		}
	}
}

func TestRemoteAcceptsToken(t *testing.T) {
	f := newFixture(t)
	resp := f.do(http.MethodGet, "/v1/health", nil)
	wantStatus(t, resp, http.StatusOK)
}

func TestEmptyTokenRejectsEverything(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.Token = "" })
	req, _ := http.NewRequest(http.MethodGet, f.baseURL+"/v1/health", nil)
	req.Header.Set("Authorization", "Bearer ")
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	wantStatus(t, resp, http.StatusUnauthorized)
}

func TestLocalSocketNeedsNoTokenAndHasNoAgentProxy(t *testing.T) {
	f := newFixture(t)
	f.startAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /health is the health route's own call; anything else is a proxy.
		if r.URL.Path != "/health" {
			t.Errorf("the local socket must not proxy to the agent, got %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	sock := filepath.Join(f.runDir, "agentd.sock")
	ln, err := ListenUnix(sock)
	if err != nil {
		t.Fatal(err)
	}
	hs := &http.Server{Handler: f.srv.LocalHandler()}
	go func() { _ = hs.Serve(ln) }()
	t.Cleanup(func() { _ = hs.Close() })
	client := unixClient(sock)

	resp, err := client.Get("http://agentd/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	wantStatus(t, resp, http.StatusOK)

	resp2, err := client.Get("http://agentd/v1/agent/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	wantStatus(t, resp2, http.StatusNotFound)
}

func TestUnknownRouteIsJSON404(t *testing.T) {
	f := newFixture(t)
	resp := f.do(http.MethodGet, "/v2/whatever", nil)
	wantStatus(t, resp, http.StatusNotFound)
	if body := decode[ErrorAnswer](t, resp); body.Error != "not_found" {
		t.Errorf("error code %q", body.Error)
	}
}

func TestLoadBootConfig(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.json")
	if err := os.WriteFile(good, []byte(`{"dotId":"dot_1","token":" abc "}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadBootConfig(good)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DotID != "dot_1" || cfg.Token != "abc" {
		t.Errorf("got %+v", cfg)
	}

	empty := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(empty, []byte(`{"dotId":"dot_1","token":""}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadBootConfig(empty); err == nil {
		t.Error("an empty token must be refused")
	}
	if _, err := LoadBootConfig(filepath.Join(dir, "missing.json")); err == nil {
		t.Error("a missing file must be an error")
	}
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte(`{`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadBootConfig(bad); err == nil {
		t.Error("invalid JSON must be an error")
	}
}

func TestDefaultBindRequiresTheTokenOverTCP(t *testing.T) {
	// The daemon's real bind is every interface; check the token guard there
	// too, not only on the loopback listener the fixture uses.
	srv := New(Options{Token: testToken, Home: t.TempDir(), AgentSocket: filepath.Join(shortTempDir(t), "agent.sock")})
	ln, err := ListenTCP("0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	hs := NewHTTPServer(srv.RemoteHandler(), nil)
	go func() { _ = hs.Serve(ln) }()
	t.Cleanup(func() { _ = hs.Close() })
	url := "http://127.0.0.1:" + strconv.Itoa(ln.Addr().(*net.TCPAddr).Port) + "/v1/health"
	for auth, want := range map[string]int{"": http.StatusUnauthorized, "Bearer nope": http.StatusUnauthorized, "Bearer " + testToken: http.StatusOK} {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("Authorization %q: status %d, want %d", auth, resp.StatusCode, want)
		}
	}
}
