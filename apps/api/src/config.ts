/** Process settings of invisible-dots-server: listen address, API token, server.env. */
import { readFile } from "node:fs/promises";
import { DEFAULT_LISTEN, ENV, hostPaths } from "@invisible-dots/shared";

/** The same variable the CLI and the web server read, so one value configures all three. */
export const API_TOKEN_ENV = ENV.TOKEN;

/** Tokens shorter than this are refused: the API controls VMs and secrets. */
export const MIN_TOKEN_LENGTH = 16;

export interface ListenAddress {
  host: string;
  port: number;
}

/** Parse `host:port`, `[v6]:port` or a bare port (which binds 127.0.0.1). */
export function parseListen(value: string = DEFAULT_LISTEN): ListenAddress {
  const text = value.trim();
  let host = "127.0.0.1";
  let portText = text;
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(text);
  if (v6) {
    host = v6[1]!;
    portText = v6[2]!;
  } else if (text.includes(":")) {
    const at = text.lastIndexOf(":");
    host = text.slice(0, at);
    portText = text.slice(at + 1);
  }
  const port = Number(portText);
  if (!host || !/^\d+$/.test(portText) || port < 0 || port > 65535) {
    throw new Error(`${ENV.LISTEN} must look like "127.0.0.1:8787", got "${value}"`);
  }
  return { host, port };
}

function checkToken(token: string, origin: string): string {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`the API token from ${origin} is shorter than ${MIN_TOKEN_LENGTH} characters`);
  }
  return token;
}

/** `INVISIBLE_DOTS_TOKEN`, else the first line of `<config dir>/api.token`. */
export async function loadApiToken(env: Record<string, string | undefined> = process.env): Promise<string> {
  const fromEnv = env[API_TOKEN_ENV]?.trim();
  if (fromEnv) return checkToken(fromEnv, API_TOKEN_ENV);
  const path = hostPaths(env).apiToken;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read the API token at ${path} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); ` +
        `create it with "openssl rand -hex 32 > ${path} && chmod 600 ${path}" or set ${API_TOKEN_ENV}`,
      { cause: error },
    );
  }
  return checkToken(text.split(/\r?\n/)[0]!.trim(), path);
}

/**
 * KEY=VALUE lines of `server.env` (the systemd EnvironmentFile), for a server
 * started by hand. Values already in the environment win. Quotes around a
 * value are removed; `#` starts a comment line.
 */
export async function readServerEnv(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[match[1]!] = value;
  }
  return out;
}
