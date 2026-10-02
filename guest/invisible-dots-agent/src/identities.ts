/**
 * The browser identities as the agent's HTTP routes see them. The real
 * implementation is browser-manager's BrowserIdentityManager; the tests pass a
 * fake.
 */
import type { CreateIdentityInput } from "@invisible-dots/browser-manager";
import type { BrowserIdentity } from "@invisible-dots/shared";

export interface IdentityLimits {
  maxOpen: number;
  maxIdentities: number;
}

export interface IdentityService {
  readonly openCount: number;
  list(): Promise<BrowserIdentity[]>;
  get(id: string): Promise<BrowserIdentity | null>;
  create(input: CreateIdentityInput): Promise<BrowserIdentity>;
  delete(id: string): Promise<void>;
  closeAll(): Promise<void>;
}
