import { describe, expect, it } from "vitest";
import { MCP_PACKAGE, parsePythonLock, PLAYWRIGHT_PACKAGE } from "../src/python-lock.js";

const HASH_A = `--hash=sha256:${"a".repeat(64)}`;
const HASH_B = `--hash=sha256:${"b".repeat(64)}`;

function lock(...entries: string[]): string {
  return ["# header", ...entries, ""].join("\n");
}
const pkg = (name: string, version: string, hashes: string[] = [HASH_A]) =>
  [`${name}==${version} \\`, ...hashes.map((hash, i) => `    ${hash}${i < hashes.length - 1 ? " \\" : ""}`)].join("\n");

describe("parsePythonLock", () => {
  it("reads every package and the two top-level versions", () => {
    const parsed = parsePythonLock(lock(pkg("Typing_Extensions", "4.16.0", [HASH_A, HASH_B]), pkg(MCP_PACKAGE, "0.70.2"), pkg(PLAYWRIGHT_PACKAGE, "0.25.7")));
    expect(parsed.mcpVersion).toBe("0.70.2");
    expect(parsed.playwrightVersion).toBe("0.25.7");
    // Names compare as PEP 503 normalizes them.
    expect(parsed.packages.get("typing-extensions")).toBe("4.16.0");
    expect(parsed.packages.size).toBe(3);
  });

  it("refuses a requirement without a hash, which --require-hashes would refuse inside the builder VM", () => {
    expect(() => parsePythonLock(lock("idna==3.20", pkg(MCP_PACKAGE, "0.70.2"), pkg(PLAYWRIGHT_PACKAGE, "0.25.7")))).toThrow(/expected/);
    expect(() => parsePythonLock(lock("idna==3.20 \\", pkg(MCP_PACKAGE, "0.70.2"), pkg(PLAYWRIGHT_PACKAGE, "0.25.7")))).toThrow(/idna ends without its hashes/);
  });

  it("refuses anything that is not a pinned requirement: ranges, URLs, editable installs", () => {
    for (const line of ["idna>=3 \\", "-e ./local", "idna @ https://example.invalid/idna.whl \\"]) {
      expect(() => parsePythonLock(lock(line, `    ${HASH_A}`, pkg(MCP_PACKAGE, "0.70.2"), pkg(PLAYWRIGHT_PACKAGE, "0.25.7")))).toThrow(/expected/);
    }
  });

  it("refuses a package listed twice and a lock without both top-level packages", () => {
    expect(() => parsePythonLock(lock(pkg("idna", "3.20"), pkg("IDNA", "3.21"), pkg(MCP_PACKAGE, "0.70.2"), pkg(PLAYWRIGHT_PACKAGE, "0.25.7")))).toThrow(/listed twice/);
    expect(() => parsePythonLock(lock(pkg(MCP_PACKAGE, "0.70.2")))).toThrow(/must pin both/);
  });

  it("refuses a version that pins.env could not carry without quoting", () => {
    expect(() => parsePythonLock(lock(pkg(MCP_PACKAGE, "0.70.2;x"), pkg(PLAYWRIGHT_PACKAGE, "0.25.7")))).toThrow(/expected/);
  });
});
