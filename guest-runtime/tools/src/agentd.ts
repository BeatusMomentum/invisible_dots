import {
  AGENTD_ROUTES,
  GUEST_PATHS,
  httpOverSocket,
  type ExecAnswer,
  type ExecRequest,
  type FileListAnswer,
  type HealthAnswer,
  type SocketResponse,
  type SystemAnswer,
} from "@invisible-dots/shared";

export interface AgentdRequestOptions {
  signal?: AbortSignal;
}

/** dot-agentd as the agent reaches it on `agentd.sock` (section 5.2, without the token). */
export interface AgentdClient {
  health(options?: AgentdRequestOptions): Promise<HealthAnswer>;
  system(options?: AgentdRequestOptions): Promise<SystemAnswer>;
  exec(request: ExecRequest, options?: AgentdRequestOptions): Promise<ExecAnswer>;
  readFile(path: string, options?: AgentdRequestOptions): Promise<Buffer>;
  writeFile(path: string, content: string | Uint8Array, options?: AgentdRequestOptions): Promise<void>;
  listFiles(path: string, options?: AgentdRequestOptions): Promise<FileListAnswer>;
  /** PNG of display `:0`. */
  screenshot(options?: AgentdRequestOptions): Promise<Buffer>;
}

/** A non-2xx answer from dot-agentd, with its `{ error, message }` body when it sent one. */
export class AgentdError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentdError";
  }
}

export interface SocketAgentdClientOptions {
  /** Default `/run/invisible-dots/agentd.sock`. */
  socketPath?: string;
  /** Timeout of every request but exec. Default 60 s. */
  timeoutMs?: number;
  /** Added to an exec's own `timeout_ms`, for agentd to kill the command and answer. Default 15 s. */
  execGraceMs?: number;
  /** Request timeout of an exec without `timeout_ms`. Default 1 hour. */
  execDefaultTimeoutMs?: number;
}

export class SocketAgentdClient implements AgentdClient {
  readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly execGraceMs: number;
  private readonly execDefaultTimeoutMs: number;

  constructor(options: SocketAgentdClientOptions = {}) {
    this.socketPath = options.socketPath ?? GUEST_PATHS.agentdSocket;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.execGraceMs = options.execGraceMs ?? 15_000;
    this.execDefaultTimeoutMs = options.execDefaultTimeoutMs ?? 60 * 60_000;
  }

  private async send(
    method: string,
    path: string,
    options: AgentdRequestOptions & { body?: string | Uint8Array; contentType?: string; timeoutMs?: number },
  ): Promise<SocketResponse> {
    const response = await httpOverSocket(this.socketPath, {
      method,
      path,
      headers: options.contentType ? { "content-type": options.contentType } : {},
      ...(options.body !== undefined ? { body: options.body } : {}),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status >= 200 && response.status < 300) return response;

    let code = `http_${response.status}`;
    let detail = response.body.toString("utf8").slice(0, 500).trim();
    try {
      const parsed = JSON.parse(response.body.toString("utf8")) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Not JSON: the raw body is the detail.
    }
    throw new AgentdError(response.status, code, `dot-agentd ${method} ${path.split("?")[0]} answered ${response.status} ${code}${detail ? `: ${detail}` : ""}`);
  }

  private async json<T>(method: string, path: string, options: Parameters<SocketAgentdClient["send"]>[2] = {}): Promise<T> {
    const response = await this.send(method, path, options);
    try {
      return JSON.parse(response.body.toString("utf8")) as T;
    } catch {
      throw new AgentdError(response.status, "bad_answer", `dot-agentd ${method} ${path.split("?")[0]} answered something that is not JSON`);
    }
  }

  private static withPath(route: string, path: string): string {
    return `${route}?path=${encodeURIComponent(path)}`;
  }

  health(options: AgentdRequestOptions = {}): Promise<HealthAnswer> {
    return this.json("GET", AGENTD_ROUTES.health, options);
  }

  system(options: AgentdRequestOptions = {}): Promise<SystemAnswer> {
    return this.json("GET", AGENTD_ROUTES.system, options);
  }

  exec(request: ExecRequest, options: AgentdRequestOptions = {}): Promise<ExecAnswer> {
    const timeoutMs = request.timeout_ms === undefined ? this.execDefaultTimeoutMs : request.timeout_ms + this.execGraceMs;
    return this.json("POST", AGENTD_ROUTES.exec, {
      ...options,
      body: JSON.stringify(request),
      contentType: "application/json",
      timeoutMs,
    });
  }

  async readFile(path: string, options: AgentdRequestOptions = {}): Promise<Buffer> {
    return (await this.send("GET", SocketAgentdClient.withPath(AGENTD_ROUTES.files, path), options)).body;
  }

  async writeFile(path: string, content: string | Uint8Array, options: AgentdRequestOptions = {}): Promise<void> {
    await this.send("PUT", SocketAgentdClient.withPath(AGENTD_ROUTES.files, path), {
      ...options,
      body: content,
      contentType: "application/octet-stream",
    });
  }

  listFiles(path: string, options: AgentdRequestOptions = {}): Promise<FileListAnswer> {
    return this.json("GET", SocketAgentdClient.withPath(AGENTD_ROUTES.filesList, path), options);
  }

  async screenshot(options: AgentdRequestOptions = {}): Promise<Buffer> {
    return (await this.send("GET", AGENTD_ROUTES.screenshot, options)).body;
  }
}
