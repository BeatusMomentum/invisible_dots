import { CONFIG_BOUNDS, parseDotConfig, PERMISSIONS, resolvePermission } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import {
  configIssues,
  configToForm,
  DEFAULT_MODEL_ID,
  emptyForm,
  FORM_BOUNDS,
  formIssues,
  formToConfig,
  formToYaml,
  nameIsMalformed,
  yamlToForm,
  type DotForm,
} from "../src/lib/dot-form";
import { presetPermissions } from "../src/lib/permission-presets";

function filled(change: Partial<DotForm> = {}): DotForm {
  return { ...emptyForm(), name: "fare-watch", goal: "Watch the fares from Milan to Lisbon", ...change };
}

describe("the empty form", () => {
  it("starts from the schema's own defaults, so a new Dot gets what an omitted field would", () => {
    const config = parseDotConfig(formToConfig(filled()));
    const bare = parseDotConfig({ name: "fare-watch", goal: "g", model: { provider: "openrouter", id: DEFAULT_MODEL_ID } });
    expect(config.computer).toEqual(bare.computer);
    expect(config.limits).toEqual(bare.limits);
    for (const permission of PERMISSIONS) expect(resolvePermission(config, permission)).toBe(resolvePermission(bare, permission));
  });

  it("is not valid until it has a name and a goal, and says which controls are at fault", () => {
    expect(formIssues(emptyForm()).map((issue) => issue.field).sort()).toEqual(["goal", "name"]);
    expect(formIssues(filled())).toEqual([]);
  });

  it("has sliders that cover exactly the range the schema accepts", () => {
    expect(FORM_BOUNDS.cpu).toEqual({ min: CONFIG_BOUNDS.cpu.min, max: CONFIG_BOUNDS.cpu.max, default: CONFIG_BOUNDS.cpu.default });
    expect(FORM_BOUNDS.memoryGib).toEqual({ min: 2, max: 64 });
    expect(FORM_BOUNDS.diskGib).toEqual({ min: 20, max: 1024 });
    for (const [field, bound] of [["memoryGib", FORM_BOUNDS.memoryGib], ["diskGib", FORM_BOUNDS.diskGib]] as const) {
      expect(formIssues(filled({ [field]: bound.min }))).toEqual([]);
      expect(formIssues(filled({ [field]: bound.max }))).toEqual([]);
      expect(formIssues(filled({ [field]: bound.min - 1 })).map((i) => i.field)).toEqual([field]);
      expect(formIssues(filled({ [field]: bound.max + 1 })).map((i) => i.field)).toEqual([field]);
    }
    expect(formIssues(filled({ cpu: 17 })).map((i) => i.field)).toEqual(["cpu"]);
    expect(formIssues(filled({ maxCostUsd: 0 })).map((i) => i.field)).toEqual(["maxCostUsd"]);
    expect(formIssues(filled({ maxCostUsd: 100.5 })).map((i) => i.field)).toEqual(["maxCostUsd"]);
  });
});

describe("formToConfig", () => {
  it("writes what the controls show in the shape of the config, and nothing for what is empty", () => {
    expect(formToConfig(filled())).toEqual({
      name: "fare-watch",
      goal: "Watch the fares from Milan to Lisbon",
      model: { provider: "openrouter", id: DEFAULT_MODEL_ID },
      computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" },
      permissions: {},
      limits: { max_cost_per_task_usd: 1 },
    });
  });

  it("adds instructions and the summary role only when they are filled in", () => {
    const config = formToConfig(filled({ instructions: "Write to fares.csv.", summaryModelId: "a/summary" }));
    expect(config.instructions).toBe("Write to fares.csv.");
    expect(config.models).toEqual({ summary: "a/summary" });
    expect(parseDotConfig(config).models).toEqual({ summary: "a/summary" });
  });

  it("carries a preset into the permissions the API receives", () => {
    const config = parseDotConfig(formToConfig(filled({ permissions: presetPermissions("careful") })));
    expect(resolvePermission(config, "computer.exec")).toBe("ask");
    expect(resolvePermission(config, "files.write")).toBe("ask");
    expect(resolvePermission(config, "files.read")).toBe("allow");
  });
});

