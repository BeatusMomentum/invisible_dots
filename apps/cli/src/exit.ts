/** Exit codes of `invisible-dots`: what went wrong, for scripts. */
export const EXIT = {
  ok: 0,
  /** The server answered with an error, a doctor check is not ok, or a setup step failed. */
  failed: 1,
  /** Wrong command line. */
  usage: 2,
  /** The server could not be reached. */
  unreachable: 3,
  /** No API token, or the server refused it. */
  auth: 4,
  /** setup enabled something that works only after Windows restarts. */
  restart: 5,
} as const;
