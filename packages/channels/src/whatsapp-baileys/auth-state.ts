/**
 * Baileys' authentication state over the encrypted secrets of the Dot, instead of the plaintext JSON files of
 * its multi-file helper. The state is the linked device's identity and its Signal keys: whoever holds it is
 * that WhatsApp account, which makes it worth more than a bot token. It is kept as one encrypted secret for the
 * credentials and one per group of keys (`SignalDataTypeMap` names the groups), under the Dot's id like
 * every secret, so it is deleted with the channel and the Dot and never reaches the guest.
 *
 * The whole state lives in memory while the connection is open; a change is written before `set` resolves,
 * because a Signal ratchet that moved and was not saved cannot be taken back. The credentials and every group
 * that changed go in one transaction (`ChannelSecrets.putAll`), so a crash leaves the state as it was or as it
 * is now, never a step apart; and once the channel or its Dot is deleted nothing is written back.
 */
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from "baileys";
import type { ChannelSecrets } from "../channel.js";

export const WHATSAPP_CREDS_SECRET = "whatsapp_creds";

type KeyGroup = keyof SignalDataTypeMap;

/** One secret per group of keys. A `Record` over the library's own key list, so a group added by a Baileys upgrade is a compile error here, not a key that is never saved. */
const GROUP_SECRETS: Record<KeyGroup, string> = {
  "pre-key": "whatsapp_keys_pre_key",
  session: "whatsapp_keys_session",
  "sender-key": "whatsapp_keys_sender_key",
  "sender-key-memory": "whatsapp_keys_sender_key_memory",
  "app-state-sync-key": "whatsapp_keys_app_state_sync_key",
  "app-state-sync-version": "whatsapp_keys_app_state_sync_version",
  "lid-mapping": "whatsapp_keys_lid_mapping",
  "device-list": "whatsapp_keys_device_list",
  tctoken: "whatsapp_keys_tctoken",
  "identity-key": "whatsapp_keys_identity_key",
};

/** Every secret the state is kept in: what the hub deletes when the channel goes. */
export const WHATSAPP_AUTH_SECRETS: readonly string[] = [WHATSAPP_CREDS_SECRET, ...Object.values(GROUP_SECRETS)];

/** The parts of Baileys the state needs; the caller passes the module it loaded, so this file never imports it. */
export interface BaileysAuthLib {
  initAuthCreds(): AuthenticationCreds;
  BufferJSON: { replacer(key: string, value: unknown): unknown; reviver(key: string, value: unknown): unknown };
  proto: { Message: { AppStateSyncKeyData: { fromObject(object: { [key: string]: unknown }): SignalDataTypeMap["app-state-sync-key"] } } };
}

export class AuthStore {
  /** What `makeWASocket` takes as `auth`. */
  readonly state: AuthenticationState;
  readonly #groups = new Map<KeyGroup, Record<string, unknown>>();
  readonly #dirty = new Set<KeyGroup>();
  #credsDirty = false;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  private constructor(
    private readonly dotId: string,
    private readonly secrets: ChannelSecrets,
    private readonly lib: BaileysAuthLib,
    creds: AuthenticationCreds,
  ) {
    this.state = {
      creds,
      keys: {
        get: async (type, ids) => {
          const group = this.#groups.get(type) ?? {};
          const found: Record<string, never> = {};
          for (const id of ids) {
            const value = group[id];
            if (value === undefined) continue;
            // The group is stored as plain JSON; this one is a protobuf message to Baileys.
            (found as Record<string, unknown>)[id] = type === "app-state-sync-key" ? this.lib.proto.Message.AppStateSyncKeyData.fromObject(value as { [key: string]: unknown }) : value;
          }
          return found;
        },
        set: async (data: SignalDataSet) => {
          this.#assertOpen();
          for (const [type, entries] of Object.entries(data) as [KeyGroup, Record<string, unknown>][]) {
            const group = this.#groups.get(type) ?? {};
            this.#groups.set(type, group);
            for (const [id, value] of Object.entries(entries)) {
              if (value === null || value === undefined) delete group[id];
              else group[id] = value;
            }
            this.#dirty.add(type);
          }
          await this.#flush();
        },
      },
    };
  }

  /** The state of the Dot's linked device, or a fresh one (an account not linked yet) when nothing is stored. */
  static async open(dotId: string, secrets: ChannelSecrets, lib: BaileysAuthLib): Promise<AuthStore> {
    const read = async (name: string): Promise<unknown> => {
      const text = await secrets.get(dotId, name);
      return text === null ? null : JSON.parse(text, lib.BufferJSON.reviver);
    };
    const creds = ((await read(WHATSAPP_CREDS_SECRET)) as AuthenticationCreds | null) ?? lib.initAuthCreds();
    const store = new AuthStore(dotId, secrets, lib, creds);
    for (const [group, name] of Object.entries(GROUP_SECRETS) as [KeyGroup, string][]) {
      const stored = (await read(name)) as Record<string, unknown> | null;
      if (stored) store.#groups.set(group, stored);
    }
    return store;
  }

  /** Whether the state belongs to a linked account. */
  get linked(): boolean {
    return this.state.creds.me !== undefined;
  }

  /** Write the credentials (Baileys changes them in place and says so with `creds.update`). */
  async saveCreds(): Promise<void> {
    this.#assertOpen();
    this.#credsDirty = true;
    await this.#flush();
  }

  /** Wait for every write and refuse any later one: what was written is final, so the hub can delete it without a late write bringing it back. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("the WhatsApp session is closed");
  }

  /** Write what changed in one transaction, after the writes that were asked for earlier. Concurrent callers share the work: the one that comes second may find nothing left to write. */
  #flush(): Promise<void> {
    const run = this.#tail.then(async () => {
      const entries: Record<string, string> = {};
      const creds = this.#credsDirty;
      const groups = [...this.#dirty];
      if (creds) entries[WHATSAPP_CREDS_SECRET] = this.#encode(this.state.creds);
      for (const group of groups) entries[GROUP_SECRETS[group]] = this.#encode(this.#groups.get(group) ?? {});
      if (Object.keys(entries).length === 0) return;
      this.#credsDirty = false;
      this.#dirty.clear();
      try {
        await this.secrets.putAll(this.dotId, entries);
      } catch (error) {
        // Nothing was written: all of it is still to write.
        if (creds) this.#credsDirty = true;
        for (const group of groups) this.#dirty.add(group);
        throw error;
      }
    });
    this.#tail = run.catch(() => {});
    return run;
  }

  #encode(value: unknown): string {
    return JSON.stringify(value, this.lib.BufferJSON.replacer);
  }
}
