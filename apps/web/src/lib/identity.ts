/** How a browser identity is said to the person: its state in words and a tone, and what its limits allow. */
import { checkIdentityRequest, IdentityRequestError } from "@invisible-dots/shared/browser";
import type { BrowserIdentity, DotConfig } from "./types";
import type { Tone } from "./tone";

export interface IdentityStatus {
  label: string;
  tone: Tone;
}

/** The engine's `available` is a browser that is not running (its profile is kept); `open` is one that is. */
export function identityStatus(status: BrowserIdentity["status"]): IdentityStatus {
  switch (status) {
    case "open":
      return { label: "Open", tone: "ok" };
    case "available":
      return { label: "Closed", tone: "neutral" };
    case "archived":
      return { label: "Archived", tone: "neutral" };
  }
}

export interface IdentityLimits {
  /** The Dot may make and delete identities with its own tools; the person always may. */
  managedByDot: boolean;
  maxIdentities: number;
  maxOpen: number;
}

/** The limits of the Dot's config, which the engine's browser manager enforces for every caller. */
export function identityLimits(config: DotConfig | null | undefined): IdentityLimits {
  const identities = config?.browser?.identities;
  return { managedByDot: identities?.managed_by_dot ?? true, maxIdentities: identities?.max_identities ?? 20, maxOpen: identities?.max_open ?? 3 };
}

/** Open ones first, then the rest by name, so what the Dot is using is at the top. */
export function identityOrder(identities: readonly BrowserIdentity[]): BrowserIdentity[] {
  const rank = (identity: BrowserIdentity) => (identity.status === "open" ? 0 : 1);
  return [...identities].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

export type NewIdentity = { ok: true; request: { name: string; proxy?: string } } | { ok: false; problem: string };

/**
 * What the form sends for the name and proxy typed, or what is wrong with them. The rules are the engine's own
 * (`checkIdentityRequest`, which the control plane's guest enforces again), so the form never accepts what the
 * engine would refuse or refuses what it would take; `existing` is how many identities the Dot has now.
 */
export function newIdentity(name: string, proxy: string, existing: number, limits: IdentityLimits): NewIdentity {
  try {
    return { ok: true, request: checkIdentityRequest({ name, proxy }, existing, limits.maxIdentities) };
  } catch (error) {
    if (error instanceof IdentityRequestError) return { ok: false, problem: error.message };
    throw error;
  }
}
