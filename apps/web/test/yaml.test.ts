import { parseDotConfig } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG, toYaml } from "../src/lib/yaml";

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
      models: { fast: "0123" },
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
