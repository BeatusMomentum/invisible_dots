package agentd

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// resolvePath turns a request path into a filesystem path. Relative paths are
// resolved against home (architecture section 5.2). Absolute paths are taken
// as they are: the Dot owns its whole computer, and whether a tool may touch a
// path is the policy engine's decision, not this daemon's. (The remote
// listener narrows that to home: see openInHome.)
func resolvePath(home, p string) (string, error) {
	if p == "" {
		return "", errors.New("path is required")
	}
	if strings.ContainsRune(p, 0) {
		return "", errors.New("path contains a NUL byte")
	}
	if p == "~" {
		return filepath.Clean(home), nil
	}
	if rest, ok := strings.CutPrefix(p, "~/"); ok {
		p = rest
	}
	// The guest is Linux; path (not filepath) keeps the semantics identical
	// when the tests run on another OS.
	if filepath.IsAbs(p) {
		return filepath.Clean(p), nil
	}
	if path.IsAbs(p) {
		return filepath.FromSlash(path.Clean(p)), nil
	}
	return filepath.Join(home, filepath.FromSlash(p)), nil
}

// errOutsideHome is the answer of the remote listener to a path whose real
// location, once every symbolic link is followed, is not under home.
var errOutsideHome = errors.New("the path leads outside the home directory")

// errInvalidPath marks a request path that is malformed, as opposed to one
// the file system refuses.
type errInvalidPath struct{ error }

func fsErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, errOutsideHome):
		return http.StatusForbidden, "outside_home"
	case errors.Is(err, fs.ErrNotExist):
		return http.StatusNotFound, "not_found"
	case errors.Is(err, fs.ErrPermission):
		return http.StatusForbidden, "permission_denied"
	default:
		return http.StatusInternalServerError, "io_error"
	}
}

// fileSystem is what the file routes touch. On the engine's socket it is the
// operating system itself; on the remote listener it is a root on home.
type fileSystem interface {
	Open(name string) (*os.File, error)
	OpenFile(name string, flag int, perm fs.FileMode) (*os.File, error)
	Stat(name string) (fs.FileInfo, error)
	MkdirAll(name string, perm fs.FileMode) error
	Rename(oldName, newName string) error
	Remove(name string) error
}

// osFS is the whole computer.
type osFS struct{}

func (osFS) Open(name string) (*os.File, error) { return os.Open(name) }
func (osFS) OpenFile(name string, flag int, perm fs.FileMode) (*os.File, error) {
	return os.OpenFile(name, flag, perm)
}
func (osFS) Stat(name string) (fs.FileInfo, error)        { return os.Stat(name) }
func (osFS) MkdirAll(name string, perm fs.FileMode) error { return os.MkdirAll(name, perm) }
func (osFS) Rename(oldName, newName string) error         { return os.Rename(oldName, newName) }
func (osFS) Remove(name string) error                     { return os.Remove(name) }

// maxLinkHops bounds the dangling links resolveLinks follows by hand (the
// kernel's own limit for a path is 40).
const maxLinkHops = 40

