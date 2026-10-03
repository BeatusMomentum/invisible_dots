/**
 * The real invisible-playwright-mcp tools (mcp-tools.json) and the check of
 * a call's arguments against them, shared by the fake server and the tests.
 * Only the schema keywords the real tools/list uses are understood; a new
 * keyword fails loudly instead of being ignored.
 */
import { readFileSync } from "node:fs";

export interface JsonSchema {
  type?: string;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface RealTool {
  name: string;
  inputSchema: JsonSchema;
}

interface Fixture {
  package: string;
  version: string;
  tools: RealTool[];
}

export const REAL_TOOLS_FIXTURE: Fixture = JSON.parse(readFileSync(new URL("./mcp-tools.json", import.meta.url), "utf8")) as Fixture;
export const REAL_TOOLS: readonly RealTool[] = REAL_TOOLS_FIXTURE.tools;

const KNOWN_KEYWORDS = new Set(["type", "enum", "anyOf", "default", "properties", "required"]);

function matches(schema: JsonSchema, value: unknown): boolean {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) throw new Error(`mcp-tools.json uses the schema keyword "${keyword}", which this check does not understand`);
  }
  if (schema.anyOf) return schema.anyOf.some((option) => matches(option, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case undefined:
      return true;
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      throw new Error(`mcp-tools.json uses the type "${schema.type}", which this check does not understand`);
  }
}

/** What is wrong with calling the real tool `name` with `args`; empty when the real server would take it. */
export function argumentProblems(name: string, args: Record<string, unknown>): string[] {
  const tool = REAL_TOOLS.find((t) => t.name === name);
  if (!tool) return [`the real server has no tool ${name}`];
  const properties = tool.inputSchema.properties ?? {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (!schema) problems.push(`it has no argument "${key}"`);
    else if (!matches(schema, value)) problems.push(`"${key}" does not match its schema (${JSON.stringify(value)})`);
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in args)) problems.push(`"${key}" is required`);
  }
  return problems;
}
