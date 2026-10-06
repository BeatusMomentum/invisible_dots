package agentd

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func filesURL(route, p string) string {
	return route + "?path=" + url.QueryEscape(p)
}

func TestFilesRoundTripBinary(t *testing.T) {
	f := newFixture(t)
	content := make([]byte, 300_000)
	for i := range content {
		content[i] = byte(i * 7)
	}
	resp := f.do(http.MethodPut, filesURL("/v1/files", "workspace/deep/data.bin"), bytes.NewReader(content))
	wantStatus(t, resp, http.StatusNoContent)

	onDisk, err := os.ReadFile(filepath.Join(f.home, "workspace", "deep", "data.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, content) {
		t.Fatal("the file on disk differs from the upload")
	}

	resp = f.do(http.MethodGet, filesURL("/v1/files", "workspace/deep/data.bin"), nil)
	wantStatus(t, resp, http.StatusOK)
	if ct := resp.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type %q", ct)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatal("download differs from the upload")
	}
}

func TestFilesOverwriteKeepsModeAndLeavesNoTempFiles(t *testing.T) {
	f := newFixture(t)
	target := filepath.Join(f.home, "script.sh")
	if err := os.WriteFile(target, []byte("old"), 0o750); err != nil {
		t.Fatal(err)
	}
	resp := f.do(http.MethodPut, filesURL("/v1/files", "script.sh"), bytes.NewReader([]byte("new")))
	wantStatus(t, resp, http.StatusNoContent)
	raw, _ := os.ReadFile(target)
	if string(raw) != "new" {
		t.Errorf("content %q", raw)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(target)
		if info.Mode().Perm() != 0o750 {
			t.Errorf("mode %v, want 0750", info.Mode().Perm())
		}
	}
	des, _ := os.ReadDir(f.home)
	if len(des) != 1 {
		t.Errorf("home holds %d entries, want only script.sh", len(des))
	}
}

// The engine's socket takes absolute paths as they are: the Dot owns its whole
// computer (the remote listener is limited to home, see files_confined_test.go).
func TestFilesAbsoluteAndTildePaths(t *testing.T) {
	f := newFixture(t)
	other := t.TempDir()
	abs := filepath.Join(other, "abs.txt")
	resp := f.doLocal(http.MethodPut, filesURL("/v1/files", abs), bytes.NewReader([]byte("A")))
	wantStatus(t, resp, http.StatusNoContent)
	if raw, _ := os.ReadFile(abs); string(raw) != "A" {
		t.Errorf("absolute path wrote %q", raw)
	}

	resp = f.do(http.MethodPut, filesURL("/v1/files", "~/notes.txt"), bytes.NewReader([]byte("T")))
	wantStatus(t, resp, http.StatusNoContent)
	if raw, _ := os.ReadFile(filepath.Join(f.home, "notes.txt")); string(raw) != "T" {
		t.Errorf("~/ path wrote %q", raw)
	}
}

func TestFilesErrors(t *testing.T) {
	f := newFixture(t)
	if err := os.Mkdir(filepath.Join(f.home, "adir"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, method, route, path string
		status                    int
		code                      string
	}{
		{"get missing", http.MethodGet, "/v1/files", "nope.txt", 404, "not_found"},
		{"get directory", http.MethodGet, "/v1/files", "adir", 400, "is_a_directory"},
		{"get no path", http.MethodGet, "/v1/files", "", 400, "invalid_path"},
		{"get NUL", http.MethodGet, "/v1/files", "a\x00b", 400, "invalid_path"},
		{"put NUL", http.MethodPut, "/v1/files", "a\x00b", 400, "invalid_path"},
		{"put directory", http.MethodPut, "/v1/files", "adir", 400, "is_a_directory"},
		{"put no path", http.MethodPut, "/v1/files", "", 400, "invalid_path"},
		{"list NUL", http.MethodGet, "/v1/files/list", "a\x00b", 400, "invalid_path"},
		{"list missing", http.MethodGet, "/v1/files/list", "nope", 404, "not_found"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp := f.do(c.method, filesURL(c.route, c.path), bytes.NewReader(nil))
			wantStatus(t, resp, c.status)
			if body := decode[ErrorAnswer](t, resp); body.Error != c.code {
				t.Errorf("error code %q, want %q", body.Error, c.code)
			}
		})
	}
	if _, err := os.Stat(filepath.Join(f.home, "a")); err == nil {
		t.Error("a path with NUL must not be truncated and written")
	}
}

