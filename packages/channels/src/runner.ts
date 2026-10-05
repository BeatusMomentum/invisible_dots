/**
 * One running binding: supervises the adapter (start, restart after a failure with backoff) and carries
 * the Dot's events to the person's chat, in order, with a cursor so a restart resumes where it stopped.
 *
 * Delivery is at least once: the cursor moves after a send succeeded, so a crash between the send and
 * the cursor write sends that one message again. A message the channel refuses for good (the person
 * blocked the bot) is dropped, a message it only fails to take now is retried until it goes.
 */
import type { ChannelBindingRecord, Database } from "@invisible-dots/database";
import { StreamOverflowError, type EventLog } from "@invisible-dots/events";
import { parseMessageOrigin, type ChannelKind, type StoredEvent } from "@invisible-dots/shared";
import { errorMessage, sleep, type Logger } from "@invisible-dots/scheduler";
import { Backoff, type BackoffOptions } from "./backoff.js";
import { ChannelNeedsRelinkError, ChannelSendError, type Channel, type ChannelSink, type ChannelStatusReport, type ChannelType } from "./channel.js";
import { splitText } from "./text.js";

/** The part of the event log a runner reads. */
export type RunnerEvents = Pick<EventLog, "stream" | "userMessage">;

export interface RunnerOptions {
  binding: ChannelBindingRecord;
  type: ChannelType;
  db: Pick<Database, "channels" | "secrets">;
  events: RunnerEvents;
  logger: Logger;
  backoff: BackoffOptions;
  /** The sink the adapter reports to. */
  sink: (runner: BindingRunner) => ChannelSink;
  /** The adapter reported its status (or the runner did). */
  onStatus: (runner: BindingRunner, report: ChannelStatusReport) => Promise<void>;
  /** The Dot was deleted: its bindings are gone with it, so the runner has nothing left to do. */
  onDotDeleted: (runner: BindingRunner) => void;
}

/** How many events that need no send pass before the cursor is written for them (they are harmless to replay). */
const IDLE_CURSOR_EVERY = 100;
/** Secret values shorter than this are not worth hiding: they would also match ordinary words. */
const MIN_SECRET_LENGTH = 8;

export class BindingRunner {
  readonly bindingId: string;
  readonly dotId: string;
  readonly kind: ChannelKind;
  /** The adapter while one runs; null between attempts. */
  channel: Channel | null = null;
  /** The chat of the last message the person sent, until the Dot answers it or goes idle: where `typing` shows. */
  activeChat: string | null = null;
  stopped = false;
  readonly #abort = new AbortController();
  readonly #o: RunnerOptions;
  #tasks: Promise<unknown>[] = [];
  #statusTail: Promise<unknown> = Promise.resolve();
  #inboundTail: Promise<unknown> = Promise.resolve();
  /** The id of the last event dealt with. */
  #handled: number;
  #written: number;
  #idle = 0;

  constructor(options: RunnerOptions) {
    this.#o = options;
    this.bindingId = options.binding.id;
    this.dotId = options.binding.dot_id;
    this.kind = options.binding.kind;
    this.#handled = this.#written = options.binding.event_cursor;
  }