// resolveLinks is p with every symbolic link followed. The part of p that does
// not exist yet has no link to follow and is kept as written, so a file about
// to be created resolves like one that is there. A link whose target does not
// exist is followed all the same, to where the target would be: left alone,
// a link out of home would look like a missing file inside it.
func resolveLinks(p string) (string, error) {
	var rest []string
	hops := 0
	for cur := p; ; {
		real, err := filepath.EvalSymlinks(cur)
		if err == nil {
			return filepath.Join(append([]string{real}, rest...)...), nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		if target, err := os.Readlink(cur); err == nil {
			if hops++; hops > maxLinkHops {
				return "", &fs.PathError{Op: "resolve", Path: p, Err: syscall.ELOOP}
			}
			if !filepath.IsAbs(target) {
				// A relative target starts at the real directory of the link: the
				// kernel follows the links of that directory before it applies a
				// "..", and Join would clean the ".." first. The directory exists,
				// Readlink just went through it.
				dir, err := filepath.EvalSymlinks(filepath.Dir(cur))
				if err != nil {
					return "", err
				}
				target = filepath.Join(dir, target)
			}
			cur = target
			continue
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", err
		}
		rest = append([]string{filepath.Base(cur)}, rest...)
		cur = parent
	}
}

// homeFS is the file system of the remote listener: home and nothing else.
// The host's file routes (the API, the UI) are limited to home, and a symbolic
// link must not lead out of it: the daemon runs as dot, the browser server of
// the engine runs as dot with the proxy password in its environment, and a
// link under home to /proc/<pid>/environ would put that password in the UI.
// Every name is resolved to its real location and refused unless that is under
// the real home (so /proc, which is outside it, is refused too); it is then
// opened through a root on home, which also refuses a link put in place after
// the check. This is the one place the confinement is decided.
type homeFS struct {
	root *os.Root
	home string // the real directory of home
}

func openHome(home string) (homeFS, error) {
	real, err := filepath.EvalSymlinks(home)
	if err != nil {
		return homeFS{}, err
	}
	root, err := os.OpenRoot(real)
	if err != nil {
		return homeFS{}, err
	}
	return homeFS{root: root, home: real}, nil
}

func (h homeFS) Close() error { return h.root.Close() }

// inside is name relative to home once its links are followed, or errOutsideHome.
func (h homeFS) inside(name string) (string, error) {
	real, err := resolveLinks(name)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(h.home, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errOutsideHome
	}
	return rel, nil
}

func (h homeFS) Open(name string) (*os.File, error) {
	rel, err := h.inside(name)
	if err != nil {
		return nil, err
	}
	return h.root.Open(rel)
}

func (h homeFS) OpenFile(name string, flag int, perm fs.FileMode) (*os.File, error) {
	rel, err := h.inside(name)
	if err != nil {
		return nil, err
	}
	return h.root.OpenFile(rel, flag, perm)
}

func (h homeFS) Stat(name string) (fs.FileInfo, error) {
	rel, err := h.inside(name)
	if err != nil {
		return nil, err
	}
	return h.root.Stat(rel)
}

func (h homeFS) MkdirAll(name string, perm fs.FileMode) error {
	rel, err := h.inside(name)
	if err != nil {
		return err
	}
	return h.root.MkdirAll(rel, perm)
}

// beside is the name of an entry of a directory, for the calls that act on the
// entry itself and not on what a link there points to (rename, remove): the
// directory is resolved, the entry is not.
func (h homeFS) beside(name string) (string, error) {
	dir, err := h.inside(filepath.Dir(name))
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, filepath.Base(name)), nil
}

func (h homeFS) Rename(oldName, newName string) error {
	from, err := h.beside(oldName)
	if err != nil {
		return err
	}
	to, err := h.beside(newName)
	if err != nil {
		return err
	}
	return h.root.Rename(from, to)
}

func (h homeFS) Remove(name string) error {
	rel, err := h.beside(name)
	if err != nil {
		return err
	}
	return h.root.Remove(rel)
}

// fileRoutes serves the three file routes of one listener. The remote one is
// confined to home (homeFS); the engine's socket is not.
type fileRoutes struct {
	s        *Server
	confined bool
}

// target resolves the request path to its absolute path and the file system
// to use it in; done releases what the file system holds open.
func (h fileRoutes) target(raw string) (fsys fileSystem, p string, done func(), err error) {
	p, err = resolvePath(h.s.opts.Home, raw)
	if err != nil {
		return nil, "", nil, errInvalidPath{err}
	}
	if !h.confined {
		return osFS{}, p, func() {}, nil
	}
	home, err := openHome(h.s.opts.Home)
	if err != nil {
		return nil, "", nil, err
	}
	return home, p, func() { _ = home.Close() }, nil
}

func (h fileRoutes) fail(w http.ResponseWriter, err error) {
	var invalid errInvalidPath
	if errors.As(err, &invalid) {
		writeError(w, http.StatusBadRequest, "invalid_path", invalid.Error())
		return
	}
	status, code := fsErrorStatus(err)
	message := err.Error()
	if errors.Is(err, errOutsideHome) {
		message = "the path leads outside " + h.s.opts.Home
	}
	writeError(w, status, code, message)
}

// actAsAccount makes the rest of the request act as the Dot's user: a file the
// model asks for is opened, created and owned as that user (account_linux.go
// says how), never as the daemon's. The home confinement of the remote
// listener is decided on top of it, by homeFS, as before.
func (h fileRoutes) actAsAccount(w http.ResponseWriter) (restore func(), ok bool) {
	restore, err := actAs(h.s.opts.RunAs)
	if err != nil {
		h.s.log.Error("act as the Dot's user", "error", err)
		writeError(w, http.StatusInternalServerError, "io_error", "the file operation could not act as the Dot's user")
		return nil, false
	}
	return restore, true
}

