/**
 * The browser's API client: the SDK pointed at this web server. The server
 * mirrors the control plane under the same `/api/...` paths and adds the
 * token itself (`src/app/api/[...path]/route.ts`), so the client sends none
 * and the token never reaches the browser.
 */
import { ApiError, InvisibleDotsClient } from "@invisible-dots/sdk";

export { ApiError };

export type ComputerAction = "start" | "stop" | "reboot";

// fetch is looked up at each call, not bound once: a test (or a polyfill) that replaces it later is the one used.
export const api = new InvisibleDotsClient({ baseUrl: "", fetch: (input, init) => fetch(input, init) });

export function computerAction(client: InvisibleDotsClient, dotId: string, action: ComputerAction): Promise<unknown> {
  switch (action) {
    case "start":
      return client.startComputer(dotId);
    case "stop":
      return client.stopComputer(dotId);
    case "reboot":
      return client.rebootComputer(dotId);
  }
}

export interface ErrorIssue {
  path: string;
  message: string;
}

/** The field-level problems of a validation error (`details: [{ path, message }]`), for forms to list. */
export function errorIssues(error: unknown): ErrorIssue[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return [];
  return error.details.flatMap((item: unknown): ErrorIssue[] => {
    if (typeof item === "string") return [{ path: "", message: item }];
    if (typeof item !== "object" || item === null) return [];
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (typeof message !== "string") return [];
    const where = Array.isArray(path) ? path.join(".") : typeof path === "string" ? path : "";
    return [{ path: where, message }];
  });
}