  get #signal(): AbortSignal {
    return this.#abort.signal;
  }

  start(): void {
    this.report({ status: "connecting" });
    this.#tasks = [this.#supervise(), this.#outbound()];
  }

  /** Stop the adapter and the event loop, and write the cursor. Resolves when both are done. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.#abort.abort();
    await Promise.allSettled(this.#tasks);
    await this.#statusTail;
    await this.#flushCursor().catch(() => {});
  }

  /** Run `work` after the inbound messages that came before it: one at a time per binding, in order. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#inboundTail.then(work, work);
    this.#inboundTail = result.catch(() => {});
    return result;
  }

  /** Report a status; reports are applied in the order they were made. */
  report(report: ChannelStatusReport): void {
    this.#statusTail = this.#statusTail
      .then(() => this.#o.onStatus(this, report))
      .catch((error) => this.#o.logger.warn("could not record a channel status", { binding: this.bindingId, error: errorMessage(error) }));
  }

  /** `text` with the binding's credentials replaced, for anything that is stored, shown or logged. */
  async scrub(text: string): Promise<string> {
    let out = text;
    for (const name of this.#o.type.secretNames) {
      const value = await this.#o.db.secrets.get(this.dotId, name).catch(() => null);
      if (value && value.length >= MIN_SECRET_LENGTH) out = out.split(value).join("[redacted]");
    }
    return out;
  }

  // The adapter

  async #supervise(): Promise<void> {
    const backoff = new Backoff(this.#o.backoff);
    const sink = this.#o.sink(this);
    while (!this.#signal.aborted) {
      let failure: string;
      try {
        const binding = await this.#o.db.channels.bindingById(this.bindingId);
        if (!binding) return;
        this.channel = await this.#o.type.create(binding, this.#o.db.secrets);
        await this.channel.run(
          {
            ...sink,
            status: (report) => {
              if (report.status === "connected") backoff.reset();
              sink.status(report);
            },
          },
          this.#signal,
        );
        if (this.#signal.aborted) return;
        failure = "the connection ended";
      } catch (error) {
        if (this.#signal.aborted) return;
        if (error instanceof ChannelNeedsRelinkError) {
          this.report({ status: "needs_relink", detail: await this.scrub(error.message) });
          return;
        }
        failure = await this.scrub(errorMessage(error));
      } finally {
        this.channel = null;
      }
      this.#o.logger.warn("a channel stopped, starting it again", { binding: this.bindingId, kind: this.kind, reason: failure });
      this.report({ status: "error", detail: failure });
      await sleep(backoff.next(), this.#signal);
    }
  }

  // The Dot's events

  async #outbound(): Promise<void> {
    const backoff = new Backoff(this.#o.backoff);
    while (!this.#signal.aborted) {
      try {
        for await (const event of this.#o.events.stream({ dotId: this.dotId }, { after: this.#handled, signal: this.#signal })) {
          if (!(await this.#handle(event))) return;
          backoff.reset();
        }
        return;
      } catch (error) {
        if (this.#signal.aborted) return;
        this.#o.logger.warn("a channel's event stream failed", { binding: this.bindingId, error: errorMessage(error) });
        // Falling behind is not a fault of the database: resume from the cursor at once.
        if (!(error instanceof StreamOverflowError)) await sleep(backoff.next(), this.#signal);
      }
    }
  }

  /** Deal with one event. False when the loop must end (stopped, or the Dot is gone). */
  async #handle(event: StoredEvent): Promise<boolean> {
    if (event.type === "dot.deleted") {
      this.#o.onDotDeleted(this);
      return false;
    }
    const sent = await this.#route(event);
    if (sent === null) return false;
    this.#handled = event.id;
    if (sent) {
      await this.#flushCursor();
    } else if (++this.#idle >= IDLE_CURSOR_EVERY) {
      await this.#flushCursor();
    }
    return true;
  }

  /** What the event means for the chat: true when a message was sent, false when nothing was, null when stopped half way. */
  async #route(event: StoredEvent): Promise<boolean | null> {
    switch (event.type) {
      case "message.assistant":
        return this.#answer(event);
      case "task.completed":
      case "task.failed": {
        const binding = await this.#o.db.channels.bindingById(this.bindingId);
        if (!binding?.settings.notify_tasks) return false;
        const text =
          event.type === "task.completed"
            ? `Task completed: ${String(event.data.summary ?? "").trim() || "done"}`
            : `Task failed: ${String(event.data.error ?? "").trim() || "unknown error"}`;
        return this.#toOwners(text);
      }
      case "agent.state":
        if (event.data.state === "THINKING" && this.activeChat !== null) {
          const chat = this.activeChat;
          await this.channel?.typing?.(chat).catch(() => {});
        } else if (event.data.state === "IDLE") {
          this.activeChat = null;
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * The Dot's answer goes to the chat of the message it answers, when that message came through this
   * binding and the person is still paired; an answer that is not to a message (an automation's) goes to
   * the owners. An answer to a message from the web or another channel is not mirrored here.
   */
  async #answer(event: StoredEvent): Promise<boolean | null> {
    const text = String(event.data.text ?? "");
    if (text.trim() === "") return false;
    const inReplyTo = event.data.in_reply_to;
    if (typeof inReplyTo !== "string") return this.#toOwners(text);
    const asked = await this.#o.events.userMessage(this.dotId, inReplyTo);
    const origin = asked ? parseMessageOrigin(asked.data.origin) : null;
    if (!origin || origin.binding_id !== this.bindingId) return false;
    if (this.activeChat === origin.chat_id) this.activeChat = null;
    if (!(await this.#o.db.channels.peerByChat(this.bindingId, origin.chat_id))) return false;
    return this.#deliver(origin.chat_id, text);
  }

  async #toOwners(text: string): Promise<boolean | null> {
    const peers = await this.#o.db.channels.peers(this.bindingId);
    const chats = [...new Set(peers.filter((p) => p.role === "owner").map((p) => p.chat_id))];
    let sent = false;
    for (const chat of chats) {
      const done = await this.#deliver(chat, text);
      if (done === null) return null;
      sent ||= done;
    }
    return sent;
  }

  // Sending

  /** Send `text` in as many messages as the channel needs. True when sent, false when dropped for good, null when stopped. */
  async #deliver(chatId: string, text: string): Promise<boolean | null> {
    const channel = await this.#awaitChannel();
    if (!channel) return null;
    for (const piece of splitText(text, channel.capabilities.maxText)) {
      const outcome = await this.#sendWithRetry(chatId, piece);
      if (outcome !== true) return outcome;
    }
    return true;
  }

  /** The adapter, once one runs (it is down while it restarts); null when the runner stops first. */
  async #awaitChannel(): Promise<Channel | null> {
    const backoff = new Backoff(this.#o.backoff);
    while (!this.#signal.aborted) {
      if (this.channel) return this.channel;
      await sleep(backoff.next(), this.#signal);
    }
    return null;
  }

  async #sendWithRetry(chatId: string, text: string): Promise<boolean | null> {
    const backoff = new Backoff(this.#o.backoff);
    while (!this.#signal.aborted) {
      try {
        const channel = this.channel;
        if (!channel) throw new Error("the channel is not connected");
        await channel.sendText(chatId, text);
        return true;
      } catch (error) {
        const reason = await this.scrub(errorMessage(error));
        if (error instanceof ChannelSendError && !error.options.retryable) {
          this.#o.logger.warn("a channel refused a message, dropping it", { binding: this.bindingId, kind: this.kind, reason });
          return false;
        }
        const wait = Math.max(backoff.next(), error instanceof ChannelSendError ? (error.options.retryAfterMs ?? 0) : 0);
        this.#o.logger.warn("a channel could not send, trying again", { binding: this.bindingId, kind: this.kind, reason, waitMs: wait });
        await sleep(wait, this.#signal);
      }
    }
    return null;
  }

  async #flushCursor(): Promise<void> {
    this.#idle = 0;
    if (this.#handled === this.#written) return;
    this.#written = this.#handled;
    await this.#o.db.channels.advanceCursor(this.bindingId, this.#handled);
  }
}
