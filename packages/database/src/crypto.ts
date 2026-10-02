/**
 * AES-256-GCM under the host master key (architecture sections 3.2 and 9.1).
 * The stored form is `iv (12 bytes) || tag (16 bytes) || ciphertext`. The
 * associated data binds a ciphertext to the row it belongs to, so a value
 * copied into another row (another Dot's secret, another Dot's token) fails
 * to decrypt instead of being accepted.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostPaths } from "@invisible-dots/shared";

export const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const MASTER_KEY_ENV = "INVISIBLE_DOTS_MASTER_KEY";

export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error(`the master key must be ${MASTER_KEY_BYTES} bytes, got ${key.length}`);
    }
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string, associatedData: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(sealed: Uint8Array, associatedData: string): string {
    const data = Buffer.from(sealed);
    if (data.length < IV_BYTES + TAG_BYTES) throw new Error("encrypted value is too short to be valid");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, data.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    } catch (error) {
      throw new Error("cannot decrypt a stored value: wrong master key or the value was tampered with", {
        cause: error,
      });
    }
  }
}

function parseHexKey(text: string, origin: string): Buffer {
  const hex = text.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${origin} must be ${MASTER_KEY_BYTES * 2} hexadecimal characters`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * The master key: `INVISIBLE_DOTS_MASTER_KEY` (hex, meant for tests and
 * containers) wins over `<config dir>/master.key`. The file holds 32 raw
 * bytes as the installer writes it; 64 hex characters are accepted too, so
 * a key typed by hand works.
 */
export async function loadMasterKey(env: Record<string, string | undefined> = process.env): Promise<Buffer> {
  const fromEnv = env[MASTER_KEY_ENV];
  if (fromEnv) return parseHexKey(fromEnv, MASTER_KEY_ENV);
  const path = hostPaths(env).masterKey;
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    throw new Error(
      `cannot read the master key at ${path} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); ` +
        `create it with "head -c 32 /dev/urandom > ${path} && chmod 600 ${path}" or set ${MASTER_KEY_ENV}`,
      { cause: error },
    );
  }
  if (raw.length === MASTER_KEY_BYTES) return raw;
  return parseHexKey(raw.toString("utf8"), path);
}
