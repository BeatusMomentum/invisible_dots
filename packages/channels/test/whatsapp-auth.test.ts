/**
 * The linked device's keys over the encrypted secrets, with the real Baileys helpers (`initAuthCreds`,
 * `BufferJSON`, the protobuf of the app-state keys) and a real test database: what is written, what is
 * encrypted, what a restart reads back, and what happens when a write fails or the session closes.
 */
import type { Database, SecretsRepository } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthStore, WHATSAPP_AUTH_SECRETS, WHATSAPP_CREDS_SECRET, type BaileysAuthLib } from "../src/whatsapp-baileys/auth-state.js";

describe.each(testAdapters())("the WhatsApp auth state over encrypted secrets (%s)", { timeout: 60_000 }, (kind) => {
  let t: TestDatabase;
  let db: Database;
  let lib: BaileysAuthLib;
  const DOT = "dot_auth_test";

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    lib = (await import("baileys")) as unknown as BaileysAuthLib;
  }, 60_000);

  afterEach(async () => {
    await db.query("DELETE FROM secrets WHERE scope = $1", [DOT]);
  });

  afterAll(async () => {
    await t?.drop();
  });

  const names = async () => (await db.query<{ name: string }>("SELECT name FROM secrets WHERE scope = $1 ORDER BY name", [DOT])).rows.map((r) => r.name);

  /** The repository, counting what is written and able to fail or slow a write. */
  function watched(options: { failOn?: string; delayMs?: (name: string) => number } = {}) {
    const writes: string[] = [];
    let failOn = options.failOn;
    const secrets = {
      get: (scope: string, name: string) => db.secrets.get(scope, name),
      delete: (scope: string, name: string) => db.secrets.delete(scope, name),
      put: async (scope: string, name: string, value: string) => {
        const wait = options.delayMs?.(name) ?? 0;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (name === failOn) throw new Error("the database refused the write");
        writes.push(name);
        await db.secrets.put(scope, name, value);
      },
    } as Pick<SecretsRepository, "get" | "put" | "delete">;
    return { secrets, writes, healed: () => (failOn = undefined) };
  }

  it("starts as a device that is not linked, with fresh credentials, when nothing is stored", async () => {
    const store = await AuthStore.open(DOT, watched().secrets, lib);
    expect(store.linked).toBe(false);
    expect(store.state.creds.registered).toBe(false);
    expect(store.state.creds.noiseKey.public).toBeInstanceOf(Uint8Array);
    expect(await names()).toEqual([]);
  });

  it("keeps the credentials and each group of keys in a secret of its own, written when they change and encrypted at rest", async () => {
    const w = watched();
    const store = await AuthStore.open(DOT, w.secrets, lib);
    await store.state.keys.set({ "pre-key": { "7": { public: Buffer.from("PUBLIC-PREKEY-BYTES"), private: Buffer.from("PRIVATE-PREKEY-BYTES") } } });
    expect(w.writes).toEqual(["whatsapp_keys_pre_key"]);
    await store.state.keys.set({ session: { "393331112222.0": Buffer.from("SESSION-STATE-SECRET") } });
    expect(w.writes).toEqual(["whatsapp_keys_pre_key", "whatsapp_keys_session"]);
    store.state.creds.me = { id: "15550001111:3@s.whatsapp.net", name: "Dot" };
    await store.saveCreds();
    expect(w.writes.at(-1)).toBe(WHATSAPP_CREDS_SECRET);
    expect(await names()).toEqual(["whatsapp_creds", "whatsapp_keys_pre_key", "whatsapp_keys_session"]);

    // What is in the table is ciphertext: neither the keys nor the account's number are readable there.
    const raw = (await db.query<{ value_enc: Uint8Array }>("SELECT value_enc FROM secrets WHERE scope = $1", [DOT])).rows.map((r) => Buffer.from(r.value_enc).toString("latin1")).join("\n");
    for (const plain of ["PUBLIC-PREKEY-BYTES", "PRIVATE-PREKEY-BYTES", "SESSION-STATE-SECRET", "15550001111", "noiseKey"]) expect(raw).not.toContain(plain);
    // ... and it is the keys again to the code that holds the master key.
    expect(await db.secrets.get(DOT, "whatsapp_keys_session")).toContain(Buffer.from("SESSION-STATE-SECRET").toString("base64"));
  });

  it("reads back, after a restart, the same credentials and keys, as the types Baileys uses", async () => {
    const first = await AuthStore.open(DOT, watched().secrets, lib);
    await first.state.keys.set({
      "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } },
      session: { alice: Buffer.from("session-alice"), bob: Buffer.from("session-bob") },
      "lid-mapping": { "393331112222": "99887766554433", "99887766554433_reverse": "393331112222" },
      "app-state-sync-key": { AAAA: lib.proto.Message.AppStateSyncKeyData.fromObject({ keyData: Buffer.from("sync-key-bytes"), timestamp: 42 }) },
    });
    first.state.creds.me = { id: "15550001111:3@s.whatsapp.net" };
    first.state.creds.registered = true;
    await first.saveCreds();
    await first.close();

    const second = await AuthStore.open(DOT, watched().secrets, lib);
    expect(second.linked).toBe(true);
    expect(second.state.creds.registered).toBe(true);
    expect(Buffer.from(second.state.creds.noiseKey.private).equals(Buffer.from(first.state.creds.noiseKey.private))).toBe(true);
    expect(Buffer.from(second.state.creds.signedIdentityKey.public).equals(Buffer.from(first.state.creds.signedIdentityKey.public))).toBe(true);

    const prekey = (await second.state.keys.get("pre-key", ["1", "missing"]))["1"]!;
    expect(Buffer.from(prekey.public)).toEqual(Buffer.from([1, 2, 3]));
    expect(Buffer.from(prekey.private)).toEqual(Buffer.from([4, 5, 6]));
    const sessions = await second.state.keys.get("session", ["alice", "bob", "carol"]);
    expect(Object.keys(sessions)).toEqual(["alice", "bob"]);
    expect(Buffer.from(sessions.alice!).toString()).toBe("session-alice");
    expect(await second.state.keys.get("lid-mapping", ["99887766554433_reverse"])).toEqual({ "99887766554433_reverse": "393331112222" });
    // The app-state key comes back as the protobuf message Baileys reads, not as the plain object it was stored as.
    const sync = (await second.state.keys.get("app-state-sync-key", ["AAAA"]))["AAAA"]!;
    expect(sync).toBeInstanceOf(lib.proto.Message.AppStateSyncKeyData);
    expect(Buffer.from(sync.keyData!).toString()).toBe("sync-key-bytes");
  });

  it("forgets a key that Baileys deletes, and writes only the groups that changed", async () => {
    const w = watched();
    const store = await AuthStore.open(DOT, w.secrets, lib);
    await store.state.keys.set({ session: { a: Buffer.from("a"), b: Buffer.from("b") }, "pre-key": { "1": { public: Buffer.from("x"), private: Buffer.from("y") } } });
    w.writes.length = 0;
    await store.state.keys.set({ session: { a: null } });
    expect(w.writes).toEqual(["whatsapp_keys_session"]);
    expect(Object.keys(await store.state.keys.get("session", ["a", "b"]))).toEqual(["b"]);
    await store.close();
    const reopened = await AuthStore.open(DOT, watched().secrets, lib);
    expect(Object.keys(await reopened.state.keys.get("session", ["a", "b"]))).toEqual(["b"]);
  });

  it("writes in the order the changes were made, one at a time, so the last change is the one that stays", async () => {
    const w = watched({ delayMs: (name) => (name === "whatsapp_keys_session" ? 20 : 0) });
    const store = await AuthStore.open(DOT, w.secrets, lib);
    await Promise.all([
      store.state.keys.set({ session: { a: Buffer.from("one") } }),
      store.state.keys.set({ session: { a: Buffer.from("two") } }),
      store.state.keys.set({ session: { a: Buffer.from("three") } }),
    ]);
    await store.close();
    const reopened = await AuthStore.open(DOT, watched().secrets, lib);
    expect(Buffer.from((await reopened.state.keys.get("session", ["a"]))["a"]!).toString()).toBe("three");
  });

  it("fails the change when the write fails, keeps it in memory, and writes it with the next change that succeeds", async () => {
    const w = watched({ failOn: "whatsapp_keys_session" });
    const store = await AuthStore.open(DOT, w.secrets, lib);
    await expect(store.state.keys.set({ session: { a: Buffer.from("kept") } })).rejects.toThrow(/refused the write/);
    expect(await names()).toEqual([]);
    expect(Buffer.from((await store.state.keys.get("session", ["a"]))["a"]!).toString()).toBe("kept");
    w.healed();
    await store.state.keys.set({ "sender-key-memory": { g: { x: true } } });
    await store.close();
    const reopened = await AuthStore.open(DOT, watched().secrets, lib);
    expect(Buffer.from((await reopened.state.keys.get("session", ["a"]))["a"]!).toString()).toBe("kept");
  });

  it("waits for its writes when it closes, and refuses every later one: what the hub deletes stays deleted", async () => {
    const w = watched({ delayMs: () => 30 });
    const store = await AuthStore.open(DOT, w.secrets, lib);
    const pending = store.state.keys.set({ session: { a: Buffer.from("late") } });
    await store.close();
    await pending;
    expect(await names()).toEqual(["whatsapp_keys_session"]);
    await expect(store.state.keys.set({ session: { b: Buffer.from("too late") } })).rejects.toThrow(/closed/);
    await expect(store.saveCreds()).rejects.toThrow(/closed/);
    await db.secrets.delete(DOT, "whatsapp_keys_session");
    expect(await names()).toEqual([]);
  });

  it("lists every secret it keeps, once each, and one per group of keys Baileys has", () => {
    expect(WHATSAPP_AUTH_SECRETS).toHaveLength(11);
    expect(new Set(WHATSAPP_AUTH_SECRETS).size).toBe(11);
    expect(WHATSAPP_AUTH_SECRETS.every((name) => name.startsWith("whatsapp_"))).toBe(true);
  });
});
