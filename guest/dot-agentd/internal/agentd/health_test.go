package agentd

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

type healthBody struct {
	Agentd  string          `json:"agentd"`
	Agent   json.RawMessage `json:"agent"`
	UptimeS *int64          `json:"uptime_s"`
}

func getHealth(t *testing.T, f *fixture) healthBody {
	t.Helper()
	resp := f.do(http.MethodGet, "/v1/health", nil)
	wantStatus(t, resp, http.StatusOK)
	return decode[healthBody](t, resp)
}

func TestHealthAgentDown(t *testing.T) {
	f := newFixture(t)
	h := getHealth(t, f)
	if h.Agentd != "ok" || h.UptimeS == nil {
		t.Fatalf("got %+v", h)
	}
	var agent map[string]any
	if err := json.Unmarshal(h.Agent, &agent); err != nil {
		t.Fatal(err)
	}
	if agent["status"] != "down" {
		t.Errorf("agent %s, want status down", h.Agent)
	}
}

func TestHealthAgentUpIsPassedThrough(t *testing.T) {
	f := newFixture(t)
	const agentHealth = `{"status":"ok","state":"IDLE","openrouter_configured":true,"browser":{"identities":2,"open":1}}`
	f.startAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, agentHealth)
	}))
	h := getHealth(t, f)
	if string(h.Agent) != agentHealth {
		t.Errorf("agent %s", h.Agent)
	}
}

func TestHealthAgentErrorOrHangIsDown(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"500": func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, `{"error":"boom"}`, http.StatusInternalServerError)
		},
		"not json": func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "hello")
		},
		"hangs": func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
		},
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, func(o *Options) { o.CheckTimeout = 200 * time.Millisecond })
			f.startAgent(h)
			start := time.Now()
			got := getHealth(t, f)
			if elapsed := time.Since(start); elapsed > 3*time.Second {
				t.Errorf("health took %s", elapsed)
			}
			var agent map[string]any
			_ = json.Unmarshal(got.Agent, &agent)
			if agent["status"] != "down" {
				t.Errorf("agent %s, want down", got.Agent)
			}
		})
	}
}
