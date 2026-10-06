/**
 * Sign in and out of this web server (architecture section 9.7). POST takes
 * `{ token }`, the API token, and answers with the session cookie when it is
 * the right one; DELETE clears the cookie. The same Host and Origin checks as
 * the proxy run first. Each sign-in is a session of its own, kept here with the
 * time it ends; DELETE drops it (lib/proxy.ts).
 */
import {
  ProxyError,
  checkRequestOrigin,
  clearedSessionCookie,
  endSession,
  errorResponse,
  loadApiToken,
  sessionCookie,
  startSession,
  tokenMatches,
} from "../../lib/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function refused(request: Request): Response | null {
  const refusal = checkRequestOrigin({
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  return refusal ? errorResponse(403, "forbidden", refusal) : null;
}

export async function POST(request: Request): Promise<Response> {
  const refusal = refused(request);
  if (refusal) return refusal;
  let given: unknown;
  try {
    given = ((await request.json()) as { token?: unknown }).token;
  } catch {
    return errorResponse(400, "invalid_request", 'send {"token": "<the API token>"} as JSON');
  }
  if (typeof given !== "string" || given.trim() === "") return errorResponse(400, "invalid_request", "token must be a non-empty string");
  let token: string;
  try {
    token = await loadApiToken();
  } catch (error) {
    if (error instanceof ProxyError) return errorResponse(error.status, error.code, error.message);
    throw error;
  }
  if (!tokenMatches(given.trim(), token)) return errorResponse(401, "wrong_token", "that is not the API token of this control plane");
  return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(startSession(token)), "cache-control": "no-store" } });
}

export async function DELETE(request: Request): Promise<Response> {
  const refusal = refused(request);
  if (refusal) return refusal;
  // The session ends here, not only in this browser: a copy of its cookie is no longer worth anything.
  endSession(request.headers.get("cookie"));
  return new Response(null, { status: 204, headers: { "set-cookie": clearedSessionCookie(), "cache-control": "no-store" } });
}
