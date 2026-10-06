"use client";

import { AlertCircleIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { pathAfterLogin } from "../../lib/session";
import { Field } from "../new-dot/Field";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Sign in to this web server with the API token (architecture section 9.7). The token is sent once to /session,
 * which answers with an HttpOnly cookie; the page never stores it, and asks the control plane nothing, because
 * there is no session yet to ask with.
 */
export function LoginForm({ assign = (url: string) => window.location.assign(url) }: { assign?: (url: string) => void }) {
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
        assign(pathAfterLogin(window.location.search));
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
    <section aria-labelledby="login-heading" className="w-full max-w-md space-y-6 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
      <div className="space-y-3">
        <span aria-hidden="true" className="flex items-center gap-1">
          <span className="size-3 rounded-full bg-primary" />
          <span className="size-3 rounded-full bg-primary/60" />
          <span className="size-3 rounded-full bg-primary/30" />
        </span>
        <div className="space-y-1">
          <h1 id="login-heading" className="text-2xl font-semibold tracking-tight">
            Sign in
          </h1>
          <p className="text-sm text-muted-foreground">to invisible_dots, the control plane of your Dots.</p>
        </div>
      </div>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <Field
          id="api-token"
          label="API token"
          hint={
            <>
              The first line of <code className="rounded bg-muted px-1 py-0.5 font-mono">config/api.token</code> in INVISIBLE_DOTS_HOME, which the server created at its first start.
            </>
          }
        >
          {(control) => <Input {...control} type="password" autoComplete="current-password" autoFocus value={token} onChange={(event) => setToken(event.target.value)} />}
        </Field>
        {error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Could not sign in</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button type="submit" className="w-full" disabled={pending || token.trim() === ""}>
          {pending ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </section>
  );
}
