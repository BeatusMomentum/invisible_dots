// Next runs register() once when the server starts. Under
// `invisible-dots server` it ties the server's life to its parent's (see
// lib/parent.ts); started any other way (next dev) there is no parent to follow.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ENV } = await import("@invisible-dots/shared/browser");
  const { exitWhenParentGone, parentPidFrom } = await import("./lib/parent");
  const parentPid = parentPidFrom(process.env[ENV.WEB_PARENT_PID]);
  if (parentPid === undefined) return;
  const { processExists } = await import("@invisible-dots/shared/process");
  exitWhenParentGone(parentPid, { exists: processExists, onGone: () => process.exit(0) });
}
