/**
 * The browser's API client: the SDK pointed at this web server. The server
 * mirrors the control plane under the same `/api/...` paths and adds the
 * token itself (`src/app/api/[...path]/route.ts`), so the client sends none
 * and the token never reaches the browser.
 */
import { ApiError, InvisibleDotsClient } from "@invisible-dots/sdk";

export { ApiError };

export type ComputerAction = "start" | "stop" | "reboot";

/** The login page, which asks for the token and therefore never needs one. */
export const LOGIN_PATH = "/login";

/** Whether `pathname` is the login page. */
export function onLoginPage(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`);
}

/** Where the browser is, and how to send it elsewhere. */
export interface PageLocation {
  readonly pathname: string;
  assign(url: string): void;
}

/**
 * A fetch that sends the page to /login when this server refuses a request for
 * want of a session (401, header `x-invisible-dots-login: required`) and
 * hands every answer to the caller unchanged. The login page itself stays
 * where it is: it has no session by definition, so a redirect from there
 * would only load the page again, forever.
 *
 * `location` is the page the request was made from; it is null where there is
 * no page (server rendering), and then nothing is redirected.
 */
export function fetchOrLogin(
  location: () => PageLocation | null,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status === 401 && response.headers.get("x-invisible-dots-login") === "required") {
      const page = location();
      if (page && !onLoginPage(page.pathname)) {
        page.assign(`${LOGIN_PATH}?next=${encodeURIComponent(page.pathname)}`);
      }
    }
    return response;
  };
}

export const api = new InvisibleDotsClient({
  baseUrl: "",
  fetch: fetchOrLogin(() => (typeof window === "undefined" ? null : window.location)),
});

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
