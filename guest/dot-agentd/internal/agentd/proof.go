package agentd

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"regexp"
)

// proofContext is what GET /v1/proof signs before the nonce. The host's
// GUEST_PROOF_CONTEXT (packages/shared/src/protocol.ts) holds the same bytes;
// a test on each side checks the same known answer.
const proofContext = "invisible-dots guest proof v1\n"

// nonces are lowercase hex, 16 to 64 bytes: enough to never repeat, short
// enough that the route cannot be used to make the daemon hash much.
var proofNonce = regexp.MustCompile(`^[0-9a-f]{32,128}$`)

// Proof is the answer of GET /v1/proof for a token and a nonce.
func Proof(token, nonce string) string {
	mac := hmac.New(sha256.New, []byte(token))
	mac.Write([]byte(proofContext + nonce))
	return hex.EncodeToString(mac.Sum(nil))
}

// handleProof serves GET /v1/proof?nonce=<hex>, the one route without the
// token (architecture section 5.1). The host asks it before it sends the
// token to a port: a process that took over a stale guest port after a host
// restart or a QEMU that died cannot answer it, so it never sees the token.
// The answer is an HMAC under the token, which tells nothing about the
// token to whoever asks.
func (s *Server) handleProof(w http.ResponseWriter, r *http.Request) {
	if s.opts.Token == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "this daemon has no token to prove")
		return
	}
	nonce := r.URL.Query().Get("nonce")
	if !proofNonce.MatchString(nonce) {
		writeError(w, http.StatusBadRequest, "invalid_nonce", "nonce must be 32 to 128 lowercase hexadecimal characters")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"proof": Proof(s.opts.Token, nonce)})
}
