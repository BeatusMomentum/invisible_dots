/**
 * A YAML emitter for the Dot configuration, so the Settings tab can show the
 * stored (JSON) config as editable YAML. It covers what a config holds:
 * nested objects, strings, numbers, booleans, null and arrays of those. The
 * API does the parsing and validation when the text is sent back.
 */

const RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const NUMBER_LIKE = /^[-+]?(?:\.?\d|0x|0o|\.inf$|\.nan$)/i;
const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

function needsQuotes(text: string): boolean {
  return (
    text === "" ||
    text !== text.trim() ||
    RESERVED.test(text) ||
    NUMBER_LIKE.test(text) ||
    INDICATOR_START.test(text) ||
    text.includes(": ") ||
    text.includes(" #") ||
    text.endsWith(":") ||
    // Control characters (including tab and newline) only survive in a quoted scalar.
    /[\u0000-\u001f\u007f]/.test(text)
  );
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot write ${value} as YAML`);
    return String(value);
  }
  const text = String(value);
  // JSON string syntax is a valid YAML double-quoted scalar.
  return needsQuotes(text) ? JSON.stringify(text) : text;
}

function key(name: string): string {
  return PLAIN_KEY.test(name) && !RESERVED.test(name) ? name : JSON.stringify(name);
}

/**
 * A multi-line string as a literal block, when that keeps it byte for byte:
 * "|" keeps exactly one final newline, "|-" none.
 */
function literalBlock(text: string, indent: string): string | null {
  if (!text.includes("\n") || /[\r\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return null;
  let body = text;
  let indicator = "|-";
  if (text.endsWith("\n")) {
    if (text.endsWith("\n\n")) return null;
    body = text.slice(0, -1);
    indicator = "|";
  }
  const lines = body.split("\n");
  // A leading space on the first line would be read as the block's indentation.
  if (lines[0]!.startsWith(" ") || lines[0] === "") return null;
  return `${indicator}\n${lines.map((line) => (line === "" ? "" : `${indent}${line}`)).join("\n")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emit(value: unknown, indent: string, lines: string[], prefix: string): void {
  const child = `${indent}  `;
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      lines.push(`${prefix} {}`);
      return;
    }
    if (prefix) lines.push(prefix);
    const inner = prefix ? child : indent;
    for (const [k, v] of entries) emit(v, inner, lines, `${inner}${key(k)}:`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${prefix} []`);
      return;
    }
    if (prefix) lines.push(prefix);
    const inner = prefix ? child : indent;
    for (const item of value) {
      if (isPlainObject(item) || Array.isArray(item)) {
        lines.push(`${inner}-`);
        emit(item, `${inner}  `, lines, "");
      } else {
        lines.push(`${inner}- ${scalar(item)}`);
      }
    }
    return;
  }
  if (typeof value === "string") {
    const block = literalBlock(value, prefix ? child : indent);
    if (block !== null) {
      lines.push(`${prefix} ${block}`);
      return;
    }
  }
  lines.push(prefix ? `${prefix} ${scalar(value)}` : `${indent}${scalar(value)}`);
}

export function toYaml(value: unknown): string {
  if (!isPlainObject(value)) throw new Error("toYaml expects an object at the top level");
  const lines: string[] = [];
  emit(value, "", lines, "");
  return `${lines.join("\n")}\n`;
}

/** Shown in the create form: the example from the architecture document. */
export const EXAMPLE_CONFIG = `name: fare-watch
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
