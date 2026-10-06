/**
 * Server-side helpers of the API proxy. This web server answers `/api/...`
 * with the control plane's own paths, so the browser uses the SDK unchanged,
 * and it adds the bearer token, so the browser never sees it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiTokenError, readApiToken } from "@invisible-dots/shared/api-token";
import { DEFAULT_LISTEN, ENV } from "@invisible-dots/shared/browser";
import { hostPaths } from "@invisible-dots/shared/paths";

export const WEB_ENV = {
  /** Base URL of the control plane API. */
  url: ENV.URL,
  /** The API token itself; when unset, the `api.token` file is read. */
  token: ENV.TOKEN,
  /** Extra host names (comma separated) this web server may be reached by, besides loopback. */
  allowedHosts: ENV.WEB_ALLOWED_HOSTS,
} as const;

type Env = Record<string, string | undefined>;

export function apiBaseUrl(env: Env = process.env): string {
  const raw = env[WEB_ENV.url]?.trim() || `http://${DEFAULT_LISTEN}`;
  return raw.replace(/\/+$/, "");
}

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

/**
 * The API token as the server reads it (shared readApiToken):
 * `INVISIBLE_DOTS_TOKEN` when set, otherwise the first line of
 * `<INVISIBLE_DOTS_HOME>/config/api.token`, the file the server creates.
 * Read on every request so a rotated token file takes effect without a
 * restart.
 */
export async function loadApiToken(env: Env = process.env): Promise<string> {
  let token;
  try {
    token = await readApiToken(env);
  } catch (error) {
    if (error instanceof ApiTokenError) throw new ProxyError(500, "web_token_missing", `the web server has no usable API token: ${error.message}`);
    throw error;
  }
  if (!token) {
    const file = hostPaths(env).apiTokenPath;
    throw new ProxyError(500, "web_token_missing", `the web server has no API token: start the server once (it creates ${file}) or set ${WEB_ENV.token}`);
  }
  return token.value;
}

/**
 * The web server's own credential (architecture section 9.7). It holds the
 * API token and listens on the host's loopback, which every guest reaches as
 * 10.0.2.2 (section 3.6), so Host and Origin, which any client writes
 * itself, cannot be what lets a request through. The person signs in at
 * /login with the API token; each sign-in is a session of its own: a random
 * id, which is all the cookie holds (never the token, and nothing derived from
 * it that two sign-ins share), kept by this server with the time it ends. A
 * session ends after SESSION_TTL_S, when the person signs out (DELETE
 * /session drops it here, not only in the browser: a copy of the cookie, which a
 * server on another port of the same host can read, is worth nothing then), when
 * the API token changes, and when this server restarts.
 */
export const SESSION_COOKIE = "idots_session";

/** How long a sign-in lasts: a week. */
export const SESSION_TTL_S = 7 * 24 * 60 * 60;

/** Answered with 401 to a request without a valid session, so the page knows to show /login. */
export const LOGIN_REQUIRED = "login_required";
export const LOGIN_HEADER = "x-invisible-dots-login";

/** What ties a session to the token it was made with: it is not the token, and it is another value for another token. */
function tokenFingerprint(token: string): string {
  return createHmac("sha256", token).update("invisible-dots web session v1").digest("hex");
}

interface Session {
  fingerprint: string;
  /** Milliseconds since the epoch. */
  endsAt: number;
}

/**
 * The sessions, in the process's global: the sign-in route and the proxy are separate bundles of the Next build, each
 * with its own copy of this module, and they must see the same ones.
 */
const STORE = Symbol.for("invisible-dots.web.sessions");
function sessions(): Map<string, Session> {
  const holder = globalThis as unknown as { [STORE]?: Map<string, Session> };
  return (holder[STORE] ??= new Map());
}

/** Begin a session for a person who gave `token`; the value to put in the cookie. Sessions that have ended are forgotten here. */
export function startSession(token: string, now = Date.now()): string {
  const all = sessions();
  for (const [id, session] of all) if (session.endsAt <= now) all.delete(id);
  const id = randomBytes(32).toString("base64url");
  all.set(id, { fingerprint: tokenFingerprint(token), endsAt: now + SESSION_TTL_S * 1000 });
  return id;
}

/** End the session the request's cookie names, if it names one. */
export function endSession(cookieHeader: string | null): void {
  const id = cookieValue(cookieHeader, SESSION_COOKIE);
  if (id !== undefined) sessions().delete(id);
}

