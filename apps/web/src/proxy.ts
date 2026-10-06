/**
 * Runs in front of every page request: puts the Content Security Policy, with a nonce of its own, on the request (so
 * Next marks the scripts it writes) and on the response. It does not run for the API proxy, the session route, the
 * built files or prefetches.
 */
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce } from "./lib/csp";

export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|session|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
