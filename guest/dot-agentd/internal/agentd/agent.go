package agentd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// agentClient talks HTTP to invisible-dots-agent over its unix socket.
type agentClient struct {
	socket    string
	transport *http.Transport
}

func newAgentClient(socket string) *agentClient {
	dialer := &net.Dialer{}
	return &agentClient{
		socket: socket,
		// No response or idle timeouts here: the proxy carries the event
		// stream, which stays open for as long as the host listens. Callers
		// that want a bound put it on the request context.
		transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", socket)
			},
			MaxIdleConns:       8,
			DisableCompression: true,
		},
	}
}

// health fetches the agent's GET /health. Anything but a 2xx JSON object is an
// error, so a crashing agent that answers 500 is reported as down.
func (a *agentClient) health(ctx context.Context) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://agent/health", nil)
	if err != nil {
		return nil, err
	}
	resp, err := (&http.Client{Transport: a.transport}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("agent /health answered %d", resp.StatusCode)
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return nil, fmt.Errorf("agent /health is not a JSON object: %w", err)
	}
	return json.RawMessage(body), nil
}

// newAgentProxy forwards /v1/agent/<rest> to /<rest> on the agent socket.
// FlushInterval -1 flushes after every write, which is what keeps the SSE
// event stream incremental instead of arriving in buffered lumps.
func (s *Server) newAgentProxy() http.Handler {
	target := &url.URL{Scheme: "http", Host: "agent"}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			rest := strings.TrimPrefix(pr.In.URL.Path, agentProxyPrefix)
			if rest == "" {
				rest = "/"
			}
			pr.Out.URL.Path = rest
			pr.Out.URL.RawPath = ""
			if raw := pr.In.URL.RawPath; raw != "" {
				pr.Out.URL.RawPath = strings.TrimPrefix(raw, agentProxyPrefix)
			}
			pr.Out.URL.RawQuery = pr.In.URL.RawQuery
			// The Dot's token authorizes the host to this VM; the agent never
			// needs it and should never be able to log it.
			pr.Out.Header.Del("Authorization")
			pr.Out.Host = "agent"
		},
		Transport:     s.agent.transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() != nil {
				// The caller went away (a stream the host closed); nothing to answer.
				return
			}
			s.log.Warn("agent proxy", "path", r.URL.Path, "error", err)
			writeError(w, http.StatusBadGateway, "agent_unavailable",
				"the agent at "+s.agent.socket+" did not answer: "+err.Error())
		},
	}
}