function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** Whether the request's cookie names a session that has not ended and was made with the current `token`. */
export function hasSession(cookieHeader: string | null, token: string, now = Date.now()): boolean {
  const id = cookieValue(cookieHeader, SESSION_COOKIE);
  if (id === undefined || id === "") return false;
  const session = sessions().get(id);
  if (session === undefined) return false;
  if (session.endsAt <= now) {
    sessions().delete(id);
    return false;
  }
  const given = Buffer.from(session.fingerprint, "utf8");
  const expected = Buffer.from(tokenFingerprint(token), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Whether a token typed at /login is the API token (constant-time). */
export function tokenMatches(given: string, token: string): boolean {
  const a = Buffer.from(tokenFingerprint(given), "utf8");
  const b = Buffer.from(tokenFingerprint(token), "utf8");
  return timingSafeEqual(a, b);
}

/** HttpOnly: no script reads it. SameSite=Strict: no other site's page makes the browser send it. It ends with the session. */
export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_S}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function loginRequired(): Response {
  return Response.json(
    { error: LOGIN_REQUIRED, message: "sign in at /login with the API token first" },
    { status: 401, headers: { "cache-control": "no-store", [LOGIN_HEADER]: "required" } },
  );
}

/**
 * Map the catch-all segments of `/api/<segments>` to the upstream
 * `/api/<segments>` URL. Segments arrive decoded, so each one is re-encoded;
 * dot segments are refused because URL parsing would resolve them and let a
 * request walk out of `/api/`.
 */
export function upstreamUrl(base: string, segments: readonly string[], search: string): string {
  if (segments.length === 0) {
    throw new ProxyError(404, "not_found", "no API path given");
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ProxyError(400, "bad_path", `invalid path segment "${segment}"`);
    }
  }
  const path = segments.map((s) => encodeURIComponent(s)).join("/");
  return `${base}/api/${path}${search}`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

export interface OriginCheckInput {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
}

/**
 * A defence against DNS rebinding and cross-site pages, in front of the
 * session check (which is what authenticates a request); requests from
 * other sites are refused:
 * - the Host header must be loopback or listed in INVISIBLE_DOTS_WEB_ALLOWED_HOSTS
 *   (a DNS rebinding page reaches 127.0.0.1 under its own host name),
 * - a browser that says the request is cross-site is refused,
 * - a state-changing request whose Origin is not this host is refused.
 * Returns null when the request may pass, or the reason it may not.
 */
export function checkRequestOrigin(input: OriginCheckInput, env: Env = process.env): string | null {
  if (!input.host) return "missing Host header";
  const hostname = hostnameOf(input.host);
  const extra = (env[WEB_ENV.allowedHosts] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!LOOPBACK_HOSTS.has(hostname) && !extra.includes(hostname)) {
    return `host "${hostname}" is not allowed; add it to ${WEB_ENV.allowedHosts}`;
  }
  if (input.secFetchSite === "cross-site") return "cross-site request refused";
  const safe = input.method === "GET" || input.method === "HEAD";
  if (!safe && input.origin) {
    let originHost: string;
    try {
      originHost = new URL(input.origin).host.toLowerCase();
    } catch {
      return "invalid Origin header";
    }
    if (originHost !== input.host.trim().toLowerCase()) {
      return `origin ${input.origin} does not match host ${input.host}`;
    }
  }
  return null;
}

/** Request headers passed on to the API. Cookies and any Authorization from the browser are dropped. */
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "last-event-id"];

/** Response headers passed back to the browser. Length and encoding are dropped: fetch already decoded the body. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "content-disposition",
  "retry-after",
  // A Dot's file is served under these (apps/api/src/file-types.ts); dropped here, the browser would sniff it and run it.
  "x-content-type-options",
  "content-security-policy",
];

export function forwardRequestHeaders(incoming: Headers, token: string): Headers {
  const out = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) out.set(name, value);
  }
  out.set("authorization", `Bearer ${token}`);
  return out;
}

export function forwardResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out.set(name, value);
  }
  if (!out.has("cache-control")) out.set("cache-control", "no-store");
  if ((out.get("content-type") ?? "").startsWith("text/event-stream")) {
    // no-transform keeps the response compressor from buffering the stream.
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }
  return out;
}

export function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status, headers: { "cache-control": "no-store" } });
}
