import type { BrowserIdentity } from "@invisible-dots/shared";

type MaybePromise<T> = T | Promise<T>;

/**
 * Where the list of identities lives. In the guest this is `dot.db` (the
 * memory package's DotStore implements it); `metadata.json` in each identity
 * directory is a mirror the manager keeps in sync, never the source of truth.
 * Methods may be synchronous because node:sqlite is.
 */
export interface IdentityPersistence {
  listIdentities(): MaybePromise<BrowserIdentity[]>;
  getIdentity(id: string): MaybePromise<BrowserIdentity | null | undefined>;
  putIdentity(record: BrowserIdentity): MaybePromise<void>;
  deleteIdentity(id: string): MaybePromise<void>;
}

function copy(record: BrowserIdentity): BrowserIdentity {
  return { ...record };
}

/** Keeps identities in process memory only. For tests and for callers that persist elsewhere. */
export class MemoryIdentityPersistence implements IdentityPersistence {
  private readonly records = new Map<string, BrowserIdentity>();

  listIdentities(): BrowserIdentity[] {
    return [...this.records.values()].map(copy);
  }

  getIdentity(id: string): BrowserIdentity | null {
    const record = this.records.get(id);
    return record ? copy(record) : null;
  }

  putIdentity(record: BrowserIdentity): void {
    this.records.set(record.id, copy(record));
  }

  deleteIdentity(id: string): void {
    this.records.delete(id);
  }
}
