//go:build unix

package agentd

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The host's file routes (the API, the UI) reach the guest through the remote
// listener, which is limited to home: a symbolic link under home must not show
// what is outside it, /proc/<pid>/environ of the browser server (the proxy
// password) above all.

func symlinkMust(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func TestRemoteFilesRefuseLinksThatLeaveHome(t *testing.T) {
	f := newFixture(t)
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("hunter2"), 0o644); err != nil {
		t.Fatal(err)
	}
	relToSecret, err := filepath.Rel(f.home, secret)
	if err != nil {
		t.Fatal(err)
	}
	symlinkMust(t, secret, filepath.Join(f.home, "absolute-link"))
	symlinkMust(t, relToSecret, filepath.Join(f.home, "relative-link"))
	symlinkMust(t, outside, filepath.Join(f.home, "dir-link"))
	symlinkMust(t, filepath.Join(f.home, "absolute-link"), filepath.Join(f.home, "chain"))
	if err := os.Mkdir(filepath.Join(f.home, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkMust(t, outside, filepath.Join(f.home, "sub", "up"))

	for _, p := range []string{
		"absolute-link", "relative-link", "chain", "dir-link/secret.txt", "sub/up/secret.txt",
		"~/dir-link/secret.txt", filepath.Join(f.home, "dir-link", "secret.txt"),
		// Not links: a path that is itself outside home.
		secret, "../" + filepath.Base(outside) + "/secret.txt",
	} {
		resp := f.do(http.MethodGet, filesURL("/v1/files", p), nil)
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusForbidden || bytes.Contains(raw, []byte("hunter2")) {
			t.Errorf("GET %q: status %d, body %q; want 403 and no secret", p, resp.StatusCode, raw)
		}
	}

	for _, p := range []string{"dir-link", "sub/up", outside, ".."} {
		wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files/list", p), nil))
	}

	// Writes are limited too: through a directory link, over a file link, and
	// to a path that does not exist yet beyond a link.
	for _, p := range []string{"dir-link/new.txt", "dir-link/deeper/new.txt", "absolute-link", filepath.Join(outside, "abs.txt")} {
		wantRefused(t, f.do(http.MethodPut, filesURL("/v1/files", p), bytes.NewReader([]byte("planted"))))
	}
	if raw, _ := os.ReadFile(secret); string(raw) != "hunter2" {
		t.Errorf("the file outside home holds %q after the refused writes", raw)
	}
	des, _ := os.ReadDir(outside)
	if len(des) != 1 {
		t.Errorf("the directory outside home holds %d entries after the refused writes, want only secret.txt", len(des))
	}
}

// A link whose target does not exist yet is a way out of home as much as one
// whose target does: the answer is the same 403, and a write through it creates
// nothing outside.
func TestRemoteFilesRefuseDanglingLinksThatLeaveHome(t *testing.T) {
	f := newFixture(t)
	outside := t.TempDir()
	symlinkMust(t, filepath.Join(outside, "missing.txt"), filepath.Join(f.home, "dangfile"))
	symlinkMust(t, filepath.Join(outside, "missing-dir"), filepath.Join(f.home, "dangdir"))
	symlinkMust(t, filepath.Join(f.home, "dangfile"), filepath.Join(f.home, "dangchain"))
	symlinkMust(t, "../"+filepath.Base(outside)+"/relative-missing", filepath.Join(f.home, "dangrel"))

	for _, p := range []string{"dangfile", "dangdir/x", "dangdir/deeper/x", "dangchain", "dangrel", "~/dangdir/x"} {
		wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files", p), nil))
		wantRefused(t, f.do(http.MethodPut, filesURL("/v1/files", p), bytes.NewReader([]byte("planted"))))
	}
	for _, p := range []string{"dangdir", "dangfile"} {
		wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files/list", p), nil))
	}
	if des, _ := os.ReadDir(outside); len(des) != 0 {
		t.Errorf("the directory outside home holds %d entries after the refused writes, want none", len(des))
	}
}

// A dangling link whose target is inside home is not a way out: reading it is a
// 404 like any missing file, and a write creates the file at the target.
func TestRemoteFilesFollowDanglingLinksInsideHome(t *testing.T) {
	f := newFixture(t)
	symlinkMust(t, filepath.Join(f.home, "later.txt"), filepath.Join(f.home, "soon"))
	symlinkMust(t, "no-such-dir", filepath.Join(f.home, "soon-dir"))

	wantStatus(t, f.do(http.MethodGet, filesURL("/v1/files", "soon"), nil), http.StatusNotFound)
	wantStatus(t, f.do(http.MethodGet, filesURL("/v1/files", "soon-dir/x"), nil), http.StatusNotFound)
	wantStatus(t, f.do(http.MethodPut, filesURL("/v1/files", "soon-dir/x"), bytes.NewReader([]byte("N"))), http.StatusNoContent)
	if raw, _ := os.ReadFile(filepath.Join(f.home, "no-such-dir", "x")); string(raw) != "N" {
		t.Errorf("a write through a dangling link in home wrote %q", raw)
	}
}

// A relative target of a dangling link starts at the real directory of the
// link, not at the directory as written: the kernel follows the links of that
// directory before it applies a "..".
func TestRemoteFilesResolveARelativeDanglingLinkFromItsRealDirectory(t *testing.T) {
	f := newFixture(t)

	// A link out of home, in a directory reached through a link, whose "..",
	// written from home, would land on a file in home: that file is not the one
	// the link names, and nothing of home is served for it.
	outside := t.TempDir()
	symlinkMust(t, outside, filepath.Join(f.home, "out"))
	symlinkMust(t, "../stolen", filepath.Join(outside, "d"))
	if err := os.WriteFile(filepath.Join(f.home, "stolen"), []byte("HOME-FILE"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp := f.do(http.MethodGet, filesURL("/v1/files", "out/d"), nil)
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusForbidden || bytes.Contains(raw, []byte("HOME-FILE")) {
		t.Errorf("GET out/d: status %d, body %q; want 403 and no file of home", resp.StatusCode, raw)
	}
	wantRefused(t, f.do(http.MethodPut, filesURL("/v1/files", "out/d"), bytes.NewReader([]byte("planted"))))
	if raw, _ := os.ReadFile(filepath.Join(f.home, "stolen")); string(raw) != "HOME-FILE" {
		t.Errorf("the file of home holds %q after the refused write", raw)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(outside), "stolen")); err == nil {
		t.Errorf("a write through the link created a file outside home")
	}

	// A link to a place inside home, in a directory reached through a link: its
	// real location is in home, so it is a missing file, not a way out.
	deep := filepath.Join(f.home, "s1", "s2", "s3")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkMust(t, deep, filepath.Join(f.home, "a"))
	symlinkMust(t, "../../y", filepath.Join(deep, "l"))
	wantStatus(t, f.do(http.MethodGet, filesURL("/v1/files", "a/l"), nil), http.StatusNotFound)
	wantStatus(t, f.do(http.MethodGet, filesURL("/v1/files", "s1/s2/s3/l"), nil), http.StatusNotFound)
	// A write replaces the entry, as it does for every file (a link included),
	// in the real directory: it is accepted, and lands in home.
	wantStatus(t, f.do(http.MethodPut, filesURL("/v1/files", "a/l"), bytes.NewReader([]byte("Y"))), http.StatusNoContent)
	if raw, _ := os.ReadFile(filepath.Join(deep, "l")); string(raw) != "Y" {
		t.Errorf("a write to a/l wrote %q at home/s1/s2/s3/l", raw)
	}
}

func TestRemoteFilesRefuseProc(t *testing.T) {
	if _, err := os.Stat("/proc/self/environ"); err != nil {
		t.Fatalf("the guest is linux and has /proc: %v", err)
	}
	f := newFixture(t)
	symlinkMust(t, "/proc/self/environ", filepath.Join(f.home, "environ"))
	symlinkMust(t, "/proc/self", filepath.Join(f.home, "self"))
	symlinkMust(t, "/proc", filepath.Join(f.home, "proc"))
	for _, p := range []string{"environ", "self/environ", "proc/self/environ", "proc/1/environ", "/proc/self/environ", "/proc/self/cmdline"} {
		wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files", p), nil))
	}
	for _, p := range []string{"proc", "self", "/proc", "/proc/self"} {
		wantRefused(t, f.do(http.MethodGet, filesURL("/v1/files/list", p), nil))
	}
}

func TestRemoteFilesKeepLinksThatStayInHome(t *testing.T) {
	f := newFixture(t)
	if err := os.MkdirAll(filepath.Join(f.home, "documents"), 0o755); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(f.home, "documents", "note.txt")
	if err := os.WriteFile(note, []byte("kept"), 0o644); err != nil {
		t.Fatal(err)
	}
	symlinkMust(t, filepath.Join(f.home, "documents"), filepath.Join(f.home, "docs-absolute"))
	symlinkMust(t, "documents", filepath.Join(f.home, "docs-relative"))
	symlinkMust(t, note, filepath.Join(f.home, "note-absolute"))

	for _, p := range []string{"docs-absolute/note.txt", "docs-relative/note.txt", "note-absolute", "documents/note.txt", "~/docs-relative/note.txt"} {
		resp := f.do(http.MethodGet, filesURL("/v1/files", p), nil)
		wantStatus(t, resp, http.StatusOK)
		if raw, _ := io.ReadAll(resp.Body); string(raw) != "kept" {
			t.Errorf("GET %q: %q", p, raw)
		}
	}
	resp := f.do(http.MethodGet, filesURL("/v1/files/list", "docs-absolute"), nil)
	wantStatus(t, resp, http.StatusOK)
	if got := decode[FileListAnswer](t, resp); len(got.Entries) != 1 || got.Entries[0].Name != "note.txt" || got.Entries[0].Size != 4 {
		t.Errorf("listing through a link in home: %+v", got.Entries)
	}
	wantStatus(t, f.do(http.MethodPut, filesURL("/v1/files", "docs-relative/made/new.txt"), bytes.NewReader([]byte("N"))), http.StatusNoContent)
	if raw, _ := os.ReadFile(filepath.Join(f.home, "documents", "made", "new.txt")); string(raw) != "N" {
		t.Errorf("a write through a link in home wrote %q", raw)
	}
	des, _ := os.ReadDir(filepath.Join(f.home, "documents"))
	for _, de := range des {
		if strings.Contains(de.Name(), ".upload-") {
			t.Errorf("temporary file %s left behind", de.Name())
		}
	}
}

func TestRemoteFilesFollowAHomeThatIsALink(t *testing.T) {
	real := t.TempDir()
	if err := os.WriteFile(filepath.Join(real, "a.txt"), []byte("A"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "home")
	symlinkMust(t, real, link)
	f := newFixture(t, func(o *Options) { o.Home = link })
	resp := f.do(http.MethodGet, filesURL("/v1/files", "a.txt"), nil)
	wantStatus(t, resp, http.StatusOK)
	wantStatus(t, f.do(http.MethodGet, filesURL("/v1/files", filepath.Join(link, "a.txt")), nil), http.StatusOK)
	wantStatus(t, f.do(http.MethodGet, filesURL("/v1/files", filepath.Join(real, "a.txt")), nil), http.StatusOK)
}

func TestListingHidesWhereALinkOutOfHomeLeads(t *testing.T) {
	f := newFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "big.bin"), make([]byte, 5000), 0o644); err != nil {
		t.Fatal(err)
	}
	symlinkMust(t, filepath.Join(outside, "big.bin"), filepath.Join(f.home, "to-file"))
	symlinkMust(t, outside, filepath.Join(f.home, "to-dir"))
	resp := f.do(http.MethodGet, "/v1/files/list", nil)
	wantStatus(t, resp, http.StatusOK)
	for _, e := range decode[FileListAnswer](t, resp).Entries {
		if e.Type != "other" || e.Size != 0 {
			t.Errorf("%s: %+v; a link out of home must list as other, with no size", e.Name, e)
		}
	}
	// The engine's socket still sees through them.
	resp = f.doLocal(http.MethodGet, "/v1/files/list", nil)
	wantStatus(t, resp, http.StatusOK)
	types := map[string]string{}
	for _, e := range decode[FileListAnswer](t, resp).Entries {
		types[e.Name] = e.Type
	}
	if types["to-file"] != "file" || types["to-dir"] != "dir" {
		t.Errorf("local listing %v", types)
	}
}

func TestLocalFilesFollowLinksWherever(t *testing.T) {
	f := newFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "s.txt"), []byte("engine"), 0o644); err != nil {
		t.Fatal(err)
	}
	symlinkMust(t, outside, filepath.Join(f.home, "out"))
	resp := f.doLocal(http.MethodGet, filesURL("/v1/files", "out/s.txt"), nil)
	wantStatus(t, resp, http.StatusOK)
	if raw, _ := io.ReadAll(resp.Body); string(raw) != "engine" {
		t.Errorf("local read %q", raw)
	}
	wantStatus(t, f.doLocal(http.MethodPut, filesURL("/v1/files", "out/w.txt"), bytes.NewReader([]byte("w"))), http.StatusNoContent)
	if raw, _ := os.ReadFile(filepath.Join(outside, "w.txt")); string(raw) != "w" {
		t.Errorf("local write %q", raw)
	}
}

// A link put in place between the check and the open is refused by the root
// the file is opened through.
func TestHomeFSRootRefusesALinkSwappedInAfterTheCheck(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("hunter2"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "dir", "secret.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	fsys, err := openHome(home)
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	rel, err := fsys.inside(filepath.Join(home, "dir", "secret.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(home, "dir"), filepath.Join(home, "moved")); err != nil {
		t.Fatal(err)
	}
	symlinkMust(t, outside, filepath.Join(home, "dir"))
	if f, err := fsys.root.Open(rel); err == nil {
		raw, _ := io.ReadAll(f)
		f.Close()
		t.Fatalf("the root opened %q through a link that leads out of home", raw)
	}
}
