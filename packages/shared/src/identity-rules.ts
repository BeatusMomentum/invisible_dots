/**
 * The rules a browser identity request must meet (architecture section 6),
 * in one place: the guest's browser manager enforces them, and the host's
 * test guest runs the same function, so a test that creates identities
 * through the fakes meets the limits and messages the real agent has.
 */

/** Longest identity name. */
export const IDENTITY_NAME_MAX = 80;

const PROXY_SCHEMES = new Set(["http:", "https:", "socks4:", "socks5:"]);

/** A request the rules refuse: `invalid` (bad name or proxy) or `limit` (max_identities reached). */
export class IdentityRequestError extends Error {
  constructor(
    readonly code: "invalid" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "IdentityRequestError";
  }
}

/** `http://user:secret@host` with the password replaced, for logs and for anything shown to a model or a person. */
export function redactProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.password) url.password = "***";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "<unparseable proxy>";
  }
}

/**
 * Whether a proxy URL names a port as written. `URL.port` is "" for a scheme's own default (`http://host:80`), so it
 * cannot tell that from none: the end of the host part is read instead. The URL parser drops tabs and line breaks
 * first, and so does this.
 */
function namesAPort(proxy: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:[/\\]*([^/\\?#]*)/i.exec(proxy.replace(/[\t\n\r]/g, ""))?.[1] ?? "";
  return /:\d+$/.test(authority.slice(authority.lastIndexOf("@") + 1));
}

/**
 * Check a create request against the rules and the identities that exist:
 * a non-empty name of at most IDENTITY_NAME_MAX characters, an optional proxy
 * URL with an http, https, socks4 or socks5 scheme, a host and a port (the
 * browser's server refuses one without, with a message that prints the
 * password), and fewer
 * than `maxIdentities` existing identities. Returns the trimmed values.
 */
export function checkIdentityRequest(
  input: { name: unknown; proxy?: unknown },
  existingCount: number,
  maxIdentities: number,
): { name: string; proxy?: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new IdentityRequestError("invalid", "an identity needs a non-empty name");
  if (name.length > IDENTITY_NAME_MAX) throw new IdentityRequestError("invalid", `an identity name is at most ${IDENTITY_NAME_MAX} characters`);
  if (input.proxy !== undefined && typeof input.proxy !== "string") throw new IdentityRequestError("invalid", "proxy must be a string");
  const proxy = (input.proxy as string | undefined)?.trim() || undefined;
  if (proxy) {
    let url: URL;
    try {
      url = new URL(proxy);
    } catch {
      throw new IdentityRequestError("invalid", "proxy must be a URL such as http://user:pass@host:port or socks5://host:port");
    }
    if (!PROXY_SCHEMES.has(url.protocol) || !url.hostname) {
      throw new IdentityRequestError("invalid", `proxy must use http, https, socks4 or socks5 and name a host; got "${redactProxy(proxy)}"`);
    }
    if (!namesAPort(proxy)) {
      throw new IdentityRequestError("invalid", `proxy must name a port, as in http://host:8080; got "${redactProxy(proxy)}"`);
    }
  }
  if (existingCount >= maxIdentities) {
    throw new IdentityRequestError(
      "limit",
      `this Dot already has ${existingCount} browser identities, the most its configuration allows (max_identities ${maxIdentities}); delete one first`,
    );
  }
  return proxy ? { name, proxy } : { name };
}
