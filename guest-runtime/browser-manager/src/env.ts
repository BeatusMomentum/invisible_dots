import { allowlistedEnvironment, BASE_CHILD_ENV_VARS, ENV } from "@invisible-dots/shared";

/**
 * Variables an identity's MCP server may inherit from the agent. The agent
 * holds the OpenRouter key in memory and its environment may carry other
 * secrets, so the child gets an allowlist (the shared filter of
 * packages/shared), never a copy with things removed. Everything the browser
 * layer needs to know about the identity is set explicitly by
 * `childEnvironment`.
 */
export const INHERITED_ENV_VARS: readonly string[] = [
  ...BASE_CHILD_ENV_VARS,
  "SHELL",
  "TERM",
  "XDG_RUNTIME_DIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XAUTHORITY",
  // Set by the golden image when the engine is installed outside the cache.
  "STEALTHFOX_BINARY",
];

export interface ChildEnvironmentInput {
  identityId: string;
  profileDir: string;
  mcpHome: string;
  display: string;
  proxy?: string | undefined;
}

/** The environment of one identity's `invisible-playwright-mcp` process (section 6). */
export function childEnvironment(
  input: ChildEnvironmentInput,
  base: Record<string, string | undefined>,
): Record<string, string> {
  const env = allowlistedEnvironment(base, INHERITED_ENV_VARS);
  env[ENV.MCP_HOME] = input.mcpHome;
  env[ENV.MCP_SESSION_ID] = input.identityId;
  env[ENV.PROFILE_DIR] = input.profileDir;
  env[ENV.HEADLESS] = "0";
  env[ENV.DISPLAY] = input.display;
  if (input.proxy) env[ENV.PROXY] = input.proxy;
  return env;
}
