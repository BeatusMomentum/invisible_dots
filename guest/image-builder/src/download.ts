/**
 * Downloads pinned files and proves they are the pinned bytes, with Node's
 * own fetch and crypto, so no curl or sha256sum is needed on any host.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { replaceFile } from "@invisible-dots/shared";

export type Fetch = typeof globalThis.fetch;

export class DownloadError extends Error {
  /** The HTTP status the server answered with; undefined for every failure that is not such an answer. */
  readonly status?: number;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "DownloadError";
    if (options?.status !== undefined) this.status = options.status;
  }
}

/** The SHA-256 of a file, streamed: cloud images are hundreds of MiB. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * The SHA-256 a `sha256sum`-style list gives for `entry`, accepting both
 * "hash  name" and "hash *name" (binary mode), which the Ubuntu, Node and uv
 * lists use between them. Undefined when the list has no such line.
 */
export function checksumFromSums(text: string, entry: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2] === entry) return match[1]!.toLowerCase();
  }
  return undefined;
}

export interface VerifiedFile {
  url: string;
  sha256: string;
  /** Optional: the published checksum list must also name `sha256` for `sumsEntry`. */
  sumsUrl?: string;
  sumsEntry?: string;
}

export interface FetchVerifiedOptions {
  fetch?: Fetch;
  log?: (line: string) => void;
  /** Abort a transfer that delivers no bytes for this long. Default 60 s. */
  idleTimeoutMs?: number;
  /** Attempts on network errors and 5xx answers. Default 3. */
  attempts?: number;
  /** Pause between attempts. Default 5 s. */
  retryDelayMs?: number;
}

export interface FetchVerifiedResult {
  path: string;
  /** True when a file already at `dest` matched the pin and nothing was downloaded. */
  cached: boolean;
  bytes: number;
}

/**
 * Makes `dest` exist with exactly `file.sha256`.
 *
 * A cached copy is re-hashed before it is trusted, because a cache that was
 * truncated or edited would otherwise go into an image unnoticed. When the
 * project publishes a checksum list, it must agree with the pin BEFORE the
 * download starts, so a typo in the pin and an upstream change both stop the
 * build instead of wasting the transfer. The bytes land in a temporary file
 * that is renamed only after its hash matched: an interrupted or wrong
 * download never looks finished.
 */
export async function fetchVerified(file: VerifiedFile, dest: string, options: FetchVerifiedOptions = {}): Promise<FetchVerifiedResult> {
  const log = options.log ?? (() => undefined);
  const name = basename(dest);
  const existing = await stat(dest).catch(() => undefined);
  if (existing?.isFile()) {
    if ((await sha256File(dest)) === file.sha256) {
      log(`${name}: cached copy matches its pin`);
      return { path: dest, cached: true, bytes: existing.size };
    }
    log(`${name}: cached copy does not match its pin; downloading it again`);
    await rm(dest, { force: true });
  }

  if (file.sumsUrl !== undefined) {
    const entry = file.sumsEntry ?? name;
    const sums = await withRetries(options, () => fetchText(file.sumsUrl!, options));
    const published = checksumFromSums(sums, entry);
    if (published === undefined) throw new DownloadError(`${file.sumsUrl} has no line for ${entry}`);
    if (published !== file.sha256) {
      throw new DownloadError(`${file.sumsUrl} lists ${published} for ${entry} but the pin is ${file.sha256}: refusing to continue`);
    }
  }

  log(`${name}: downloading ${file.url}`);
  await mkdir(dirname(dest), { recursive: true });
  const { sha256, bytes, temporary } = await withRetries(options, () => downloadTo(file.url, dest, options));
  if (sha256 !== file.sha256) {
    await rm(temporary, { force: true });
    throw new DownloadError(`${file.url} hashes to ${sha256}, but the pin is ${file.sha256}`);
  }
  await replaceFile(temporary, dest);
  log(`${name}: verified (${bytes} bytes, sha256 ${sha256})`);
  return { path: dest, cached: false, bytes };
}

/** Errors worth another attempt: the network, a stall, a 5xx. A 4xx or a hash mismatch is not. */
class RetryableError extends DownloadError {}

async function withRetries<T>(options: FetchVerifiedOptions, attempt: () => Promise<T>): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delay = options.retryDelayMs ?? 5000;
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof RetryableError) || i >= attempts) throw error;
      options.log?.(`${error.message}; retrying (${i + 1} of ${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * fetch with an idle timeout rather than a total one: a 600 MiB image on a
 * slow line legitimately takes long, a connection that stopped sending does not.
 */
async function openResponse(
  url: string,
  options: FetchVerifiedOptions,
): Promise<{ response: Response; signal: AbortSignal; touch: () => void; done: () => void }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const idleMs = options.idleTimeoutMs ?? 60_000;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new RetryableError(`${url}: no data for ${idleMs} ms`)), idleMs);
  };
  const done = () => clearTimeout(timer);
  touch();
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
  } catch (error) {
    done();
    throw asRetryable(url, error, controller.signal);
  }
  if (!response.ok) {
    done();
    await response.body?.cancel().catch(() => undefined);
    const message = `${url}: HTTP ${response.status}`;
    const failure = { status: response.status };
    throw response.status >= 500 ? new RetryableError(message, failure) : new DownloadError(message, failure);
  }
  return { response, signal: controller.signal, touch, done };
}

function asRetryable(url: string, error: unknown, signal: AbortSignal): Error {
  if (signal.aborted && signal.reason instanceof RetryableError) return signal.reason;
  if (error instanceof DownloadError) return error;
  return new RetryableError(`${url}: ${(error as Error).message ?? String(error)}`, { cause: error });
}

/** A small text file, with the same retries as a download; an HTTP error answer is a DownloadError with its status. */
export function fetchTextWithRetries(url: string, options: FetchVerifiedOptions = {}): Promise<string> {
  return withRetries(options, () => fetchText(url, options));
}

async function fetchText(url: string, options: FetchVerifiedOptions): Promise<string> {
  const { response, done } = await openResponse(url, options);
  try {
    return await response.text();
  } finally {
    done();
  }
}

async function downloadTo(url: string, dest: string, options: FetchVerifiedOptions): Promise<{ sha256: string; bytes: number; temporary: string }> {
  const { response, signal, touch, done } = await openResponse(url, options);
  const temporary = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.part`;
  const handle = await open(temporary, "wx", 0o644);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    if (!response.body) throw new DownloadError(`${url}: the answer has no body`);
    for await (const chunk of response.body) {
      touch();
      hash.update(chunk);
      await handle.write(chunk);
      bytes += chunk.byteLength;
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw asRetryable(url, error, signal);
  } finally {
    done();
  }
  await handle.close();
  return { sha256: hash.digest("hex"), bytes, temporary };
}
