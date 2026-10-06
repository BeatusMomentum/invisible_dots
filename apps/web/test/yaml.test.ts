import { parseDotConfig } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { toYaml } from "../src/lib/yaml";

/** The example of the architecture document: every section of a config, written the way a person would. */
const EXAMPLE_CONFIG = `name: fare-watch
goal: >
  Check one-way fares from Milan to Lisbon every morning and report the cheapest day.
instructions: >
  Write findings to ~/workspace/fares.csv.
model:
  provider: openrouter
  id: z-ai/glm-5.3-flash
computer:
  cpu: 2
  memory: 4gb
  disk: 40gb
  idle_timeout: 15m
browser:
  identities:
    managed_by_dot: true
    max_identities: 20
    max_open: 3
permissions:
  computer.exec: allow
  browser.identity.delete: ask
memory:
  enabled: true
limits:
  max_steps_per_task: 60
  context_tokens: 32000
  max_cost_per_task_usd: 1.00
`;


describe("toYaml", () => {
  it("round-trips the example config through the shared schema", () => {
    const config = parseDotConfig(EXAMPLE_CONFIG);
    expect(parseDotConfig(toYaml(config))).toEqual(config);
  });

  it("keeps strings that YAML would otherwise read as other types", () => {
    const config = parseDotConfig({
      name: "tricky",
      goal: "yes",
      instructions: "key: value # not a comment\n  indented second line\n",
      model: { provider: "openrouter", id: "vendor/model:free" },
      models: { summary: "0123" },
      computer: { cpu: 4, memory: "8gb", disk: "100gb", idle_timeout: "0" },
      permissions: { "computer.exec": "ask" },
    });
    const text = toYaml(config);
    expect(parseDotConfig(text)).toEqual(config);
    expect(text).toContain('goal: "yes"');
  });

  it("writes multi-line text as a literal block and round-trips edge cases", () => {
    const cases = ["one\ntwo", "one\ntwo\n", "  leading\nspace", "a\n\n\nb", "trailing\n\n", "tab\there\nx", "#hash\n- dash"];
    for (const instructions of cases) {
      const config = parseDotConfig({ name: "m", goal: "g", instructions, model: { provider: "openrouter", id: "a/b" } });
      expect(parseDotConfig(toYaml(config)).instructions).toBe(instructions);
    }
    const block = toYaml({ text: "one\ntwo" });
    expect(block).toBe("text: |-\n  one\n  two\n");
  });

  it("writes empty objects inline and nests objects by two spaces", () => {
    expect(toYaml({ a: {}, b: { c: { d: true } }, e: null, f: 1.5 })).toBe("a: {}\nb:\n  c:\n    d: true\ne: null\nf: 1.5\n");
  });

  it("refuses a non-object at the top level", () => {
    expect(() => toYaml("x")).toThrow();
  });
});
