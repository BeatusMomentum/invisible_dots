package agentd

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestListenUnixIsPrivateAndReplacesStaleSocket(t *testing.T) {
	dir := shortTempDir(t)
	sock := filepath.Join(dir, "run", "agentd.sock")
	ln, err := ListenUnix(sock)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(sock)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o660 {
			t.Errorf("socket mode %v, want 0660 (the owner and the engine's group)", perm)
		}
	}
	if runtime.GOOS == "windows" {
		_ = ln.Close()
		return
	}
	// Simulate a crash: the socket file stays behind.
	if ul, ok := ln.(interface{ SetUnlinkOnClose(bool) }); ok {
		ul.SetUnlinkOnClose(false)
	}
	_ = ln.Close()
	if _, err := os.Lstat(sock); err != nil {
		t.Fatalf("stale socket not left behind: %v", err)
	}
	ln2, err := ListenUnix(sock)
	if err != nil {
		t.Fatalf("a stale socket must be replaced: %v", err)
	}
	_ = ln2.Close()
}

func TestListenUnixRefusesToDeleteARegularFile(t *testing.T) {
	dir := shortTempDir(t)
	p := filepath.Join(dir, "agentd.sock")
	if err := os.WriteFile(p, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ln, err := ListenUnix(p); err == nil {
		_ = ln.Close()
		t.Fatal("listened over a regular file")
	}
	if raw, _ := os.ReadFile(p); string(raw) != "keep me" {
		t.Error("the regular file was modified")
	}
}

func TestListenTCPRejectsAnythingButAnIPAndAPort(t *testing.T) {
	for _, bad := range []string{
		"garbage", "1024", ":1024", "localhost:0", "dot.example:0",
		"0.0.0.0:70000", "0.0.0.0:-1", "0.0.0.0:http", "0.0.0.0:",
	} {
		if ln, err := ListenTCP(bad); err == nil {
			_ = ln.Close()
			t.Errorf("%q was accepted", bad)
		}
	}
}

func TestListenTCPLoopback(t *testing.T) {
	ln, err := ListenTCP("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if addr := ln.Addr().(*net.TCPAddr); !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Errorf("bound %v", addr)
	}
}

func TestListenTCPReportsAPortInUse(t *testing.T) {
	first, err := ListenTCP("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if ln, err := ListenTCP(first.Addr().String()); err == nil {
		_ = ln.Close()
		t.Fatal("a port in use was bound twice")
	} else if !strings.Contains(err.Error(), first.Addr().String()) {
		t.Errorf("the error does not name the address: %v", err)
	}
}
