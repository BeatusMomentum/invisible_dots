"use client";

import { useState, type FormEvent } from "react";
import { pathAfterLogin } from "../../lib/session";

/**
 * Sign in to this web server with the API token (architecture section 9.7).
 * The token is sent once to /session, which answers with an HttpOnly
 * cookie; the page never stores it.
 */
export default function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        window.location.assign(pathAfterLogin(window.location.search));
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? `sign-in failed (${response.status})`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card" aria-labelledby="login-heading">
      <h1 id="login-heading">Sign in</h1>
      <form onSubmit={submit}>
        <label htmlFor="api-token">API token</label>
        <p className="hint" id="api-token-hint">
          The first line of config/api.token in INVISIBLE_DOTS_HOME, which the server created at its first start.
        </p>
        <input
          id="api-token"
          type="password"
          autoComplete="current-password"
          value={token}
          aria-describedby="api-token-hint"
          onChange={(e) => setToken(e.target.value)}
        />
        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : null}
        <div className="actions">
          <button type="submit" disabled={pending || token.trim() === ""}>
            {pending ? "Signing in..." : "Sign in"}
          </button>
        </div>
      </form>
    </section>
  );
}
