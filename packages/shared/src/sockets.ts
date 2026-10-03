/**
 * HTTP over a local unix socket: inside the guest the agent talks to
 * dot-agentd through `agentd.sock` (section 4.2). The host reaches a guest
 * over TCP instead (section 5.1). Node-only; the web client must not import
 * this file.
 */
import { randomBytes } from "node:crypto";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where Windows keeps named pipes; a path under it is not a file on any disk. */
const NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * A fresh socket path for a test server. The guest code that serves local
 * sockets runs only on Linux, but its tests also run on a Windows developer
 * host, where Node's `listen(path)` always makes a named pipe (libuv has no
 * AF_UNIX server on Windows), so the path has to be a pipe name there. This
 * is test support, not a product code path, and it is the only place that
 * decides between the two; everything else asks `socketIsAFile`. Elsewhere
 * the path is under the temp directory, kept short because unix socket paths
 * are limited to about 104 bytes.
 */
export function testSocketPath(name: string, platform: NodeJS.Platform = process.platform): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24);
  const unique = `${process.pid}-${randomBytes(4).toString("hex")}`;
  if (platform === "win32") return `${NAMED_PIPE_PREFIX}idots-${safe}-${unique}`;
  return join(tmpdir(), `idots-${safe}-${unique}.sock`);
}

/**
 * Whether a socket path names a file that outlives its server (a unix
 * socket, which has to be removed before listening again and can carry
 * permission bits), rather than a Windows named pipe, which vanishes with its
 * last handle and has neither. Decided from the path, so code that serves a
 * socket needs no platform check.
 */
export function socketIsAFile(path: string): boolean {
  return !path.startsWith(NAMED_PIPE_PREFIX);
}

export interface SocketRequest {
  method?: string;
  /** Path and query, e.g. `/v1/files?path=workspace%2Fa.txt`. */
  path: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Uint8Array;
  /** Fail when no complete answer arrived within this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SocketResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class SocketRequestError extends Error {
  readonly socketPath: string;
  readonly code: string | undefined;

  constructor(message: string, socketPath: string, code?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SocketRequestError";
    this.socketPath = socketPath;
    this.code = code;
  }
}

/** One HTTP/1.1 request over a unix socket or named pipe; the whole answer body is buffered. */
export function httpOverSocket(socketPath: string, options: SocketRequest): Promise<SocketResponse> {
  const method = (options.method ?? "GET").toUpperCase();
  const body = options.body === undefined ? undefined : Buffer.from(options.body);
  const headers: OutgoingHttpHeaders = { host: "localhost", ...options.headers };
  if (body !== undefined) headers["content-length"] = body.length;

  return new Promise<SocketResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: SocketRequestError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      req.destroy();
      reject(error);
    };
    const describe = `${method} ${options.path} over ${socketPath}`;

    // Callers on the same socket do not share connections: a bridge that just
    // came up is cheaper to dial again than to debug a stale keep-alive socket.
    const req = request({ socketPath, method, path: options.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", (error: NodeJS.ErrnoException) =>
        fail(new SocketRequestError(`${describe}: answer interrupted: ${error.message}`, socketPath, error.code, error)),
      );
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });

    req.on("error", (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === "ENOENT"
          ? " (no socket at that path: is the process that serves it running?)"
          : error.code === "ECONNREFUSED"
            ? " (nothing is listening on the socket)"
            : "";
      fail(new SocketRequestError(`${describe} failed: ${error.message}${hint}`, socketPath, error.code, error));
    });

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => fail(new SocketRequestError(`${describe} timed out after ${options.timeoutMs} ms`, socketPath, "ETIMEDOUT")),
            options.timeoutMs,
          );

    const onAbort = () => fail(new SocketRequestError(`${describe} aborted`, socketPath, "ABORT_ERR"));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    req.end(body);
  });
}
