/**
 * Whether the page can still hear the control plane, and what to tell the person when it cannot. Two things say so: the
 * live stream (it drops when the control plane stops or the connection is lost, and the SDK reconnects by itself) and
 * the health check the shell makes every 30 seconds. Either is enough to say that what is on the page may be out of date.
 */
import type { StreamStatus } from "../components/events";

export interface Offline {
  title: string;
  detail: string;
}

export function offlineOf(input: { stream: StreamStatus; streamDetail: string; apiError: unknown }): Offline | null {
  const apiError = input.apiError === null || input.apiError === undefined ? "" : input.apiError instanceof Error ? input.apiError.message : String(input.apiError);
  if (input.stream === "closed") {
    return {
      title: "Live updates have stopped",
      detail: `${input.streamDetail ? `${input.streamDetail}. ` : ""}What is on the page may be out of date: reload it to connect again.`,
    };
  }
  if (input.stream === "reconnecting" || apiError !== "") {
    return {
      title: "The control plane does not answer",
      detail: `${input.stream === "reconnecting" ? input.streamDetail : apiError}${input.streamDetail || apiError ? ". " : ""}What is on the page may be out of date; it connects again by itself.`,
    };
  }
  return null;
}
