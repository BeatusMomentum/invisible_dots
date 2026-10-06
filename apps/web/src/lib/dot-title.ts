/**
 * The title of a Dot's page: the tab and then the Dot, "Chat - fares - invisible_dots", so a person with several Dots
 * open in several tabs (or reading the browser's history) can tell them apart. Next builds a page's title on the server,
 * so the Dot's name is asked of the control plane there, with the web server's own credential, and only for a request
 * that reaches this server (it listens where the Dots' VMs cannot reach it, section 9.7). Anything that goes wrong leaves the title the tab alone.
 */
import type { Metadata } from "next";
import { apiBaseUrl, loadApiToken } from "./proxy";

/** How long the page waits for the control plane's answer before it settles for the title without the Dot's name. */
const NAME_TIMEOUT_MS = 2000;

export async function dotPageTitle(dotIdOrName: string, tab: string): Promise<Metadata> {
  try {
    const token = await loadApiToken();
    const answer = await fetch(`${apiBaseUrl()}/api/dots/${encodeURIComponent(dotIdOrName)}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(NAME_TIMEOUT_MS),
    });
    if (!answer.ok) return { title: tab };
    const { name } = (await answer.json()) as { name?: unknown };
    return { title: typeof name === "string" && name !== "" ? `${tab} - ${name}` : tab };
  } catch {
    return { title: tab };
  }
}
