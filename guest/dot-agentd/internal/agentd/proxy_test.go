package agentd

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestProxyForwardsPathQueryBodyAndStatus(t *testing.T) {
	f := newFixture(t)
	type seen struct{ method, path, query, auth, body, ctype string }
	got := make(chan seen, 1)
	f.startAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got <- seen{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), string(b), r.Header.Get("Content-Type")}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"accepted":true}`)
	}))

	resp := f.do(http.MethodPost, "/v1/agent/events?trace=1&x=y%20z", strings.NewReader(`{"id":"evt_1"}`), "Content-Type", "application/json")
	wantStatus(t, resp, http.StatusAccepted)
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"accepted":true}` {
		t.Errorf("body %s", body)
	}
	s := <-got
	if s.method != http.MethodPost || s.path != "/events" || s.query != "trace=1&x=y%20z" {
		t.Errorf("agent saw %+v", s)
	}
	if s.body != `{"id":"evt_1"}` || s.ctype != "application/json" {
		t.Errorf("agent saw body %q type %q", s.body, s.ctype)
	}
	if s.auth != "" {
		t.Errorf("the Dot token leaked to the agent: %q", s.auth)
	}
}

func TestProxyKeepsEscapedPathSegments(t *testing.T) {
	f := newFixture(t)
	got := make(chan string, 1)
	f.startAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.URL.EscapedPath()
		w.WriteHeader(http.StatusNoContent)
	}))
	resp := f.do(http.MethodDelete, "/v1/agent/browser-identities/a%2Fb", nil)
	wantStatus(t, resp, http.StatusNoContent)
	if p := <-got; p != "/browser-identities/a%2Fb" {
		t.Errorf("agent saw %q", p)
	}
}

func TestProxyAgentDownIs502(t *testing.T) {
	f := newFixture(t)
	resp := f.do(http.MethodGet, "/v1/agent/state", nil)
	wantStatus(t, resp, http.StatusBadGateway)
	if body := decode[ErrorAnswer](t, resp); body.Error != "agent_unavailable" {
		t.Errorf("error code %q", body.Error)
	}
}

func TestProxyStreamsSSEIncrementally(t *testing.T) {
	f := newFixture(t)
	next := make(chan struct{})
	f.startAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/events/stream" || r.URL.Query().Get("after") != "41" {
			t.Errorf("agent saw %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		for seq := 42; seq <= 44; seq++ {
			fmt.Fprintf(w, "id: %d\ndata: {\"seq\":%d}\n\n", seq, seq)
			if err := rc.Flush(); err != nil {
				t.Errorf("flush: %v", err)
				return
			}
			// The next event is only written after the client has read this
			// one: a proxy that buffered would deadlock here.
			select {
			case <-next:
			case <-r.Context().Done():
				return
			case <-time.After(5 * time.Second):
				t.Errorf("client never acknowledged event %d", seq)
				return
			}
		}
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, f.baseURL+"/v1/agent/events/stream?after=41", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	wantStatus(t, resp, http.StatusOK)
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type %q", ct)
	}

	rd := bufio.NewReader(resp.Body)
	for seq := 42; seq <= 44; seq++ {
		var lines []string
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				t.Fatalf("event %d: %v (got %q)", seq, err, lines)
			}
			if line == "\n" {
				break
			}
			lines = append(lines, strings.TrimRight(line, "\n"))
		}
		want := []string{fmt.Sprintf("id: %d", seq), fmt.Sprintf("data: {\"seq\":%d}", seq)}
		if strings.Join(lines, "|") != strings.Join(want, "|") {
			t.Fatalf("event %d: got %q", seq, lines)
		}
		next <- struct{}{}
	}
}

func TestProxyStreamOutlivesHealthTimeouts(t *testing.T) {
	// The agent proxy must not inherit the short bound of the health check.
	f := newFixture(t, func(o *Options) { o.CheckTimeout = 50 * time.Millisecond })
	f.startAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = io.WriteString(w, "late")
	}))
	resp := f.do(http.MethodPost, "/v1/agent/prepare-sleep", nil)
	wantStatus(t, resp, http.StatusOK)
	if b, _ := io.ReadAll(resp.Body); string(b) != "late" {
		t.Errorf("body %q", b)
	}
}
