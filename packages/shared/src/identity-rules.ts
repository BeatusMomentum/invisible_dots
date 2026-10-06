/**
 * The rules a browser identity request must meet (architecture section 6),
 * in one place: the guest's browser manager enforces them, and the host's
 * test guest runs the same function, so a test that creates identities
 * through the fakes meets the limits and messages the real agent has.
 */

/** Longest identity name. */
export const IDENTITY_NAME_MAX = 80;

/** A request the rules refuse: `invalid` (a bad name or a proxy that is not a string) or `limit` (max_identities reached). */
export class IdentityRequestError extends Error {
  constructor(
    readonly code: "invalid" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "IdentityRequestError";
  }
}

/**
 * Check a create request against the rules and the identities that exist:
 * a non-empty name of at most IDENTITY_NAME_MAX characters, an optional proxy
 * that is a string, and fewer than `maxIdentities` existing identities.
 * Returns the trimmed name.
 *
 * A proxy is an explicit option of one identity, never a requirement: a request
 * with no proxy, a null one or a blank one is the normal case, and the browser
 * then uses the egress of the Dot's computer. One that is given is kept as it was
 * written: invisible-playwright-mcp reads it when the identity launches and says
 * what is wrong with it.
 */
export function checkIdentityRequest(
  input: { name: unknown; proxy?: unknown },
  existingCount: number,
  maxIdentities: number,
): { name: string; proxy?: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new IdentityRequestError("invalid", "an identity needs a non-empty name");
  if (name.length > IDENTITY_NAME_MAX) throw new IdentityRequestError("invalid", `an identity name is at most ${IDENTITY_NAME_MAX} characters`);
  if (input.proxy != null && typeof input.proxy !== "string") throw new IdentityRequestError("invalid", "proxy must be a string");
  const proxy = typeof input.proxy === "string" && input.proxy.trim() ? input.proxy : undefined;
  if (existingCount >= maxIdentities) {
    throw new IdentityRequestError(
      "limit",
      `this Dot already has ${existingCount} browser identities, the most its configuration allows (max_identities ${maxIdentities}); delete one first`,
    );
  }
  return proxy ? { name, proxy } : { name };
}
