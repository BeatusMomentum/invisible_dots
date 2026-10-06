import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "../src/proxy";
import { contentSecurityPolicy, newNonce } from "../src/lib/csp";

const directives = (policy: string) => Object.fromEntries(policy.split("; ").map((part) => [part.split(" ")[0]!, part.split(" ").slice(1)]));

describe("the Content Security Policy of the pages", () => {
  it("lets the page's own scripts run by their nonce and loads nothing else: no other origin, no object, no frame, no base", () => {
    const policy = directives(contentSecurityPolicy("abc123", false));
    expect(policy["script-src"]).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(policy["script-src"]).not.toContain("'unsafe-inline'");
    expect(policy["script-src"]).not.toContain("'unsafe-eval'");
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["connect-src"]).toEqual(["'self'"]);
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'none'"]);
    expect(policy["form-action"]).toEqual(["'self'"]);
    // The pictures of the Dot's computer are shown from memory.
    expect(policy["img-src"]).toEqual(["'self'", "blob:", "data:"]);
    expect(contentSecurityPolicy("n", false)).not.toMatch(/https?:\/\/|\*/);
  });

  it("allows eval only while developing, where React reads server stacks back with it", () => {
    expect(directives(contentSecurityPolicy("n", true))["script-src"]).toContain("'unsafe-eval'");
    expect(directives(contentSecurityPolicy("n", false))["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("makes a nonce of 128 random bits for every request", () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(Buffer.from(nonce, "base64")).toHaveLength(16);
  });
});

describe("the proxy in front of the pages", () => {
  it("puts the policy and its nonce on the request, for Next to mark its scripts with, and on the response", () => {
    const response = proxy(new NextRequest("http://127.0.0.1:3000/dots/d1/chat"));
    const policy = response.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(policy)![1]!;
    expect(policy).toBe(contentSecurityPolicy(nonce));
    // NextResponse.next carries the request headers it was given as `x-middleware-request-*`.
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    // Another request, another nonce.
    expect(proxy(new NextRequest("http://127.0.0.1:3000/")).headers.get("content-security-policy")).not.toBe(policy);
  });

  it("is for the pages: not the API proxy, the session route, the built files or a prefetch", () => {
    const [matcher] = config.matcher as unknown as [{ source: string; missing: unknown[] }];
    const source = new RegExp(`^${matcher.source}$`);
    for (const path of ["/", "/login", "/dots/d1/chat", "/inbox", "/settings", "/new"]) expect(source.test(path), path).toBe(true);
    for (const path of ["/api/dots", "/api/stream", "/session", "/_next/static/chunks/a.js", "/_next/image", "/favicon.ico"]) expect(source.test(path), path).toBe(false);
    expect(matcher.missing).toEqual([
      { type: "header", key: "next-router-prefetch" },
      { type: "header", key: "purpose", value: "prefetch" },
    ]);
  });
});