func (h fileRoutes) get(w http.ResponseWriter, r *http.Request) {
	restore, ok := h.actAsAccount(w)
	if !ok {
		return
	}
	defer restore()
	fsys, p, done, err := h.target(r.URL.Query().Get("path"))
	if err != nil {
		h.fail(w, err)
		return
	}
	defer done()
	f, err := fsys.Open(p)
	if err != nil {
		h.fail(w, err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		h.fail(w, err)
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "is_a_directory", p+" is a directory; use /v1/files/list")
		return
	}
	if !info.Mode().IsRegular() {
		writeError(w, http.StatusBadRequest, "not_a_regular_file", p+" is not a regular file")
		return
	}
	// Setting the type first stops ServeContent from sniffing it: callers
	// treat the answer as bytes, always.
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func (h fileRoutes) put(w http.ResponseWriter, r *http.Request) {
	restore, ok := h.actAsAccount(w)
	if !ok {
		return
	}
	defer restore()
	fsys, p, done, err := h.target(r.URL.Query().Get("path"))
	if err != nil {
		h.fail(w, err)
		return
	}
	defer done()
	info, err := fsys.Stat(p)
	switch {
	case errors.Is(err, errOutsideHome):
		// Not replaced either: the answer is the same as for a read.
		h.fail(w, err)
		return
	case err == nil && info.IsDir():
		writeError(w, http.StatusBadRequest, "is_a_directory", p+" is a directory")
		return
	}
	if err := writeFileAtomic(fsys, p, r.Body); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeFileAtomic writes through a temporary file in the same directory and
// renames it, so a reader never sees half a file and a failed upload leaves
// the previous content in place.
func writeFileAtomic(fsys fileSystem, name string, body io.Reader) error {
	dir := filepath.Dir(name)
	if err := fsys.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	mode := fs.FileMode(0o644)
	if info, err := fsys.Stat(name); err == nil {
		mode = info.Mode().Perm()
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	tmpName := filepath.Join(dir, "."+filepath.Base(name)+".upload-"+hex.EncodeToString(suffix[:]))
	tmp, err := fsys.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			_ = tmp.Close()
			_ = fsys.Remove(tmpName)
		}
	}()
	if _, err := io.Copy(tmp, body); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := fsys.Rename(tmpName, name); err != nil {
		return err
	}
	ok = true
	return nil
}

// FileEntry is one item of GET /v1/files/list.
type FileEntry struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Size  int64  `json:"size"`
	Mtime string `json:"mtime"`
}

// FileListAnswer is GET /v1/files/list.
type FileListAnswer struct {
	Entries []FileEntry `json:"entries"`
}

// mtimeLayout matches JavaScript's Date.prototype.toISOString, which is what
// the TypeScript side produces and parses.
const mtimeLayout = "2006-01-02T15:04:05.000Z07:00"

func (h fileRoutes) list(w http.ResponseWriter, r *http.Request) {
	restore, ok := h.actAsAccount(w)
	if !ok {
		return
	}
	defer restore()
	raw := r.URL.Query().Get("path")
	if raw == "" {
		raw = "."
	}
	fsys, p, done, err := h.target(raw)
	if err != nil {
		h.fail(w, err)
		return
	}
	defer done()
	info, err := fsys.Stat(p)
	if err != nil {
		h.fail(w, err)
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "not_a_directory", p+" is not a directory")
		return
	}
	d, err := fsys.Open(p)
	if err != nil {
		h.fail(w, err)
		return
	}
	defer d.Close()
	des, err := d.ReadDir(-1)
	if err != nil {
		h.fail(w, err)
		return
	}
	entries := make([]FileEntry, 0, len(des))
	for _, de := range des {
		entries = append(entries, describeEntry(fsys, p, de))
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	writeJSON(w, http.StatusOK, FileListAnswer{Entries: entries})
}

// describeEntry follows symlinks so a link to a directory lists as "dir";
// a dangling link, or on the remote listener one that leads out of home, is
// "other" and tells nothing about its target.
func describeEntry(fsys fileSystem, dir string, de fs.DirEntry) FileEntry {
	e := FileEntry{Name: de.Name(), Type: "other"}
	info, err := fsys.Stat(filepath.Join(dir, de.Name()))
	if err != nil {
		if li, lerr := de.Info(); lerr == nil {
			info = li
		} else {
			e.Mtime = time.Unix(0, 0).UTC().Format(mtimeLayout)
			return e
		}
	} else {
		switch {
		case info.IsDir():
			e.Type = "dir"
		case info.Mode().IsRegular():
			e.Type = "file"
		}
	}
	if e.Type == "file" {
		e.Size = info.Size()
	}
	e.Mtime = info.ModTime().UTC().Format(mtimeLayout)
	return e
}
