package agentd

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
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

func TestPowerOffStartsTheCommandAndAnswers202(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in command is a shell; the guest is linux")
	}
	marker := filepath.Join(t.TempDir(), "powered-off")
	f := newFixture(t, func(o *Options) { o.PowerOff = []string{"sh", "-c", "echo off > " + marker} })
	resp := f.do(http.MethodPost, "/v1/system/poweroff", nil)
	wantStatus(t, resp, http.StatusAccepted)
	if got := decode[PowerOffAnswer](t, resp); got.Status != "powering_off" {
		t.Errorf("answer %+v", got)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the poweroff command never ran")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestPowerOffNeedsTheToken(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.PowerOff = []string{"no-such-poweroff-command"} })
	req, err := http.NewRequest(http.MethodPost, f.baseURL+"/v1/system/poweroff", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	wantStatus(t, resp, http.StatusUnauthorized)
}

func TestPowerOffReportsACommandThatCannotStart(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.PowerOff = []string{"no-such-poweroff-command"} })
	resp := f.do(http.MethodPost, "/v1/system/poweroff", nil)
	wantStatus(t, resp, http.StatusInternalServerError)
	if body := decode[ErrorAnswer](t, resp); body.Error != "poweroff_failed" {
		t.Errorf("error code %q", body.Error)
	}
}

func TestPowerOffIsNotOfferedToTheAgent(t *testing.T) {
	srv := New(Options{Token: testToken, PowerOff: []string{"no-such-poweroff-command"}})
	rec := httptest.NewRecorder()
	srv.LocalHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/system/poweroff", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("the local socket answered %d to a poweroff", rec.Code)
	}
}

func TestDefaultPowerOffIsTheContractCommand(t *testing.T) {
	if got := New(Options{}).opts.PowerOff; len(got) != 4 || got[0] != "sudo" || got[1] != "-n" || got[2] != "systemctl" || got[3] != "poweroff" {
		t.Errorf("default poweroff %v", got)
	}
}
