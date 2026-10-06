/**
 * What a messaging channel is to the hub. An adapter (Telegram, WhatsApp) is transport only: it
 * connects, turns what arrives into `InboundChat`, and sends text. Every policy lives in the hub:
 * who may talk, pairing, rate limits, idempotency, where a reply goes, retries and backoff.
 */
import type { ChannelKind, ChannelStatus } from "@invisible-dots/shared";
import type { ChannelBindingRecord } from "@invisible-dots/database";

/** One message from a person, as the adapter saw it. */
export interface InboundChat {
  /** The channel's own id for this message (a Telegram update id), unique per binding: a redelivery has the same one. */
  externalId: string;
  /** The channel's stable id for the sender (a Telegram numeric user id), never a mutable name. */
  peerId: string;
  /** Where the sender wrote from; the answer goes back to it. */
  chatId: string;
  text: string;
  /** A private chat with the bot. The hub drops everything else: a group would show prompts and answers to its members. */
  direct: boolean;
  /** How the sender is named in the channel, for the list of paired people; the hub falls back to `peerId`. */
  label?: string;
  /**
   * The message carries something other than text (a photo, a voice note). The Dot gets text only, so the
   * hub tells a paired person it is not supported yet and hands nothing on.
   */
  attachment?: boolean;
}

/** A person who sent the one-time code from `/start <code>` or the like. */
export interface PairingAttempt {
  code: string;
  peerId: string;
  chatId: string;
  label?: string;
}

/** A person pressed Approve or Reject on an approval prompt. */
export interface ApprovalAction {
  approvalId: string;
  decision: "approve" | "reject";
  /** The channel's stable id for the person who pressed it. */
  peerId: string;
  /** The chat the prompt is in. */
  chatId: string;
  /** A private chat with the bot; anything else is refused, as for a message. */
  direct: boolean;
}

/** What an approval prompt says. The adapter adds whatever lets the person answer (buttons). */
export interface ApprovalPrompt {
  approvalId: string;
  text: string;
}

/** Where the connection stands, as the adapter reports it. `account` is the channel's public name for the account (a bot's username). */
export interface ChannelStatusReport {
  status: ChannelStatus;
  /** Why, for `error`. Never a credential: the hub stores and publishes it. */
  detail?: string;
  account?: string;
}

/** What the hub gives an adapter to report to. */
export interface ChannelSink {
  /**
   * An authorized-or-not message arrived. Resolves once the hub is done with it (handed to the Dot, or
   * dropped), and only then may the adapter commit its offset; rejects when it could not be recorded, so the
   * adapter keeps the message and offers it again.
   */
  inbound(message: InboundChat): Promise<void>;
  /** Resolves true when the code paired the sender, false when it is wrong, expired or used (the adapter says nothing to a stranger). */
  pairing(attempt: PairingAttempt): Promise<boolean>;
  status(report: ChannelStatusReport): void;
  /**
   * A person answered an approval prompt. Resolves with a short notice for the person (what happened, or why
   * nothing did): the adapter shows it and, as with `inbound`, commits its offset only after this resolved.
   * It never rejects for a person's mistake; it rejects when the hub could not do the work, so the adapter
   * keeps the press and offers it again.
   */
  approval(action: ApprovalAction): Promise<string>;
  /**
   * The person has to link an account on their phone: `code` is what the phone scans. A new code replaces the last;
   * it is shown at once and never stored or logged. Only a channel of a `scanned` type calls it.
   */
  linkCode(code: string): void;
}

export interface ChannelCapabilities {
  /** The most characters one message can hold; the hub splits longer text. */
  maxText: number;
  /** `typing` shows a typing indicator. */
  typing: boolean;
  /**
   * The channel has no buttons: a prompt tells the person to answer with the words of `approvalReplyHint`, and the hub
   * reads such a reply, from a paired person only, as the answer (see `parseApprovalReply`).
   */
  approvalByText: boolean;
}

