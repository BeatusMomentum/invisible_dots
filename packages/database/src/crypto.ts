/**
 * AES-256-GCM under the host master key (architecture sections 3.2 and 9.1).
 * The stored form is `iv (12 bytes) || tag (16 bytes) || ciphertext`. The
 * associated data binds a ciphertext to the row it belongs to, so a value
 * copied into another row (another Dot's secret, another Dot's token) fails
 * to decrypt instead of being accepted.
 *
 * Reading and creating master.key is the server's job (apps/api config.ts,
 * through the shared secret-file helpers); this file only uses the key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

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
