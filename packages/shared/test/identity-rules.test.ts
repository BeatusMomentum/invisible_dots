import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IDENTITY_NAME_MAX,
  IdentityRequestError,
  checkIdentityRequest,
  isValidIdentityId,
  newIdentityId,
  redactProxy,
  slugify,
} from "../src/index.js";

/**
 * The cases are shared with the engine (invisible_engine_dots/tests/dots/
 * test_identity_rules.py reads the same file): the two languages are one
 * behavior, and a case that changes changes in both.
 */
interface CheckCase {
  case: string;
  input: Record<string, unknown>;
  existing?: number;
  max?: number;
  ok?: { name: string; proxy?: string };
  error?: { code: "invalid" | "limit"; message: string };
}

interface Fixture {
  name_max: number;
  id_max: number;
  check_request: CheckCase[];
  redact_proxy: { case: string; input: string; expect: string }[];
  slugify: { case: string; input: string; expect: string; fallback?: string }[];
  identity_id: {
    valid: string[];
    invalid: string[];
    new: { case: string; name: string; pattern: string }[];
  };
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/identity-rules.json", import.meta.url), "utf8")) as Fixture;

describe("the identity rules fixture", () => {
  it("states the limits the code has", () => {
    expect(fixture.name_max).toBe(IDENTITY_NAME_MAX);
    expect(fixture.id_max).toBe(64);
  });

  it("holds cases for every rule", () => {
    expect(fixture.check_request.length).toBeGreaterThan(30);
    expect(fixture.check_request.some((c) => c.error?.code === "limit")).toBe(true);
    expect(fixture.check_request.some((c) => c.error?.code === "invalid")).toBe(true);
    expect(fixture.redact_proxy.length).toBeGreaterThan(10);
  });
});

describe("checkIdentityRequest", () => {
  it.each(fixture.check_request)("$case", (c) => {
    const run = () => checkIdentityRequest(c.input as { name: unknown; proxy?: unknown }, c.existing ?? 0, c.max ?? 20);
    if (c.ok) {
      expect(run()).toEqual(c.ok);
      return;
    }
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdentityRequestError);
    expect({ code: (caught as IdentityRequestError).code, message: (caught as IdentityRequestError).message }).toEqual(c.error);
  });
});

describe("redactProxy", () => {
  it.each(fixture.redact_proxy)("$case", (c) => {
    expect(redactProxy(c.input)).toBe(c.expect);
  });
});

describe("slugify", () => {
  it.each(fixture.slugify)("$case", (c) => {
    const slug = c.fallback === undefined ? slugify(c.input) : slugify(c.input, c.fallback);
    expect(slug).toBe(c.expect);
  });
});

describe("identity ids", () => {
  it.each(fixture.identity_id.valid)("accepts %j", (id) => {
    expect(isValidIdentityId(id)).toBe(true);
  });

  it.each(fixture.identity_id.invalid)("refuses %j", (id) => {
    expect(isValidIdentityId(id)).toBe(false);
  });

  it.each(fixture.identity_id.new)("a new id for $case is the slug and six random characters, and valid", (c) => {
    const id = newIdentityId(c.name);
    expect(id).toMatch(new RegExp(c.pattern));
    expect(isValidIdentityId(id)).toBe(true);
  });

  it("two new ids for one name differ", () => {
    expect(newIdentityId("Work Profile")).not.toBe(newIdentityId("Work Profile"));
  });
});