describe("name validation", () => {
  it("marks a name the pattern refuses, and never an empty one (which is only missing)", () => {
    expect(nameIsMalformed("")).toBe(false);
    expect(nameIsMalformed("fare-watch")).toBe(false);
    expect(nameIsMalformed("Fare Watch")).toBe(true);
    expect(nameIsMalformed("a".repeat(41))).toBe(true);
    expect(nameIsMalformed("a".repeat(40))).toBe(false);
  });

  it("reports the schema's message on the name control", () => {
    const [issue] = formIssues(filled({ name: "Fare Watch" }));
    expect(issue).toMatchObject({ field: "name" });
    expect(issue!.message).toMatch(/lowercase letters, digits and '-'/);
  });

  it("refuses a name another Dot already has, valid as it is", () => {
    expect(formIssues(filled(), ["other", "fare-watch"])).toEqual([{ field: "name", path: "name", message: 'A Dot named "fare-watch" already exists' }]);
    expect(formIssues(filled(), ["other"])).toEqual([]);
  });

  it("does not say a malformed name is also taken", () => {
    expect(formIssues(filled({ name: "Fare Watch" }), ["other"])).toHaveLength(1);
  });
});

describe("the YAML editor", () => {
  it("shows the form's config and reads the same form back", () => {
    const form = filled({ instructions: "line one\nline two\n", summaryModelId: "a/summary", cpu: 4, memoryGib: 8, diskGib: 100, idleTimeout: "0", permissions: presetPermissions("autonomous"), maxCostUsd: 2.5 });
    const read = yamlToForm(formToYaml(form));
    expect(read).toEqual({ ok: true, form });
  });

  it("reads the form back from the empty-instructions case too", () => {
    const read = yamlToForm(`${formToYaml(filled())}instructions: ""\n`);
    expect(read).toEqual({ ok: true, form: filled() });
  });

  it("gives the schema's issues for text that is not a valid config, each on its control", () => {
    const read = yamlToForm("name: Bad Name\ngoal: g\nmodel:\n  provider: openrouter\n  id: a/b\ncomputer:\n  cpu: 99\n");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.issues.map((issue) => issue.field).sort()).toEqual(["cpu", "name"]);
  });

  it("gives a YAML syntax error as an issue of the whole text", () => {
    const read = yamlToForm("name: [unclosed");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.issues).toEqual([{ field: null, path: "", message: expect.stringContaining("not valid YAML") }]);
  });

  it("refuses to go back to the form when the YAML sets something the form would drop", () => {
    const base = formToYaml(filled());
    const withExtra: Record<string, string> = {
      "the browser limits": `${base}browser:\n  identities:\n    max_open: 5\n`,
      "memory off": `${base}memory:\n  enabled: false\n`,
      "the step limit": base.replace("limits:\n", "limits:\n  max_steps_per_task: 10\n"),
    };
    for (const [what, yaml] of Object.entries(withExtra)) {
      const read = yamlToForm(yaml);
      expect(read.ok, what).toBe(false);
      if (!read.ok) expect(read.issues[0]!.message, what).toMatch(/no controls for/);
    }
  });

  it("is judged like the form: the same config, the same issues", () => {
    const form = filled({ name: "Fare Watch", cpu: 99 });
    expect(configIssues(formToYaml(form)).map((i) => i.field).sort()).toEqual(formIssues(form).map((i) => i.field).sort());
  });

  it("keeps a permission map the form has no preset for, instead of dropping it", () => {
    const read = yamlToForm(formToYaml(filled({ permissions: { "computer.exec": "deny", "files.write": "ask" } })));
    expect(read.ok && read.form.permissions).toEqual({ "computer.exec": "deny", "files.write": "ask" });
  });
});

describe("configToForm", () => {
  it("shows a config's sizes in GiB for the sliders", () => {
    const config = parseDotConfig({ name: "a", goal: "g", model: { provider: "openrouter", id: "a/b" }, computer: { memory: "16gb", disk: "512gb" } });
    expect(configToForm(config)).toMatchObject({ memoryGib: 16, diskGib: 512 });
  });
});
