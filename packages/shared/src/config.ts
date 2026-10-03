/**
 * The Dot configuration of architecture section 7: one zod schema, used by the
 * API when a Dot is created or patched and by the guest when `PUT /config`
 * arrives.
 *
 * Sizes and durations stay strings in the parsed config ("4gb", "15m") so that
 * a parsed config is itself a valid input: it is stored as jsonb, sent back to
 * clients and re-parsed on PATCH. Use `computerResources()` for numbers.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isPermission, type Permission } from "./tools.js";

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;
const TIB = GIB * 1024;

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: KIB,
  kb: KIB,
  kib: KIB,
  m: MIB,
  mb: MIB,
  mib: MIB,
  g: GIB,
  gb: GIB,
  gib: GIB,
  t: TIB,
  tb: TIB,
  tib: TIB,
};

/**
 * Parse a size such as "4gb", "512mb" or "1.5 GiB" into bytes. Units are
 * binary (1gb = 1024^3 bytes): the values end up as QEMU `-m` MiB and
 * qemu-img sizes, which are binary too. A bare number is refused because
 * "4096" is ambiguous between bytes and MiB.
 */
export function parseSize(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(value);
  if (!match) {
    throw new Error(`invalid size "${value}": expected a number followed by a unit, e.g. "4gb" or "512mb"`);
  }
  const unit = SIZE_UNITS[match[2]!.toLowerCase()];
  if (unit === undefined) {
    throw new Error(`invalid size "${value}": unknown unit "${match[2]}" (use b, kb, mb, gb or tb)`);
  }
  return Math.round(Number(match[1]) * unit);
}

/** Bytes to whole MiB, rounded down. */
export function bytesToMiB(bytes: number): number {
  return Math.floor(bytes / MIB);
}

