package agentd

import (
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
	"time"
)

// resolvePath turns a request path into a filesystem path. Relative paths are
// resolved against home (architecture section 5.2). Absolute paths are taken
// as they are: the Dot owns its whole computer, and whether a tool may touch a
// path is the policy engine's decision, not this daemon's.
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

func fsErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return http.StatusNotFound, "not_found"
	case errors.Is(err, fs.ErrPermission):
		return http.StatusForbidden, "permission_denied"
	default:
		return http.StatusInternalServerError, "io_error"
	}
}

func (s *Server) handleFileGet(w http.ResponseWriter, r *http.Request) {
	p, err := resolvePath(s.opts.Home, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_path", err.Error())
		return
	}
	f, err := os.Open(p)
	if err != nil {
		status, code := fsErrorStatus(err)
		writeError(w, status, code, err.Error())
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		status, code := fsErrorStatus(err)
		writeError(w, status, code, err.Error())
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

func (s *Server) handleFilePut(w http.ResponseWriter, r *http.Request) {
	p, err := resolvePath(s.opts.Home, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_path", err.Error())
		return
	}
	if info, err := os.Stat(p); err == nil && info.IsDir() {
		writeError(w, http.StatusBadRequest, "is_a_directory", p+" is a directory")
		return
	}
	if err := writeFileAtomic(p, r.Body); err != nil {
		status, code := fsErrorStatus(err)
		writeError(w, status, code, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeFileAtomic writes through a temporary file in the same directory and
// renames it, so a reader never sees half a file and a failed upload leaves
// the previous content in place.
func writeFileAtomic(p string, body io.Reader) error {
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	mode := fs.FileMode(0o644)
	if info, err := os.Stat(p); err == nil {
		mode = info.Mode().Perm()
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(p)+".upload-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := io.Copy(tmp, body); err != nil {
		return fmt.Errorf("write %s: %w", p, err)
	}
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, p); err != nil {
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

func (s *Server) handleFileList(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	if raw == "" {
		raw = "."
	}
	dir, err := resolvePath(s.opts.Home, raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_path", err.Error())
		return
	}
	info, err := os.Stat(dir)
	if err != nil {
		status, code := fsErrorStatus(err)
		writeError(w, status, code, err.Error())
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "not_a_directory", dir+" is not a directory")
		return
	}
	des, err := os.ReadDir(dir)
	if err != nil {
		status, code := fsErrorStatus(err)
		writeError(w, status, code, err.Error())
		return
	}
	entries := make([]FileEntry, 0, len(des))
	for _, de := range des {
		entries = append(entries, describeEntry(dir, de))
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	writeJSON(w, http.StatusOK, FileListAnswer{Entries: entries})
}

// describeEntry follows symlinks so a link to a directory lists as "dir";
// a dangling link is "other".
func describeEntry(dir string, de fs.DirEntry) FileEntry {
	e := FileEntry{Name: de.Name(), Type: "other"}
	info, err := os.Stat(filepath.Join(dir, de.Name()))
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
