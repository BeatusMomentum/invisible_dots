import type { SecretBox } from "./crypto.js";
import type { Queryable } from "./rows.js";

export const GLOBAL_SCOPE = "global";
export const OPENROUTER_KEY_NAME = "openrouter_api_key";

const aad = (scope: string, name: string) => `secret:${scope}:${name}`;

export class SecretsRepository {
  constructor(
    private readonly q: Queryable,
    private readonly box: SecretBox,
  ) {}

  async put(scope: string, name: string, value: string): Promise<void> {
    await this.q.query(
      `INSERT INTO secrets (scope, name, value_enc) VALUES ($1, $2, $3)
       ON CONFLICT (scope, name) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
      [scope, name, this.box.encrypt(value, aad(scope, name))],
    );
  }

  async get(scope: string, name: string): Promise<string | null> {
    const { rows } = await this.q.query<{ value_enc: Uint8Array }>(
      "SELECT value_enc FROM secrets WHERE scope = $1 AND name = $2",
      [scope, name],
    );
    return rows[0] ? this.box.decrypt(rows[0].value_enc, aad(scope, name)) : null;
  }

  async delete(scope: string, name: string): Promise<boolean> {
    const { rowCount } = await this.q.query("DELETE FROM secrets WHERE scope = $1 AND name = $2", [scope, name]);
    return (rowCount ?? 0) > 0;
  }

  /** The Dot's own OpenRouter key, else the global one (section 9.1). */
  async openRouterKey(dotId: string): Promise<string | null> {
    return (await this.get(dotId, OPENROUTER_KEY_NAME)) ?? (await this.get(GLOBAL_SCOPE, OPENROUTER_KEY_NAME));
  }
}
