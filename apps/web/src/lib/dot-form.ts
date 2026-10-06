/**
 * The create-a-Dot form (S3) as data. The form holds what its controls show; `formToConfig` turns it into the
 * config object the API takes, and the shared schema (`parseDotConfig`) is the only judge of whether that is valid,
 * so the form can never accept what the API refuses nor refuse what it accepts. The numbers' ranges come from
 * the schema's own bounds (`CONFIG_BOUNDS`). The YAML editor is the same config as text: `formToYaml` writes it and
 * `yamlToForm` reads it back, unless the text sets something the form has no control for.
 */
import {
  CONFIG_BOUNDS,
  DOT_NAME_PATTERN,
  parseSize,
  safeParseDotConfig,
  type DotConfig,
  type DotConfigError,
  type PermissionDecision,
} from "@invisible-dots/shared/browser";
import { presetPermissions } from "./permission-presets";
import { toYaml } from "./yaml";

const GIB = 1024 ** 3;

/** A size of the config ("4gb") in GiB, which is what the sliders count in. */
export function gibOf(size: string): number {
  return parseSize(size) / GIB;
}

/** GiB as the config writes a size. */
export function gibSize(gib: number): string {
  return `${gib}gb`;
}

/** The model a new Dot starts with: the one the architecture document's example uses. */
export const DEFAULT_MODEL_ID = "z-ai/glm-5.3-flash";

/** What the model field suggests; any OpenRouter model id may be typed instead. */
export const MODEL_SUGGESTIONS: readonly string[] = [DEFAULT_MODEL_ID];

export interface IdleChoice {
  value: string;
  label: string;
}

/** How long the computer may sit unused before it sleeps; "0" is never. */
export const IDLE_CHOICES: readonly IdleChoice[] = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "0", label: "Never" },
];

/** The slider ranges, in whole GiB where the config has sizes ("4gb"). */
export const FORM_BOUNDS = {
  cpu: CONFIG_BOUNDS.cpu,
  memoryGib: { min: gibOf(CONFIG_BOUNDS.memory.min), max: gibOf(CONFIG_BOUNDS.memory.max) },
  diskGib: { min: gibOf(CONFIG_BOUNDS.disk.min), max: gibOf(CONFIG_BOUNDS.disk.max) },
  maxCostUsd: CONFIG_BOUNDS.maxCostPerTaskUsd,
} as const;

export interface DotForm {
  name: string;
  goal: string;
  instructions: string;
  modelId: string;
  /** The model that writes summaries; empty means the Dot's own model does. */
  summaryModelId: string;
  cpu: number;
  memoryGib: number;
  diskGib: number;
  idleTimeout: string;
  /** The config's `permissions` as it will be written: a preset's overrides, or what the YAML set. */
  permissions: Record<string, PermissionDecision>;
  maxCostUsd: number;
}

export function emptyForm(): DotForm {
  return {
    name: "",
    goal: "",
    instructions: "",
    modelId: DEFAULT_MODEL_ID,
    summaryModelId: "",
    cpu: CONFIG_BOUNDS.cpu.default,
    memoryGib: gibOf(CONFIG_BOUNDS.memory.default),
    diskGib: gibOf(CONFIG_BOUNDS.disk.default),
    idleTimeout: CONFIG_BOUNDS.idleTimeout.default,
    permissions: presetPermissions("balanced"),
    maxCostUsd: CONFIG_BOUNDS.maxCostPerTaskUsd.default,
  };
}

/** The config object `POST /api/dots` takes. Only what the form sets: the schema fills in the rest. */
export function formToConfig(form: DotForm): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: form.name,
    goal: form.goal,
    model: { provider: "openrouter", id: form.modelId },
    computer: { cpu: form.cpu, memory: gibSize(form.memoryGib), disk: gibSize(form.diskGib), idle_timeout: form.idleTimeout },
    permissions: { ...form.permissions },
    limits: { max_cost_per_task_usd: form.maxCostUsd },
  };
  if (form.instructions !== "") config.instructions = form.instructions;
  if (form.summaryModelId !== "") config.models = { summary: form.summaryModelId };
  return config;
}

