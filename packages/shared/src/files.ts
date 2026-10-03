/**
 * Files on the host that hold secrets (master.key, api.token) and the
 * directories around them. Node-only.
 *
 * Platform difference (architecture section 1.1): the 0600 / 0700 permission
 * bits are enforced by Linux, while Windows ignores them apart from the
 * read-only flag, and a directory there inherits the ACL of its parent: at a
 * drive root (D:\dots, which doctor's own fix for a full disk leads to) that
 * lets every local account read and change it. So a private file or
 * directory is made private by `restrictToOwner`, the one function that
 * differs: chmod on Linux, an ACL with the current user alone on Windows.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runProcess } from "./run-process.js";

export const SECRET_FILE_MODE = 0o600;
export const SECRET_DIR_MODE = 0o700;

/** Whether the operating system honours POSIX permission bits on files it creates. */
export function permissionBitsEnforced(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** The security identifier of the user this process runs as, from `whoami /user` (Windows only). */
export async function currentUserSid(env: Record<string, string | undefined> = process.env): Promise<string> {
  const whoami = join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "whoami.exe");
  const answer = await runProcess(whoami, ["/user", "/fo", "csv", "/nh"], { timeoutMs: 30_000 });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(answer.stdout.trim())?.[1];
  if (answer.code !== 0 || !sid) {
    throw new Error(`cannot tell which user this is (whoami /user: ${answer.startError?.message ?? (answer.stderr.trim() || `exit code ${answer.code}`)})`);
  }
  return sid;
}

/**
 * Make `path` readable and writable by the user this process runs as and
 * nobody else, the same promise on both hosts. Linux: mode 0600 for a file,
 * 0700 for a directory. Windows, which ignores those bits: the inherited
 * entries are removed and the current user alone gets full control, also
 * passed on to whatever the directory will contain.
 */
export async function restrictToOwner(
  path: string,
  kind: "file" | "directory",
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (permissionBitsEnforced()) {
    await chmod(path, kind === "file" ? SECRET_FILE_MODE : SECRET_DIR_MODE);
    return;
  }
  const sid = await currentUserSid(env);
  const grant = kind === "directory" ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  const icacls = join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "icacls.exe");
  const answer = await runProcess(icacls, [path, "/inheritance:r", "/grant:r", grant], { timeoutMs: 30_000 });
  if (answer.code !== 0) {
    const why = answer.startError?.message ?? ((answer.stdout.trim() || answer.stderr.trim()) || `exit code ${answer.code}`);
    throw new Error(`cannot make ${path} private to this user: icacls failed (${why})`);
  }
}

/**
 * Creates a directory and its missing parents. `mode` applies only to the
 * directories this call creates; an existing one keeps its bits.
 */
export async function ensureDir(path: string, mode?: number): Promise<void> {
  await mkdir(path, mode === undefined ? { recursive: true } : { recursive: true, mode });
}

/**
 * Creates a directory that only this user may open (the data directory, its
 * config/ and db/), and makes an existing one so: a home moved by hand, or
 * created before this rule, is brought in line at every start.
 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: SECRET_DIR_MODE });
  await restrictToOwner(path, "directory");
}

/**
 * Writes a secret with mode 0600, creating its directory with mode 0700.
 *
 * The bytes go to a new file in the same directory that is renamed over the
 * target, so a crash leaves either the old secret or the new one, never a
 * truncated key, and a target that was readable by others is replaced by a
 * file that never was.
 */
export async function writeSecretFile(path: string, bytes: Uint8Array | string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", SECRET_FILE_MODE);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // open() applies the umask, which can only remove bits, and on Windows the
    // file inherits its directory's ACL: made private before it is renamed in place.
    await restrictToOwner(temporary, "file");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The secret's bytes, or undefined when the file does not exist (so callers can create it on first start). */
export async function readSecretFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
