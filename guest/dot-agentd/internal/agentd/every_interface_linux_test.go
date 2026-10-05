//go:build linux

package agentd

// The daemon's real bind is every interface, and only the Linux guest ever
// binds it. These tests bind 0.0.0.0, which on a Windows host makes Windows
// Firewall ask the user to allow every freshly built test binary, so they run
// where the behavior lives: on Linux (CI, the docker runner, WSL).

import (
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestListenTCPOnEveryInterfaceIsIPv4Only(t *testing.T) {
	// QEMU's forward reaches the guest over IPv4; a dual-stack socket would
	// show up as [::] and also answer on IPv6 addresses nobody asked for.
	ln, err := ListenTCP("0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || addr.IP.To4() == nil || !addr.IP.IsUnspecified() || addr.Port == 0 {
		t.Fatalf("bound %v", ln.Addr())
	}
	conn, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(addr.Port)), 2*time.Second)
	if err != nil {
		t.Fatalf("0.0.0.0 must accept loopback connections: %v", err)
	}
	_ = conn.Close()
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
