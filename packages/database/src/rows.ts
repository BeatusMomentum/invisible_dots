/**
 * Row mapping shared by the repositories. Both adapters return timestamptz
 * as a Date and int8 as a number (db.ts); the API speaks ISO strings.
 */
export type { Queryable } from "./db.js";

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoRequired(value: Date | string): string {
  return iso(value) as string;
}

/** SQLSTATE codes and constraint names come from the server, so both adapters report the same ones. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === "23505" && (constraint === undefined || e.constraint === constraint);
}
