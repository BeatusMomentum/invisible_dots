/**
 * Server-side helpers of the API proxy. This web server answers `/api/...`
 * with the control plane's own paths, so the browser uses the SDK unchanged,
 * and it adds the bearer token, so the browser never sees it.
 */
import { readFile } from "node:fs/promises";
import { DEFAULT_LISTEN, ENV, hostPaths } from "@invisible-dots/shared/browser";

export const WEB_ENV = {
  /** Base URL of the control plane API. */
  url: ENV.URL,
  /** The API token itself; when unset, the `api.token` file is read. */
  token: ENV.TOKEN,
  /** Extra host names (comma separated) this web server may be reached by, besides loopback. */
  allowedHosts: "INVISIBLE_DOTS_WEB_ALLOWED_HOSTS",
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
 * The API token: `INVISIBLE_DOTS_TOKEN` when set, otherwise the contents of
 * `<INVISIBLE_DOTS_CONFIG_DIR>/api.token`. Read on every request so a rotated
 * token file takes effect without a restart.
 */
export async function loadApiToken(
  env: Env = process.env,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string> {
  const fromEnv = env[WEB_ENV.token]?.trim();
  if (fromEnv) return fromEnv;
  const file = hostPaths(env).apiToken;
  let text: string;
  try {
    text = await read(file);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    throw new ProxyError(
      500,
      "web_token_missing",
      `the web server has no API token: set ${WEB_ENV.token} or make ${file} readable (${reason})`,
    );
  }
  const token = text.trim();
  if (!token) {
    throw new ProxyError(500, "web_token_missing", `the API token file ${file} is empty`);
  }
  return token;
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
 * Whoever can talk to this server acts with the API token, so requests from
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
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "content-disposition", "retry-after"];

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
