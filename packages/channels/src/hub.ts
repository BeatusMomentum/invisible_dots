/**
 * The channel hub: the one owner of every channel policy. It runs inside the control plane process next
 * to the Scheduler and uses only what the Scheduler offers (`ChannelHost`): the Dot never sees a channel
 * and nothing of the guest protocol changes. A message from a paired person becomes a user message of
 * the Dot with an origin; the answer is routed back by that origin (see `BindingRunner`).
 *
 * Who may talk: only a person paired with a one-time code, identified by the channel's stable id.
 * Everyone else is dropped before anything is written or any model is paid for.
 */
import type { ChannelBindingRecord, ChannelPeerRow, Database } from "@invisible-dots/database";
import { isUniqueViolation } from "@invisible-dots/database";
import type { EventLog } from "@invisible-dots/events";
import {
  CHANNEL_KINDS,
  newId,
  type ChannelKind,
  type ChannelPairingAnswer,
  type ChannelRecord,
  type ChannelSettings,
  type MessageAnswer,
  type MessageOrigin,
} from "@invisible-dots/shared";
import { ControlPlaneError, errorMessage, notFound, silentLogger, systemClock, type Clock, type Logger } from "@invisible-dots/scheduler";
import { DEFAULT_BACKOFF, type BackoffOptions } from "./backoff.js";
import type { ChannelSink, ChannelStatusReport, ChannelType, InboundChat, PairingAttempt } from "./channel.js";
import { hashPairingCode, newPairingCode } from "./pairing.js";
import { RateLimiter } from "./rate.js";
import { BindingRunner } from "./runner.js";

/** What the hub asks of the control plane; the Scheduler satisfies it. */
export interface ChannelHost {
  sendMessage(idOrName: string, text: string, origin?: MessageOrigin): Promise<MessageAnswer>;
  requireDot(idOrName: string): Promise<{ id: string; name: string }>;
  events: Pick<EventLog, "stream" | "userMessage" | "tail" | "appendHost">;
}

/** What the hub stores through. */
export type ChannelStore = Pick<Database, "channels" | "secrets" | "transaction">;

export interface ChannelLimits {
  /** Messages a person can send at once before being slowed down. Default 10. */
  burst: number;
  /** Messages a person can send per minute once the burst is used. Default 20. */
  perMinute: number;
  /** The longest message taken from a person, in characters. Default 8000. */
  maxChars: number;
  /** How long the record of handled messages is kept, in days: a channel redelivers recent messages only. Default 7. */
  inboundRetentionDays: number;
}

export interface ChannelHubOptions {
  db: ChannelStore;
  host: ChannelHost;
  /** The kinds of channel this process can run. */
  types: readonly ChannelType[];
  clock?: Clock;
  logger?: Logger;
  backoff?: BackoffOptions;
  limits?: Partial<ChannelLimits>;
  /** How long a pairing code lasts. Default ten minutes. */
  pairingTtlMs?: number;
}

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = { approvals: true, notify_tasks: true };

const DEFAULT_LIMITS: ChannelLimits = { burst: 10, perMinute: 20, maxChars: 8_000, inboundRetentionDays: 7 };
const PRUNE_EVERY_MS = 6 * 3_600_000;
const STATUS_DETAIL_MAX = 300;
const LABEL_MAX = 64;

const SETTING_KEYS = Object.keys(DEFAULT_CHANNEL_SETTINGS);

function bad(message: string): ControlPlaneError {
  return new ControlPlaneError(400, "invalid_request", message);
}

/** The settings in `patch` applied to `base`; anything that is not a known boolean setting is a 400. */
function applySettings(base: ChannelSettings, patch: unknown): ChannelSettings {
  if (patch === undefined) return { ...base };
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw bad("settings must be an object");
  const out: Record<string, boolean> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.includes(key)) throw bad(`unknown channel setting "${key}"; the settings are ${SETTING_KEYS.join(", ")}`);
    if (typeof value !== "boolean") throw bad(`the channel setting "${key}" must be true or false`);
    out[key] = value;
  }
  return out as unknown as ChannelSettings;
}

export class ChannelHub {
  readonly #o: ChannelHubOptions;
  readonly #types = new Map<ChannelKind, ChannelType>();
  readonly #runners = new Map<string, BindingRunner>();
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #limits: ChannelLimits;
  readonly #rate: RateLimiter;
  /** Peers told they are slowed down, until their bucket has a token again: one notice, not one per message. */
  readonly #slowed = new Set<string>();
  #pruneTimer: NodeJS.Timeout | null = null;
  #state: "new" | "started" | "closed" = "new";

