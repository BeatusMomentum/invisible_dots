package agentd

import (
	"os"
	"path/filepath"
	"runtime"
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
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("socket mode %v, want 0600", perm)
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

func TestListenLoopbackTCPOnly(t *testing.T) {
	for _, bad := range []string{"0.0.0.0:0", ":0", "localhost:0", "[::1]:0", "10.0.0.1:0", "garbage"} {
		if ln, err := ListenLoopbackTCP(bad); err == nil {
			_ = ln.Close()
			t.Errorf("%q was accepted", bad)
		}
	}
	ln, err := ListenLoopbackTCP("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_ = ln.Close()
}