/** Parse a size and return whole MiB, rounded down. */
export function parseSizeMiB(value: string): number {
  return bytesToMiB(parseSize(value));
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a duration such as "15m", "90s", "2h" or "1h30m" into milliseconds.
 * "0" (or the number 0) means never and returns null.
 */
export function parseDuration(value: string | number): number | null {
  if (value === 0 || (typeof value === "string" && /^\s*0+\s*$/.test(value))) return null;
  if (typeof value === "number") {
    throw new Error(`invalid duration ${value}: a non-zero duration needs a unit, e.g. "15m"`);
  }
  const text = value.trim().toLowerCase();
  const part = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/y;
  let total = 0;
  let index = 0;
  while (index < text.length) {
    part.lastIndex = index;
    const match = part.exec(text);
    if (!match) {
      throw new Error(`invalid duration "${value}": expected e.g. "15m", "90s", "2h", "1h30m" or "0" for never`);
    }
    total += Number(match[1]) * DURATION_UNITS[match[2]!]!;
    index = part.lastIndex;
  }
  if (text.length === 0) {
    throw new Error(`invalid duration "${value}": empty`);
  }
  const ms = Math.round(total);
  // "0s" is a zero written with a unit; treat it like "0" rather than as "sleep at once".
  return ms === 0 ? null : ms;
}

export const DOT_NAME_PATTERN = /^[a-z0-9-]{1,40}$/;

export function isValidDotName(name: string): boolean {
  return DOT_NAME_PATTERN.test(name);
}

function sizeField(label: string, min: string, max: string, fallback: string) {
  const minBytes = parseSize(min);
  const maxBytes = parseSize(max);
  return z
    .string()
    .default(fallback)
    .superRefine((value, ctx) => {
      let bytes: number;
      try {
        bytes = parseSize(value);
      } catch (error) {
        ctx.addIssue({ code: "custom", message: (error as Error).message });
        return;
      }
      if (bytes < minBytes || bytes > maxBytes) {
        ctx.addIssue({ code: "custom", message: `${label} must be between ${min} and ${max}, got "${value}"` });
      }
    })
    .transform((value) => value.trim().toLowerCase());
}

const durationField = z
  .union([z.string(), z.number()])
  .default("15m")
  .superRefine((value, ctx) => {
    try {
      parseDuration(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  })
  // YAML reads `idle_timeout: 0` as a number; keep the field a string either way.
  .transform((value) => String(value).trim().toLowerCase());

const modelId = z
  .string()
  .min(1, "model id must not be empty")
  .regex(/^\S+$/, "model id must not contain whitespace");

const permissionDecision = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof permissionDecision>;

export const dotConfigSchema = z
  .object({
    name: z
      .string()
      .regex(DOT_NAME_PATTERN, "name must be 1 to 40 characters of lowercase letters, digits and '-'"),
    goal: z.string().trim().min(1, "goal must not be empty"),
    instructions: z.string().optional(),
    model: z
      .object({
        provider: z.literal("openrouter", { error: 'model.provider must be "openrouter"' }),
        id: modelId,
      })
      .strict(),
    models: z
      .record(z.string().regex(/^[a-z0-9_-]{1,40}$/, "model role names are lowercase letters, digits, '_' and '-'"), modelId)
      .default({}),
    computer: z
      .object({
        cpu: z.number().int("computer.cpu must be an integer").min(1).max(16).default(2),
        memory: sizeField("computer.memory", "2gb", "64gb", "4gb"),
        disk: sizeField("computer.disk", "20gb", "1024gb", "40gb"),
        idle_timeout: durationField,
      })
      .strict()
      .default({ cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" }),
    browser: z
      .object({
        identities: z
          .object({
            managed_by_dot: z.boolean().default(true),
            max_identities: z.number().int().min(1).max(1000).default(20),
            max_open: z.number().int().min(1).max(16).default(3),
          })
          .strict()
          .default({ managed_by_dot: true, max_identities: 20, max_open: 3 }),
      })
      .strict()
      .default({ identities: { managed_by_dot: true, max_identities: 20, max_open: 3 } }),
    permissions: z
      .record(z.string(), permissionDecision)
      .default({})
      .superRefine((perms, ctx) => {
        // A typo such as "computer.exe: deny" would otherwise be silently ignored
        // and leave the real permission at its default.
        for (const key of Object.keys(perms)) {
          if (!isPermission(key)) {
            ctx.addIssue({ code: "custom", path: [key], message: `unknown permission "${key}"` });
          }
        }
      }),
    memory: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({ enabled: true }),
    limits: z
      .object({
        max_steps_per_task: z.number().int().min(1).max(1000).default(60),
        // Prompt tokens a request may use; what is sent is kept under it (section 8.6).
        context_tokens: z.number().int().min(4000).max(1_000_000).default(32_000),
      })
      .strict()
      .default({ max_steps_per_task: 60, context_tokens: 32_000 }),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = config.browser.identities;
    if (ids.max_open > ids.max_identities) {
      ctx.addIssue({
        code: "custom",
        path: ["browser", "identities", "max_open"],
        message: `max_open (${ids.max_open}) cannot exceed max_identities (${ids.max_identities})`,
      });
    }
  });

export type DotConfig = z.output<typeof dotConfigSchema>;
export type DotConfigInput = z.input<typeof dotConfigSchema>;
/** What `PUT /config` sends to the guest: the config minus `computer` (section 7). */
export type DotRuntimeConfig = Omit<DotConfig, "computer">;

export class DotConfigError extends Error {
  readonly issues: { path: string; message: string }[];

  constructor(issues: { path: string; message: string }[]) {
    super(`invalid Dot configuration: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`);
    this.name = "DotConfigError";
    this.issues = issues;
  }
}

function loadInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return parseYaml(input);
  } catch (error) {
    throw new DotConfigError([{ path: "", message: `not valid YAML: ${(error as Error).message}` }]);
  }
}

/** Parse YAML text or an already-decoded object into a DotConfig with every default applied. */
export function parseDotConfig(input: unknown): DotConfig {
  const result = dotConfigSchema.safeParse(loadInput(input));
  if (!result.success) {
    throw new DotConfigError(
      result.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
    );
  }
  return result.data;
}

/** Like `parseDotConfig`, without throwing. */
export function safeParseDotConfig(
  input: unknown,
): { ok: true; config: DotConfig } | { ok: false; error: DotConfigError } {
  try {
    return { ok: true, config: parseDotConfig(input) };
  } catch (error) {
    if (error instanceof DotConfigError) return { ok: false, error };
    throw error;
  }
}

/**
 * Validate a runtime config as the guest receives it. The guest has no
 * `computer` section to check, so the full schema is applied with the
 * defaults in its place and then removed again.
 */
export function parseRuntimeConfig(input: unknown): DotRuntimeConfig {
  const value = loadInput(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DotConfigError([{ path: "", message: "runtime config must be an object" }]);
  }
  if ("computer" in value) {
    throw new DotConfigError([{ path: "computer", message: "a runtime config has no computer section" }]);
  }
  return toRuntimeConfig(parseDotConfig(value));
}

export function toRuntimeConfig(config: DotConfig): DotRuntimeConfig {
  const { computer: _computer, ...runtime } = config;
  return runtime;
}

export interface ComputerResources {
  cpus: number;
  memoryBytes: number;
  memoryMiB: number;
  diskBytes: number;
  /** Milliseconds of inactivity before the Dot sleeps; null means never. */
  idleTimeoutMs: number | null;
}

export function computerResources(config: Pick<DotConfig, "computer">): ComputerResources {
  const memoryBytes = parseSize(config.computer.memory);
  return {
    cpus: config.computer.cpu,
    memoryBytes,
    memoryMiB: bytesToMiB(memoryBytes),
    diskBytes: parseSize(config.computer.disk),
    idleTimeoutMs: parseDuration(config.computer.idle_timeout),
  };
}

/**
 * The decision for one permission (section 7). An explicit entry in the
 * config wins. Otherwise everything under computer.*, files.*, browser.* and
 * memory.* is allowed except browser.identity.delete, which asks. A
 * permission the tool registry does not know is denied whatever the config
 * says.
 */
export function resolvePermission(
  config: Pick<DotRuntimeConfig, "permissions">,
  permission: string,
): PermissionDecision {
  if (!isPermission(permission)) return "deny";
  const explicit = config.permissions[permission];
  if (explicit !== undefined) return explicit;
  return defaultPermission(permission);
}

function defaultPermission(permission: Permission): PermissionDecision {
  if (permission === "browser.identity.delete") return "ask";
  const namespace = permission.split(".")[0];
  return namespace === "computer" || namespace === "files" || namespace === "browser" || namespace === "memory"
    ? "allow"
    : "deny";
}