  constructor(options: ChannelHubOptions) {
    this.#o = options;
    for (const type of options.types) {
      if (this.#types.has(type.kind)) throw new Error(`two channel types for "${type.kind}"`);
      this.#types.set(type.kind, type);
    }
    this.#clock = options.clock ?? systemClock;
    this.#log = options.logger ?? silentLogger;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#rate = new RateLimiter(this.#limits.burst, this.#limits.perMinute / 60, this.#clock);
  }

  /** Start every enabled binding. A binding that cannot start does not keep the others from it. */
  async start(): Promise<void> {
    if (this.#state !== "new") return;
    this.#state = "started";
    await this.#prune();
    this.#pruneTimer = setInterval(() => void this.#prune(), PRUNE_EVERY_MS);
    this.#pruneTimer.unref();
    for (const binding of await this.#o.db.channels.listBindings()) {
      if (binding.enabled) this.#run(binding);
    }
  }

  /** Stop every adapter and write the cursors. Idempotent. */
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closed";
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    await Promise.all([...this.#runners.values()].map((runner) => runner.stop()));
    this.#runners.clear();
  }

  // Managing bindings (the API's side)

  /** Every channel of the Dot, with the people paired to it. Never a credential. */
  async list(dotIdOrName: string): Promise<ChannelRecord[]> {
    const dot = await this.#o.host.requireDot(dotIdOrName);
    const bindings = await this.#o.db.channels.listBindings(dot.id);
    return Promise.all(bindings.map(async (b) => this.#record(b, await this.#o.db.channels.peers(b.id))));
  }

  /**
   * Link the Dot to a channel and start it. `credentials` are stored encrypted as secrets of the Dot, by
   * the names the channel type declares, and never returned. The channel starts after the Dot's latest
   * event: what happened before is not replayed into the chat.
   */
  async add(
    dotIdOrName: string,
    kind: ChannelKind,
    options: { settings?: unknown; credentials?: Record<string, string> } = {},
  ): Promise<ChannelRecord> {
    this.#assertOpen();
    const type = this.#type(kind);
    const dot = await this.#o.host.requireDot(dotIdOrName);
    const settings = applySettings(DEFAULT_CHANNEL_SETTINGS, options.settings);
    const credentials = Object.entries(options.credentials ?? {});
    for (const [name, value] of credentials) {
      if (!type.secretNames.includes(name)) throw bad(`a ${kind} channel has no credential "${name}"`);
      if (typeof value !== "string" || value === "") throw bad(`the credential "${name}" must be a non-empty string`);
    }
    const eventCursor = (await this.#o.host.events.tail(dot.id, 1))[0]?.id ?? 0;
    let binding: ChannelBindingRecord;
    try {
      binding = await this.#o.db.transaction(async (tx) => {
        const created = await tx.channels.createBinding({ id: newId("chb"), dotId: dot.id, kind, settings, eventCursor });
        for (const [name, value] of credentials) await tx.secrets.put(dot.id, name, value);
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ControlPlaneError(409, "channel_exists", `Dot "${dot.name}" already has a ${kind} channel`);
      throw error;
    }
    if (this.#state === "started") this.#run(binding);
    return this.#record(binding, []);
  }

  /** Unlink: stop the channel and delete its binding, the people paired to it and its credentials. */
  async remove(dotIdOrName: string, kind: ChannelKind): Promise<void> {
    const binding = await this.#binding(dotIdOrName, kind);
    await this.#stop(binding.id);
    const secretNames = this.#types.get(kind)?.secretNames ?? [];
    await this.#o.db.transaction(async (tx) => {
      await tx.channels.deleteBinding(binding.id);
      for (const name of secretNames) await tx.secrets.delete(binding.dot_id, name);
    });
  }

  async setSettings(dotIdOrName: string, kind: ChannelKind, patch: unknown): Promise<ChannelRecord> {
    const binding = await this.#binding(dotIdOrName, kind);
    const updated = await this.#o.db.channels.setSettings(binding.id, applySettings(binding.settings, patch));
    return this.#record(updated ?? binding, await this.#o.db.channels.peers(binding.id));
  }

  /** Pause or resume a channel without losing its credentials or its people. */
  async setEnabled(dotIdOrName: string, kind: ChannelKind, enabled: boolean): Promise<ChannelRecord> {
    this.#assertOpen();
    const binding = await this.#binding(dotIdOrName, kind);
    const updated = (await this.#o.db.channels.setEnabled(binding.id, enabled)) ?? binding;
    if (enabled) {
      if (this.#state === "started") this.#run(updated);
    } else {
      await this.#stop(binding.id);
    }
    return this.#record(updated, await this.#o.db.channels.peers(binding.id));
  }

  /** A one-time code that pairs a person's chat to the Dot, valid for ten minutes and stored hashed. */
  async pair(dotIdOrName: string, kind: ChannelKind): Promise<ChannelPairingAnswer> {
    const binding = await this.#binding(dotIdOrName, kind);
    const now = this.#clock.now();
    const expiresAt = new Date(now.getTime() + (this.#o.pairingTtlMs ?? 10 * 60_000));
    const code = newPairingCode();
    await this.#o.db.channels.createPairing(binding.id, hashPairingCode(binding.id, code), expiresAt, now);
    const deepLink = this.#types.get(kind)?.pairingLink?.(binding.account, code) ?? null;
    return { code, deep_link: deepLink, expires_at: expiresAt.toISOString() };
  }

  /** Revoke a paired person: they are strangers again, and nothing more is sent to their chat. */
  async removePeer(dotIdOrName: string, kind: ChannelKind, peerId: string): Promise<void> {
    const binding = await this.#binding(dotIdOrName, kind);
    if (!(await this.#o.db.channels.deletePeer(binding.id, peerId))) throw notFound("peer", peerId);
  }

  // Running bindings

  #assertOpen(): void {
    if (this.#state === "closed") throw new ControlPlaneError(503, "channels_stopped", "the channels are shutting down");
  }

  #type(kind: ChannelKind): ChannelType {
    const type = this.#types.get(kind);
    if (!type) {
      const known = CHANNEL_KINDS.includes(kind) ? "this server has no adapter for it" : `the channels are ${CHANNEL_KINDS.join(", ")}`;
      throw bad(`no "${String(kind)}" channel: ${known}`);
    }
    return type;
  }

  async #binding(dotIdOrName: string, kind: ChannelKind): Promise<ChannelBindingRecord> {
    const dot = await this.#o.host.requireDot(dotIdOrName);
    const binding = await this.#o.db.channels.binding(dot.id, kind);
    if (!binding) throw notFound(`${kind} channel of`, dot.name);
    return binding;
  }

  #record(binding: ChannelBindingRecord, peers: ChannelPeerRow[]): ChannelRecord {
    return {
      kind: binding.kind,
      enabled: binding.enabled,
      status: binding.status,
      status_detail: binding.status_detail,
      bot_username: binding.account,
      settings: binding.settings,
      peers: peers.map((p) => ({ peer_id: p.peer_id, role: p.role, label: p.label, created_at: p.created_at })),
      created_at: binding.created_at,
    };
  }

  #run(binding: ChannelBindingRecord): void {
    if (this.#runners.has(binding.id)) return;
    const type = this.#types.get(binding.kind);
    if (!type) {
      this.#log.warn("a binding has no channel type in this build, leaving it stopped", { binding: binding.id, kind: binding.kind });
      return;
    }
    const runner = new BindingRunner({
      binding,
      type,
      db: this.#o.db,
      events: this.#o.host.events,
      logger: this.#log,
      backoff: this.#o.backoff ?? DEFAULT_BACKOFF,
      sink: (r) => this.#sink(r),
      onStatus: (r, report) => this.#status(r, report),
      onDotDeleted: (r) => {
        // The rows went with the Dot; only the adapter is left to stop.
        this.#runners.delete(r.bindingId);
        void r.stop();
      },
    });
    this.#runners.set(binding.id, runner);
    runner.start();
  }

  async #stop(bindingId: string): Promise<void> {
    const runner = this.#runners.get(bindingId);
    this.#runners.delete(bindingId);
    await runner?.stop();
  }

  async #prune(): Promise<void> {
    const before = new Date(this.#clock.now().getTime() - this.#limits.inboundRetentionDays * 86_400_000);
    await this.#o.db.channels.pruneInbound(before).catch((error) => this.#log.warn("could not prune the handled messages", { error: errorMessage(error) }));
  }

  // What an adapter reports

  #sink(runner: BindingRunner): ChannelSink {
    return {
      inbound: (message) => this.#inbound(runner, message),
      pairing: (attempt) => this.#pairing(runner, attempt),
      status: (report) => runner.report(report),
    };
  }

  /** Record a status; a change is announced as a `channel.status` event, a repeat is not. */
  async #status(runner: BindingRunner, report: ChannelStatusReport): Promise<void> {
    const detail = report.detail === undefined ? null : (await runner.scrub(report.detail)).slice(0, STATUS_DETAIL_MAX);
    const changed = await this.#o.db.channels.setStatus(runner.bindingId, report.status, detail, report.account);
    if (!changed) return;
    await this.#o.host.events.appendHost(runner.dotId, "channel.status", {
      kind: runner.kind,
      status: report.status,
      ...(detail !== null && { detail }),
    });
  }

  /**
   * A message from a chat. Nothing is written for anyone who is not paired, for a chat that is not a
   * private one, or for a message over the rate or length limit. A message already handed to the Dot
   * (the channel redelivers after a restart) is recognised by its channel id and dropped.
   */
  async #inbound(runner: BindingRunner, message: InboundChat): Promise<void> {
    if (runner.stopped) throw new Error("the channel is stopped");
    if (!message.direct) return;
    const peer = await this.#o.db.channels.peer(runner.bindingId, message.peerId);
    if (!peer) return;
    if (message.text.trim() === "") return;
    const key = `${runner.bindingId}:${peer.peer_id}`;
    if (!this.#rate.take(key)) {
      if (!this.#slowed.has(key)) {
        this.#slowed.add(key);
        await this.#tell(runner, message.chatId, "You are sending messages too fast. Wait a moment, then write again.");
      }
      return;
    }
    this.#slowed.delete(key);
    if (message.text.length > this.#limits.maxChars) {
      await this.#tell(runner, message.chatId, `That message is too long: the limit is ${this.#limits.maxChars} characters.`);
      return;
    }
    await runner.serial(async () => {
      if (await this.#o.db.channels.inboundMessageId(runner.bindingId, message.externalId)) return;
      try {
        const answer = await this.#o.host.sendMessage(runner.dotId, message.text, {
          channel: runner.kind,
          binding_id: runner.bindingId,
          chat_id: message.chatId,
          external_id: message.externalId,
        });
        await this.#o.db.channels.recordInbound(runner.bindingId, message.externalId, answer.message_id);
        runner.activeChat = message.chatId;
      } catch (error) {
        // The Dot is gone or the message is refused for good: offering it again cannot change that.
        if (error instanceof ControlPlaneError && error.status >= 400 && error.status < 500) {
          this.#log.warn("dropped a channel message the control plane refused", { binding: runner.bindingId, code: error.code });
          return;
        }
        throw error;
      }
    });
  }

  /** The code pairs the sender as an owner of the Dot's channel, once. The code is used and the person added together. */
  async #pairing(runner: BindingRunner, attempt: PairingAttempt): Promise<boolean> {
    if (runner.stopped) throw new Error("the channel is stopped");
    const label = attempt.label?.trim().slice(0, LABEL_MAX) || attempt.peerId;
    const hash = hashPairingCode(runner.bindingId, attempt.code);
    const paired = await this.#o.db.transaction(async (tx) => {
      if (!(await tx.channels.consumePairing(runner.bindingId, hash, this.#clock.now()))) return false;
      await tx.channels.upsertPeer({ bindingId: runner.bindingId, peerId: attempt.peerId, chatId: attempt.chatId, role: "owner", label });
      return true;
    });
    if (!paired) return false;
    // The person is paired already; the event only tells the UI, so a failure to log it must not undo or hide the pairing.
    await this.#o.host.events
      .appendHost(runner.dotId, "channel.peer.paired", { kind: runner.kind, peer_id: attempt.peerId, label })
      .catch((error) => this.#log.warn("could not log a pairing", { binding: runner.bindingId, error: errorMessage(error) }));
    const dot = await this.#o.host.requireDot(runner.dotId).catch(() => null);
    await this.#tell(runner, attempt.chatId, `Paired. What you write here now goes to ${dot?.name ?? "your Dot"}, and its answers come back here.`);
    return true;
  }

  /** A message of the hub's own to a chat; best effort, because nothing depends on it arriving. */
  async #tell(runner: BindingRunner, chatId: string, text: string): Promise<void> {
    try {
      await runner.channel?.sendText(chatId, text);
    } catch (error) {
      this.#log.warn("could not send a notice", { binding: runner.bindingId, error: await runner.scrub(errorMessage(error)) });
    }
  }
}