export interface Channel {
  readonly capabilities: ChannelCapabilities;
  /**
   * Connect and deliver messages to `sink` until `signal` aborts, then disconnect and resolve. Report
   * `connecting` and `connected` through `sink.status`; report `connected` only once the connection has done
   * its first piece of work (the hub starts the backoff over at that report). Rejecting means the connection
   * cannot continue: the hub reports `error`, waits (exponential backoff, at least `ChannelRateLimitedError`'s
   * `retryAfterMs`) and calls `run` again on a fresh instance. Rejecting with
   * `ChannelNeedsRelinkError` means only the person can fix it (a revoked token, a logged-out device): the
   * hub reports `needs_relink` and does not call `run` again.
   */
  run(sink: ChannelSink, signal: AbortSignal): Promise<void>;
  /** Send one message of at most `capabilities.maxText` characters. Failures: see `ChannelSendError`. */
  sendText(chatId: string, text: string): Promise<void>;
  /** Show that the Dot is working on an answer; best effort, a failure is ignored. */
  typing?(chatId: string): Promise<void>;
  /**
   * Ask the person to approve or reject; resolves with the handle (`ref`) of the sent message, which `editApproval`
   * needs. Answers come through `ChannelSink.approval`. Failures: see `ChannelSendError`.
   */
  sendApproval(chatId: string, prompt: ApprovalPrompt): Promise<string>;
  /** Replace the prompt with `text` and take its means of answering away. A prompt that is gone counts as edited. */
  editApproval(chatId: string, ref: string, text: string): Promise<void>;
}

/** A send that failed. A plain `Error` counts as retryable (a network failure); only this class can say it is not. */
export class ChannelSendError extends Error {
  constructor(
    message: string,
    readonly options: {
      /** False when sending again cannot work (the person blocked the bot): the hub drops the message. */
      retryable: boolean;
      /** What the channel asked for (a 429's `retry_after`); the hub waits at least this long. */
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = "ChannelSendError";
  }
}

/** `run` failed because the service asked for a pause (a 429's `retry_after`): the hub waits at least this long before it starts the channel again. */
export class ChannelRateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "ChannelRateLimitedError";
  }
}

/** Only the person can fix the connection: a revoked token, a logged-out device. */
export class ChannelNeedsRelinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelNeedsRelinkError";
  }
}

/** The credentials a person gave do not work (a revoked or mistyped token). The message may be shown to them: it never carries a credential. */
export class ChannelCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelCredentialsError";
  }
}

/** Thrown by `ChannelSecrets.putAll` when the binding is gone: what the adapter held for it is not kept. */
export class ChannelGoneError extends Error {
  constructor() {
    super("the channel was removed");
    this.name = "ChannelGoneError";
  }
}

/** The secrets of a binding, as an adapter reaches them; the scope of a binding's secrets is its Dot's id. */
export interface ChannelSecrets {
  get(scope: string, name: string): Promise<string | null>;
  /**
   * Write several secrets of the binding together: all or none. Only while the binding exists, so state an
   * adapter still holds when its Dot or channel is deleted cannot be written back after the delete
   * (`ChannelGoneError`).
   */
  putAll(scope: string, entries: Readonly<Record<string, string>>): Promise<void>;
}

/** One kind of channel: how to make its adapter for a binding, and what a binding of it owns besides its rows. */
export interface ChannelType {
  readonly kind: ChannelKind;
  /**
   * The names of the secrets (scope = the Dot's id) a binding of this kind keeps. They are the only credential
   * names the hub stores for it, and they are deleted with the binding; they are never pushed to the guest.
   */
  readonly secretNames: readonly string[];
  /**
   * The names among `secretNames` that a person gave or that name a credential in a few characters (a bot token): the
   * values the hub blanks out of every log line and status. Not the bulk state of a session, which no log line holds.
   */
  readonly scrubNames: readonly string[];
  /**
   * A person links an account by scanning a code on their phone (`ChannelSink.linkCode`) instead of giving a
   * credential: the hub links it with `link`, never with `add`, and the adapter makes its own credentials.
   */
  readonly scanned?: true;
  /**
   * Try the credentials a person is giving, before anything is stored: resolves with the account they
   * belong to (a bot's username), rejects with `ChannelCredentialsError` when they do not work and with
   * any other error when the channel cannot be reached. Absent when a channel has nothing to check.
   */
  check?(credentials: Record<string, string>): Promise<{ account: string }>;
  /**
   * The adapter for `binding`, reading its credentials from `secrets`. Throws when they are missing. A channel that
   * makes its own credentials (a linked device's keys) also writes and deletes them there.
   */
  create(binding: ChannelBindingRecord, secrets: ChannelSecrets): Promise<Channel>;
  /** The link that opens the channel with the code filled in, or null when the channel has none. `account` is what the adapter reported. */
  pairingLink?(account: string | null, code: string): string | null;
  /** The words that pair when a person sends them to the account: the adapter reads exactly these. */
  pairingMessage(code: string): string;
}
