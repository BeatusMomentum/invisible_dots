/**
 * Signing out of this web server and the page to return to after signing in
 * (architecture section 9.7). The session is an HttpOnly cookie the page
 * cannot read, so ending it is a request: `DELETE /session` clears it.
 */
import { LOGIN_PATH, onLoginPage } from "./api";

/** The server could not clear the session; the person is still signed in. */
export class SignOutError extends Error {
  constructor(readonly status: number) {
    super(`sign-out failed (${status})`);
    this.name = "SignOutError";
  }
}

/**
 * Ends the session, then loads the login page from scratch so that nothing
 * of the signed-in page (open streams, cached answers) survives. Throws
 * `SignOutError` when the server refuses, and the page stays where it is.
 */
export async function signOut(
  assign: (url: string) => void,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<void> {
  const response = await fetchImpl("/session", { method: "DELETE" });
  if (!response.ok) throw new SignOutError(response.status);
  assign(LOGIN_PATH);
}

const HERE = "http://this-site.invalid";

/**
 * The page to go to once signed in, from the query string of the login page
 * (`?next=/dots/x`): a path of this site, never a URL somewhere else (the
 * browser's own parser decides what is "somewhere else", so `//host` and the
 * backslash forms are caught alike) and never the login page itself, which
 * would leave the person on it.
 */
export function pathAfterLogin(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (!next || !next.startsWith("/")) return "/";
  const target = new URL(next, HERE);
  if (target.origin !== HERE || onLoginPage(target.pathname)) return "/";
  return `${target.pathname}${target.search}${target.hash}`;
}
