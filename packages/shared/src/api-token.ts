/**
 * The API token as every reader sees it (architecture section 9.6): the
 * server, the command and the web server all read it here, so a token file
 * one of them accepts is accepted by all three. Node-only.
 */
import { hostPaths, type HostPaths } from "./paths.js";
import { ENV } from "./protocol.js";
import { readSecretFile } from "./files.js";

/** Tokens shorter than this are refused: the API controls VMs and secrets. */
export const MIN_API_TOKEN_LENGTH = 16;

/** The token cannot be used: unreadable, empty or too short. The message names where it came from. */
export class ApiTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiTokenError";
  }
}

export interface ApiToken {
  value: string;
  /** Where it came from: the environment variable's name or the file's path. */
  origin: string;
}

function checked(value: string, origin: string): ApiToken {
  if (value === "") throw new ApiTokenError(`the API token from ${origin} is empty`);
  if (value.length < MIN_API_TOKEN_LENGTH) {
    throw new ApiTokenError(`the API token from ${origin} is shorter than ${MIN_API_TOKEN_LENGTH} characters`);
  }
  return { value, origin };
}

/**
 * INVISIBLE_DOTS_TOKEN when set, else the first line of `config/api.token`,
 * trimmed (a note or an old token on a later line is ignored). Undefined
 * when the file does not exist yet: the server creates it at its first
 * start, a client says to start the server. Throws ApiTokenError for a
 * token that cannot be used.
 */
export async function readApiToken(
  env: Record<string, string | undefined> = process.env,
  paths: HostPaths = hostPaths(env),
): Promise<ApiToken | undefined> {
  const fromEnv = env[ENV.TOKEN]?.trim();
  if (fromEnv) return checked(fromEnv, ENV.TOKEN);
  const path = paths.apiTokenPath;
  let bytes: Buffer | undefined;
  try {
    bytes = await readSecretFile(path);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    throw new ApiTokenError(`cannot read the API token ${path} (${reason}); set ${ENV.TOKEN} or make the file readable`);
  }
  if (bytes === undefined) return undefined;
  return checked(bytes.toString("utf8").split(/\r?\n/)[0]!.trim(), path);
}
