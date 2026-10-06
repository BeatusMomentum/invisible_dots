package agentd

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// The host's file routes (the API, the UI) reach the guest through the remote
// listener, which is limited to home. What a symbolic link may lead to is in
// files_links_test.go (unix only).

func wantRefused(t *testing.T, resp *http.Response) {
	t.Helper()
	wantStatus(t, resp, http.StatusForbidden)
	if body := decode[ErrorAnswer](t, resp); body.Error != "outside_home" {
		t.Errorf("error code %q, want outside_home", body.Error)
	}
}

func TestRemoteFilesRefuseAbsolutePathsOutsideHome(t *testing.T) {
	f := newFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files", filepath.Join(outside, "x.txt")), nil))
	wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files/list", outside), nil))
	wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files", "../x.txt"), nil))
	wantRefused(t, f.do(http.MethodPut, filesURL("/v1/files", filepath.Join(outside, "y.txt")), bytes.NewReader([]byte("y"))))
	if _, err := os.Stat(filepath.Join(outside, "y.txt")); err == nil {
		t.Error("a refused write created the file")
	}
	// A prefix of home's name is not home.
	sibling := f.home + "-other"
	if err := os.Mkdir(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sibling) })
	wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files/list", sibling), nil))
}
