package agentd

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// HealthAnswer is GET /v1/health. Agent is the agent's own /health answer,
// passed through untouched, or {"status":"down","error":...}. The guest's
// readiness checks (architecture section 9.3) are part of the agent's answer:
// the agent is the process that writes the state, calls OpenRouter and starts
// the browser layer, so it is the one that can tell whether those work.
type HealthAnswer struct {
	Agentd  string          `json:"agentd"`
	Agent   json.RawMessage `json:"agent"`
	UptimeS int64           `json:"uptime_s"`
}

type agentDown struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.opts.CheckTimeout)
	defer cancel()

	agent, err := s.agent.health(ctx)
	if err != nil {
		s.log.Debug("agent health", "error", err)
		agent, _ = json.Marshal(agentDown{Status: "down", Error: err.Error()})
	}
	writeJSON(w, http.StatusOK, HealthAnswer{
		Agentd:  "ok",
		Agent:   agent,
		UptimeS: int64(time.Since(s.started).Seconds()),
	})
}
