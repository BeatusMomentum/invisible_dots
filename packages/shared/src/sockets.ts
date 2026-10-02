/**
 * HTTP over a local socket: the host talks to a Dot through its vsock bridge
 * (`/run/invisible-dots/dot-<id>.sock`), and the agent talks to dot-agentd
 * through `agentd.sock`. Node-only; the web client must not import this file.
 */
import { randomBytes } from "node:crypto";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh socket path for a test server. Windows has no unix sockets that
 * node:http can serve on everywhere, so it gets a named pipe; elsewhere a path
 * under the temp directory, kept short because unix socket paths are limited
 * to about 104 bytes.
 */
export function testSocketPath(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24);
  const unique = `${process.pid}-${randomBytes(4).toString("hex")}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\idots-${safe}-${unique}`;
  return join(tmpdir(), `idots-${safe}-${unique}.sock`);
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
          ? " (no socket at that path: is the VM or the bridge running?)"
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
