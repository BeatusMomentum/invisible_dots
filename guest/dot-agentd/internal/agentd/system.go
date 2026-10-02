package agentd

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// SystemAnswer is GET /v1/system.
type SystemAnswer struct {
	Hostname          string `json:"hostname"`
	UptimeS           int64  `json:"uptime_s"`
	CPUs              int    `json:"cpus"`
	MemTotalBytes     uint64 `json:"mem_total_bytes"`
	MemAvailableBytes uint64 `json:"mem_available_bytes"`
	DiskTotalBytes    uint64 `json:"disk_total_bytes"`
	DiskFreeBytes     uint64 `json:"disk_free_bytes"`
}

func (s *Server) handleSystem(w http.ResponseWriter, r *http.Request) {
	ans, err := s.system()
	if err != nil {
		s.log.Error("system info", "error", err)
		writeError(w, http.StatusInternalServerError, "system_info_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ans)
}

func (s *Server) system() (SystemAnswer, error) {
	var ans SystemAnswer
	host, err := os.Hostname()
	if err != nil {
		return ans, fmt.Errorf("hostname: %w", err)
	}
	ans.Hostname = host
	ans.CPUs = runtime.NumCPU()
	if ans.UptimeS, err = readUptime(filepath.Join(s.opts.ProcDir, "uptime")); err != nil {
		return ans, err
	}
	if ans.MemTotalBytes, ans.MemAvailableBytes, err = readMeminfo(filepath.Join(s.opts.ProcDir, "meminfo")); err != nil {
		return ans, err
	}
	// The disk that matters is the one home lives on: the overlay the Dot
	// fills, not the read-only runtime ISO.
	if ans.DiskTotalBytes, ans.DiskFreeBytes, err = diskUsage(s.opts.Home); err != nil {
		return ans, fmt.Errorf("disk usage of %s: %w", s.opts.Home, err)
	}
	return ans, nil
}

// readUptime parses the first field of /proc/uptime ("12345.67 98765.43").
func readUptime(path string) (int64, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", path, err)
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return 0, fmt.Errorf("%s is empty", path)
	}
	secs, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", path, err)
	}
	return int64(secs), nil
}

// readMeminfo returns MemTotal and MemAvailable in bytes (the file is in kB).
func readMeminfo(path string) (total, available uint64, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, fmt.Errorf("read %s: %w", path, err)
	}
	var haveTotal, haveAvail bool
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		key, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, perr := strconv.ParseUint(fields[0], 10, 64)
		if perr != nil {
			continue
		}
		switch key {
		case "MemTotal":
			total, haveTotal = v*1024, true
		case "MemAvailable":
			available, haveAvail = v*1024, true
		}
	}
	if !haveTotal || !haveAvail {
		return 0, 0, errors.New(path + " lacks MemTotal or MemAvailable")
	}
	return total, available, nil
}
