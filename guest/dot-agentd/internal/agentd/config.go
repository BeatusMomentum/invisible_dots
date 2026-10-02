package agentd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

// BootConfig is /etc/invisible-dots/config.json, written by cloud-init.
type BootConfig struct {
	DotID string `json:"dotId"`
	Token string `json:"token"`
}

// LoadBootConfig reads the guest boot configuration. A missing or empty token
// is an error: serving vsock without one would leave the VM open to anything
// on the host that can reach its CID.
func LoadBootConfig(path string) (BootConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return BootConfig{}, fmt.Errorf("read guest config %s: %w", path, err)
	}
	var cfg BootConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return BootConfig{}, fmt.Errorf("parse guest config %s: %w", path, err)
	}
	cfg.Token = strings.TrimSpace(cfg.Token)
	if cfg.Token == "" {
		return BootConfig{}, errors.New("guest config " + path + " has no token")
	}
	return cfg, nil
}
