/** The New task form's fields, and the request they make. */
import type { CreateTaskRequest } from "@invisible-dots/sdk";
import { NORMAL_PRIORITY } from "./task-view";

/** `<input type="datetime-local">` gives local wall time without a zone; the API wants an instant. */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A whole number as typed in the raw priority field; null for anything else, so the form can say so. */
export function parsePriority(text: string): number | null {
  const trimmed = text.trim();
  return /^-?\d{1,9}$/.test(trimmed) ? Number(trimmed) : null;
}

export interface TaskForm {
  description: string;
  /** The priority as text: the chosen name's number, or what was typed in the raw field. */
  priority: string;
  /** `datetime-local` text; empty for "as soon as possible". */
  notBefore: string;
}

export const EMPTY_TASK_FORM: TaskForm = { description: "", priority: String(NORMAL_PRIORITY), notBefore: "" };

/** Why the form cannot be sent yet, or null when it can. */
export function taskFormProblem(form: TaskForm): string | null {
  if (form.description.trim() === "") return "Say what the Dot should do.";
  if (parsePriority(form.priority) === null) return "The priority is a whole number.";
  if (form.notBefore !== "" && localInputToIso(form.notBefore) === undefined) return "That is not a date and time.";
  return null;
}

/** The request for a form that has no problem. A normal priority and no date are left out: the API's defaults say the same. */
export function taskRequest(form: TaskForm): CreateTaskRequest {
  const request: CreateTaskRequest = { description: form.description.trim() };
  const priority = parsePriority(form.priority);
  if (priority !== null && priority !== NORMAL_PRIORITY) request.priority = priority;
  const when = localInputToIso(form.notBefore);
  if (when !== undefined) request.scheduled_at = when;
  return request;
}
