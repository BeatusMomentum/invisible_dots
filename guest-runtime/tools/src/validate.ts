import type { JsonSchema } from "@invisible-dots/shared";

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  const where = path || "arguments";
  switch (schema.type) {
    case "object": {
      if (typeOf(value) !== "object") {
        errors.push(`${where} must be an object, got ${typeOf(value)}`);
        return;
      }
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      for (const name of schema.required ?? []) {
        if (record[name] === undefined) errors.push(`${path ? `${path}.` : ""}${name} is required`);
      }
      for (const [name, item] of Object.entries(record)) {
        const child = properties[name];
        const childPath = path ? `${path}.${name}` : name;
        if (!child) {
          if (schema.additionalProperties === false) errors.push(`${childPath} is not an accepted argument`);
          continue;
        }
        if (item !== undefined) check(child, item, childPath, errors);
      }
      return;
    }
    case "string":
      if (typeof value !== "string") {
        errors.push(`${where} must be a string, got ${typeOf(value)}`);
        return;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(schema.minLength === 1 ? `${where} must not be empty` : `${where} must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${where} must be at most ${schema.maxLength} characters`);
      }
      break;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${where} must be a ${schema.type}, got ${typeOf(value)}`);
        return;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${where} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where} must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where} must be at most ${schema.maximum}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${where} must be a boolean, got ${typeOf(value)}`);
      break;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${where} must be an array, got ${typeOf(value)}`);
        return;
      }
      if (schema.items) value.forEach((item, i) => check(schema.items!, item, `${where}[${i}]`, errors));
      break;
    default:
      break;
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${where} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
}

/**
 * Checks a value against the JSON Schema subset the tool table uses
 * (`JsonSchema` in shared). Returns every problem found, empty when valid.
 */
export function validateArguments(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, value, "", errors);
  return errors;
}
