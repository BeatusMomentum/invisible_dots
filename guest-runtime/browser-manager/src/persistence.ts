import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

/**
 * Keeps identities as one JSON array in a file. Every write replaces the file
 * through a rename, so a crash mid-write leaves the previous list rather than
 * half of a new one. Writes are serialized within the process.
 */
export class JsonFileIdentityPersistence implements IdentityPersistence {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<BrowserIdentity[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${this.file}: expected a JSON array of browser identities`);
    return parsed as BrowserIdentity[];
  }

  private async save(records: BrowserIdentity[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  listIdentities(): Promise<BrowserIdentity[]> {
    return this.serialized(() => this.load());
  }

  getIdentity(id: string): Promise<BrowserIdentity | null> {
    return this.serialized(async () => (await this.load()).find((r) => r.id === id) ?? null);
  }

  putIdentity(record: BrowserIdentity): Promise<void> {
    return this.serialized(async () => {
      const records = (await this.load()).filter((r) => r.id !== record.id);
      records.push(copy(record));
      await this.save(records);
    });
  }

  deleteIdentity(id: string): Promise<void> {
    return this.serialized(async () => {
      const records = await this.load();
      const kept = records.filter((r) => r.id !== id);
      if (kept.length !== records.length) await this.save(kept);
    });
  }
}
