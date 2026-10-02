package agentd

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func writeFakeProc(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"uptime":  "12345.67 98765.43\n",
		"meminfo": "MemTotal:        4028580 kB\nMemFree:          100000 kB\nMemAvailable:    3000000 kB\nBuffers:            1234 kB\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestSystemRoute(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("disk usage is implemented for unix only")
	}
	proc := writeFakeProc(t)
	f := newFixture(t, func(o *Options) { o.ProcDir = proc })
	resp := f.do(http.MethodGet, "/v1/system", nil)
	wantStatus(t, resp, http.StatusOK)
	got := decode[SystemAnswer](t, resp)
	host, _ := os.Hostname()
	if got.Hostname != host || got.UptimeS != 12345 || got.CPUs != runtime.NumCPU() {
		t.Errorf("got %+v", got)
	}
	if got.MemTotalBytes != 4028580*1024 || got.MemAvailableBytes != 3000000*1024 {
		t.Errorf("memory %d / %d", got.MemTotalBytes, got.MemAvailableBytes)
	}
	if got.DiskTotalBytes == 0 || got.DiskFreeBytes > got.DiskTotalBytes {
		t.Errorf("disk %d free of %d", got.DiskFreeBytes, got.DiskTotalBytes)
	}
}

func TestSystemRouteReportsMissingProc(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.ProcDir = filepath.Join(o.Home, "no-proc") })
	resp := f.do(http.MethodGet, "/v1/system", nil)
	wantStatus(t, resp, http.StatusInternalServerError)
	if body := decode[ErrorAnswer](t, resp); body.Error != "system_info_failed" {
		t.Errorf("error code %q", body.Error)
	}
}

func TestReadMeminfoNeedsBothFields(t *testing.T) {
	p := filepath.Join(t.TempDir(), "meminfo")
	if err := os.WriteFile(p, []byte("MemTotal: 10 kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readMeminfo(p); err == nil {
		t.Error("a meminfo without MemAvailable must be an error")
	}
}
