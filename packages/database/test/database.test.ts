import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  databaseTarget,
  describeDatabaseTarget,
  loadMigrations,
  parseInt8,
  PostgresDb,
  redactDatabaseUrl,
  SecretBox,
} from "../src/index.js";
import { testAdapters } from "../src/testing.js";

describe("SecretBox", () => {
  it("round-trips and binds a value to its associated data", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.encrypt("sk-or-test", "secret:global:openrouter_api_key");
    expect(sealed.includes(Buffer.from("sk-or-test"))).toBe(false);
    expect(box.decrypt(sealed, "secret:global:openrouter_api_key")).toBe("sk-or-test");
    expect(() => box.decrypt(sealed, "secret:dot_x:openrouter_api_key")).toThrow(/cannot decrypt/);
  });

  it("refuses a key of the wrong size and a different key", () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow(/32 bytes/);
    const sealed = new SecretBox(randomBytes(32)).encrypt("v", "a");
    expect(() => new SecretBox(randomBytes(32)).decrypt(sealed, "a")).toThrow(/wrong master key/);
  });

  it("decrypts from a plain Uint8Array, the bytea type PGlite returns", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.encrypt("value", "aad");
    expect(box.decrypt(new Uint8Array(sealed), "aad")).toBe("value");
  });
});

describe("loadMigrations", () => {
  it("finds the shipped migrations in order", async () => {
    const files = await loadMigrations();
    expect(files[0]?.version).toBe("0001_initial");
    expect(files[0]?.sql).toContain("CREATE TABLE dots");
    expect(files[0]?.sql).toContain("guest_port");
  });
});

describe("databaseTarget", () => {
  it("uses PGlite in INVISIBLE_DOTS_HOME/db unless DATABASE_URL is set", () => {
    const home = resolve("some-home");
    expect(databaseTarget({ INVISIBLE_DOTS_HOME: home })).toEqual({ kind: "pglite", dataDir: join(home, "db") });
    expect(databaseTarget({ INVISIBLE_DOTS_HOME: home, DATABASE_URL: "   " })).toEqual({
      kind: "pglite",
      dataDir: join(home, "db"),
    });
    expect(databaseTarget({ INVISIBLE_DOTS_HOME: home, DATABASE_URL: " postgres://u@h/db " })).toEqual({
      kind: "pg",
      url: "postgres://u@h/db",
    });
  });

  it("describes a target without its password", () => {
    expect(describeDatabaseTarget({ kind: "pg", url: "postgres://user:hunter2@db.local:5432/x" })).toBe(
      "PostgreSQL at postgres://user:***@db.local:5432/x",
    );
    expect(describeDatabaseTarget({ kind: "pglite", dataDir: "/data/db" })).toContain("PGlite");
    expect(redactDatabaseUrl("not a url")).toBe("<unparseable DATABASE_URL>");
  });
});

describe("parseInt8", () => {
  it("returns exact numbers and refuses what a number cannot hold exactly", () => {
    expect(parseInt8("0")).toBe(0);
    expect(parseInt8("-42")).toBe(-42);
    expect(parseInt8("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseInt8("9007199254740993")).toThrow(RangeError);
  });
});

describe("testAdapters", () => {
  it("always includes PGlite and adds pg only with DATABASE_URL", () => {
    expect(testAdapters({})).toEqual(["pglite"]);
    expect(testAdapters({ DATABASE_URL: "" })).toEqual(["pglite"]);
    expect(testAdapters({ DATABASE_URL: "postgres://x" })).toEqual(["pglite", "pg"]);
  });
});

describe("PostgresDb.open", () => {
  it("fails with a message that names the server but not its password", async () => {
    // Port 1 on loopback: nothing listens there, so the connection is refused at once.
    const error = await PostgresDb.open("postgres://user:hunter2@127.0.0.1:1/x").then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/^cannot connect to PostgreSQL at postgres:\/\/user:\*\*\*@127\.0\.0\.1:1\/x: /);
    expect(error?.message).not.toContain("hunter2");
  });
});
