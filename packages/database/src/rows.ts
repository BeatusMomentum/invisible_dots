/**
 * Row mapping shared by the repositories. node-postgres returns bigint as a
 * string and timestamptz as a Date; the API speaks numbers and ISO strings.
 */
import type { QueryResult, QueryResultRow } from "pg";

/** A pool or a client inside a transaction. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoRequired(value: Date | string): string {
  return iso(value) as string;
}

/** bigint columns stay well under 2^53 here (event ids, guest sequence numbers). */
export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === "23505" && (constraint === undefined || e.constraint === constraint);
}

export function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "23503";
}
