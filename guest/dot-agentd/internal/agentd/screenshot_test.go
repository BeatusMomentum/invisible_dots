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

// fakeImport writes a shell script standing in for ImageMagick's import.
func fakeImport(t *testing.T, script string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "import")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestScreenshotReturnsPNG(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args")
	bin := fakeImport(t, `echo "$@" > `+argsFile+`
printf '\211PNG\r\n\032\nfake-image-data'
`)
	f := newFixture(t, func(o *Options) { o.ImportBin = bin })
	resp := f.do(http.MethodGet, "/v1/screenshot", nil)
	wantStatus(t, resp, http.StatusOK)
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type %q", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.HasPrefix(body, pngMagic) || !bytes.HasSuffix(body, []byte("fake-image-data")) {
		t.Errorf("body %q", body)
	}
	args, _ := os.ReadFile(argsFile)
	if got := strings.TrimSpace(string(args)); got != "-window root -display :0 png:-" {
		t.Errorf("import called with %q", got)
	}
}

func TestScreenshotFailureIs503WithStderr(t *testing.T) {
	bin := fakeImport(t, `echo "import: unable to open X server ':0'" >&2; exit 1`)
	f := newFixture(t, func(o *Options) { o.ImportBin = bin })
	resp := f.do(http.MethodGet, "/v1/screenshot", nil)
	wantStatus(t, resp, http.StatusServiceUnavailable)
	body := decode[ErrorAnswer](t, resp)
	if body.Error != "screenshot_failed" || !strings.Contains(body.Message, "unable to open X server") {
		t.Errorf("got %+v", body)
	}
}

func TestScreenshotRejectsNonPNG(t *testing.T) {
	bin := fakeImport(t, `printf 'GIF89a'`)
	f := newFixture(t, func(o *Options) { o.ImportBin = bin })
	resp := f.do(http.MethodGet, "/v1/screenshot", nil)
	wantStatus(t, resp, http.StatusServiceUnavailable)
}

func TestScreenshotMissingBinary(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.ImportBin = filepath.Join(t.TempDir(), "no-import") })
	resp := f.do(http.MethodGet, "/v1/screenshot", nil)
	wantStatus(t, resp, http.StatusServiceUnavailable)
}
