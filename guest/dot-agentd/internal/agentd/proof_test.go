package agentd

import (
	"net/http"
	"testing"
)

// The same known answer is checked on the host side
// (apps/vm-manager/test/guest-client.test.ts), so the two implementations
// of the proof cannot drift apart.
const (
	knownProofToken  = "dot-token-123"
	knownProofNonce  = "00112233445566778899aabbccddeeff"
	knownProofAnswer = "b1cb86aa470fe878a6366f62ea4493011c01d22736a9c89d3e7f88582920d1b9"
)

func TestProofKnownAnswer(t *testing.T) {
	if got := Proof(knownProofToken, knownProofNonce); got != knownProofAnswer {
		t.Fatalf("Proof = %s, want %s", got, knownProofAnswer)
	}
}

func TestProofNeedsNoTokenAndProvesTheToken(t *testing.T) {
	f := newFixture(t)
	resp, err := f.client.Get(f.baseURL + "/v1/proof?nonce=" + knownProofNonce)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	wantStatus(t, resp, http.StatusOK)
	if body := decode[map[string]string](t, resp); body["proof"] != Proof(testToken, knownProofNonce) {
		t.Errorf("proof = %q", body["proof"])
	}
}

func TestProofRefusesABadNonceAndAnEmptyToken(t *testing.T) {
	f := newFixture(t)
	for _, nonce := range []string{"", "short", "00112233445566778899AABBCCDDEEFF", "zz112233445566778899aabbccddeeff"} {
		resp, err := f.client.Get(f.baseURL + "/v1/proof?nonce=" + nonce)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("nonce %q: status %d, want 400", nonce, resp.StatusCode)
		}
	}
	empty := newFixture(t, func(o *Options) { o.Token = "" })
	resp, err := empty.client.Get(empty.baseURL + "/v1/proof?nonce=" + knownProofNonce)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("empty token: status %d, want 401", resp.StatusCode)
	}
}
