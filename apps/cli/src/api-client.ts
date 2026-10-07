/** How the CLI reaches the API: its URL and its token, from the environment or INVISIBLE_DOTS_HOME. */
import { InvisibleDotsClient } from "@invisible-dots/sdk";
import { ApiTokenError, DEFAULT_LISTEN, ENV, hostPaths, readApiToken } from "@invisible-dots/shared";

export const DEFAULT_URL = `http://${DEFAULT_LISTEN}`;

/** No usable token: the person has to start the server once or set the variable. */
export class AuthSetupError extends Error {}

export function apiUrl(env: Record<string, string | undefined>): string {
  return env[ENV.URL]?.trim() || DEFAULT_URL;
}

/** The token as the server reads it (shared readApiToken): INVISIBLE_DOTS_TOKEN, else the first line of api.token. */
export async function resolveToken(env: Record<string, string | undefined>): Promise<string> {
  let token;
  try {
    token = await readApiToken(env);
  } catch (error) {
    if (error instanceof ApiTokenError) throw new AuthSetupError(`no usable API token: ${error.message}`);
    throw error;
  }
  if (!token) {
    const path = hostPaths(env).apiTokenPath;
    throw new AuthSetupError(`no API token: ${path} does not exist yet; start the server once (invisible-dots server) or set ${ENV.TOKEN}`);
  }
  return token.value;
}

export async function connectApi(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<InvisibleDotsClient> {
  return new InvisibleDotsClient({ baseUrl: apiUrl(env), token: await resolveToken(env), fetch: fetchImpl });
}