func TestFilesListing(t *testing.T) {
	f := newFixture(t)
	ws := filepath.Join(f.home, "workspace")
	if err := os.MkdirAll(filepath.Join(ws, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "b.txt"), []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "a.txt"), []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	mtime := time.Date(2026, 3, 4, 5, 6, 7, 890_000_000, time.UTC)
	if err := os.Chtimes(filepath.Join(ws, "a.txt"), mtime, mtime); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(filepath.Join(ws, "sub"), filepath.Join(ws, "link-dir")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(ws, "gone"), filepath.Join(ws, "link-dangling")); err != nil {
			t.Fatal(err)
		}
	}

	resp := f.do(http.MethodGet, filesURL("/v1/files/list", "workspace"), nil)
	wantStatus(t, resp, http.StatusOK)
	got := decode[FileListAnswer](t, resp)

	want := map[string]FileEntry{
		"a.txt": {Name: "a.txt", Type: "file", Size: 1, Mtime: "2026-03-04T05:06:07.890Z"},
		"b.txt": {Name: "b.txt", Type: "file", Size: 5},
		"sub":   {Name: "sub", Type: "dir"},
	}
	if runtime.GOOS != "windows" {
		want["link-dir"] = FileEntry{Name: "link-dir", Type: "dir"}
		want["link-dangling"] = FileEntry{Name: "link-dangling", Type: "other"}
	}
	if len(got.Entries) != len(want) {
		t.Fatalf("entries %+v", got.Entries)
	}
	for i, e := range got.Entries {
		if i > 0 && got.Entries[i-1].Name >= e.Name {
			t.Errorf("entries not sorted: %q before %q", got.Entries[i-1].Name, e.Name)
		}
		w, ok := want[e.Name]
		if !ok {
			t.Errorf("unexpected entry %q", e.Name)
			continue
		}
		if e.Type != w.Type || e.Size != w.Size {
			t.Errorf("%s: got %+v, want %+v", e.Name, e, w)
		}
		if w.Mtime != "" && e.Mtime != w.Mtime {
			t.Errorf("%s: mtime %q, want %q", e.Name, e.Mtime, w.Mtime)
		}
		if _, err := time.Parse(time.RFC3339Nano, e.Mtime); err != nil {
			t.Errorf("%s: mtime %q is not RFC 3339: %v", e.Name, e.Mtime, err)
		}
	}

	// No path lists home.
	resp = f.do(http.MethodGet, "/v1/files/list", nil)
	wantStatus(t, resp, http.StatusOK)
	home := decode[FileListAnswer](t, resp)
	if len(home.Entries) != 1 || home.Entries[0].Name != "workspace" {
		t.Errorf("home listing %+v", home.Entries)
	}

	// An empty directory is an empty array, never null.
	resp = f.do(http.MethodGet, filesURL("/v1/files/list", "workspace/sub"), nil)
	wantStatus(t, resp, http.StatusOK)
	raw, _ := io.ReadAll(resp.Body)
	if !bytes.Contains(raw, []byte(`"entries":[]`)) {
		t.Errorf("empty listing %s", raw)
	}

	resp = f.do(http.MethodGet, filesURL("/v1/files/list", "workspace/a.txt"), nil)
	wantStatus(t, resp, http.StatusBadRequest)
}

func TestResolvePath(t *testing.T) {
	home := filepath.FromSlash("/home/dot")
	cases := []struct {
		in, want string
		bad      bool
	}{
		{in: "workspace/x.txt", want: filepath.Join(home, "workspace", "x.txt")},
		{in: "./a/../b", want: filepath.Join(home, "b")},
		{in: "~", want: home},
		{in: "~/memory/n.md", want: filepath.Join(home, "memory", "n.md")},
		{in: "/etc/hosts", want: filepath.FromSlash("/etc/hosts")},
		{in: "/tmp/../var/x", want: filepath.FromSlash("/var/x")},
		{in: "", bad: true},
		{in: "x\x00y", bad: true},
	}
	for _, c := range cases {
		got, err := resolvePath(home, c.in)
		if c.bad {
			if err == nil {
				t.Errorf("resolvePath(%q) = %q, want an error", c.in, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("resolvePath(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
}