export function configToForm(config: DotConfig): DotForm {
  return {
    name: config.name,
    goal: config.goal,
    instructions: config.instructions ?? "",
    modelId: config.model.id,
    summaryModelId: config.models.summary ?? "",
    cpu: config.computer.cpu,
    memoryGib: gibOf(config.computer.memory),
    diskGib: gibOf(config.computer.disk),
    idleTimeout: config.computer.idle_timeout,
    permissions: { ...config.permissions },
    maxCostUsd: config.limits.max_cost_per_task_usd,
  };
}

export type FieldId = "name" | "goal" | "instructions" | "modelId" | "summaryModelId" | "cpu" | "memoryGib" | "diskGib" | "idleTimeout" | "maxCostUsd";

export interface FormIssue {
  /** The control the problem belongs to; null when it belongs to none (the YAML as a whole, a section the form has no control for). */
  field: FieldId | null;
  /** The config path it is about ("computer.cpu"); empty when it is about the whole config. */
  path: string;
  message: string;
}

/** An issue as one line, with its path in front when it has one: what the YAML editor and the summary list. */
export function issueText(issue: FormIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

/** Where each config path shows up in the form. A path not listed has no control. */
const FIELD_OF_PATH: Readonly<Record<string, FieldId>> = {
  name: "name",
  goal: "goal",
  instructions: "instructions",
  "model.id": "modelId",
  "models.summary": "summaryModelId",
  "computer.cpu": "cpu",
  "computer.memory": "memoryGib",
  "computer.disk": "diskGib",
  "computer.idle_timeout": "idleTimeout",
  "limits.max_cost_per_task_usd": "maxCostUsd",
};

function toIssues(error: DotConfigError): FormIssue[] {
  return error.issues.map(({ path, message }) => ({ field: FIELD_OF_PATH[path] ?? null, path, message }));
}

/** What is wrong with a config (a form's, or YAML text): the schema's issues, and a name another Dot already has. */
export function configIssues(input: unknown, takenNames: readonly string[] = []): FormIssue[] {
  const parsed = safeParseDotConfig(input);
  const issues = parsed.ok ? [] : toIssues(parsed.error);
  const name = parsed.ok ? parsed.config.name : typeof input === "object" && input !== null && "name" in input ? (input as { name: unknown }).name : null;
  if (typeof name === "string" && takenNames.includes(name)) issues.push({ field: "name", path: "name", message: `A Dot named "${name}" already exists` });
  return issues;
}

export function formIssues(form: DotForm, takenNames: readonly string[] = []): FormIssue[] {
  return configIssues(formToConfig(form), takenNames);
}

/** Whether a name is worth a "not valid" mark yet: it is not empty, and the schema's name pattern refuses it. */
export function nameIsMalformed(name: string): boolean {
  return name !== "" && !DOT_NAME_PATTERN.test(name);
}

/** The form's config as YAML text, to start the YAML editor from. */
export function formToYaml(form: DotForm): string {
  return toYaml(formToConfig(form));
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** The config without the one thing the form cannot tell apart from an empty field: `instructions: ""`. */
function withoutEmptyInstructions(config: DotConfig): DotConfig {
  if (config.instructions !== "") return config;
  const { instructions: _empty, ...rest } = config;
  return rest;
}

export type YamlRead = { ok: true; form: DotForm } | { ok: false; issues: FormIssue[] };

/**
 * Read YAML text back into the form. It fails with the schema's issues when the text is not a valid config, and
 * with one issue of its own when it is valid but sets something the form has no control for (the browser's limits,
 * memory off, the step and token limits): the form would drop it, so the person stays in the YAML.
 */
export function yamlToForm(text: string): YamlRead {
  const parsed = safeParseDotConfig(text);
  if (!parsed.ok) return { ok: false, issues: toIssues(parsed.error) };
  const form = configToForm(parsed.config);
  const again = safeParseDotConfig(formToConfig(form));
  if (!again.ok || canonical(withoutEmptyInstructions(again.config)) !== canonical(withoutEmptyInstructions(parsed.config))) {
    return {
      ok: false,
      issues: [{ field: null, path: "", message: "This YAML sets options the form has no controls for (such as the browser limits, memory or the step limit). Keep editing it as YAML." }],
    };
  }
  return { ok: true, form };
}
