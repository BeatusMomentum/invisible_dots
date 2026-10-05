/**
 * Telegram through the Bot API, with grammY as the client. Transport only (see `Channel`): it polls for
 * messages, turns them into `InboundChat`, and sends text. Who may talk, retries and backoff belong to the hub.
 *
 * - Long polling: the control plane listens on a local address behind NAT, and polling needs only outbound
 *   HTTPS. Telegram keeps an unconfirmed update for at most 24 hours, so a PC that is off longer loses messages.
 * - An update is confirmed to Telegram (the `offset` of the next poll) only after the hub has dealt with it. When
 *   the hub could not record it, `run` fails, the hub restarts the adapter, and Telegram offers it again; the
 *   hub recognises one it already handed to the Dot by its id, so nothing runs twice.
 * - One consumer per bot token: a second poller makes Telegram answer 409, reported as such.
 * - The token is in every request URL, so no message made here carries a URL, and errors say what happened
 *   in words only.
 */
import { Api, GrammyError, HttpError } from "grammy";
import type { Message, Update } from "grammy/types";
import type { ChannelBindingRecord, SecretsRepository } from "@invisible-dots/database";
import {
  ChannelCredentialsError,
  ChannelNeedsRelinkError,
  ChannelSendError,
  type Channel,
  type ChannelCapabilities,
  type ChannelSink,
  type ChannelType,
} from "../channel.js";

export const TELEGRAM_TOKEN_SECRET = "telegram_bot_token";

export interface TelegramOptions {
  /** The Bot API root; default Telegram's. The tests point it at `FakeBotApi`. */
  apiRoot?: string;
  /** How long one poll waits for an update, in seconds. Default 30. */
  pollSeconds?: number;
}

/** `<bot id>:<secret>`; the shape also keeps anything that could change the URL path out of the token. */
const TOKEN_SHAPE = /^(\d{1,20}):[A-Za-z0-9_-]{8,}$/;
const START_WITH_CODE = /^\/start(?:@\w+)?\s+(\S+)\s*$/i;
const START_ALONE = /^\/start(?:@\w+)?\s*$/i;

const REFUSED_TOKEN =
  "Telegram refused the bot token: it is wrong, or it was revoked in @BotFather. Paste a current token.";

/** The Telegram error codes after which sending the same message again cannot work. */
const FINAL_SEND_CODES = new Set([400, 403, 404]);

/**
 * grammY's Node typings name the `AbortSignal` of the abort-controller package; at run time its fetch takes
 * Node's own, which is what this process has. One conversion here, so the calls stay typed.
 */
type GrammySignal = NonNullable<Parameters<Api["getMe"]>[0]>;
const forGrammy = (signal: AbortSignal): GrammySignal => signal as unknown as GrammySignal;

function botIdOf(token: string): string {
  const match = TOKEN_SHAPE.exec(token);
  if (!match) throw new ChannelCredentialsError("That is not a Telegram bot token: it looks like 123456789:AA... and comes from @BotFather.");
  return match[1]!;
}

/** What went wrong, in words, without the request URL (which holds the token). */
function describe(error: unknown, method: string, token: string): string {
  if (error instanceof GrammyError) return `Telegram answered ${error.error_code} (${error.description}) to ${method}`;
  if (error instanceof HttpError) return `could not reach Telegram (${method})`;
  const text = error instanceof Error ? error.message : String(error);
  return text.split(token).join("[redacted]");
}

class TelegramChannel implements Channel {
  readonly capabilities: ChannelCapabilities = { maxText: 4000, typing: true };
  readonly #api: Api;
  readonly #token: string;
  readonly #botId: string;
  readonly #pollSeconds: number;

  constructor(token: string, options: TelegramOptions) {
    this.#botId = botIdOf(token);
    this.#token = token;
    this.#pollSeconds = options.pollSeconds ?? 30;
    this.#api = new Api(token, options.apiRoot === undefined ? {} : { apiRoot: options.apiRoot });
  }

  async run(sink: ChannelSink, signal: AbortSignal): Promise<void> {
    try {
      await this.#poll(sink, signal);
    } catch (error) {
      // Stopping aborts the request that is in flight; that is the end of `run`, not a failure.
      if (!signal.aborted) throw error;
    }
  }

  async #poll(sink: ChannelSink, signal: AbortSignal): Promise<void> {
    const me = await this.#guard("getMe", () => this.#api.getMe(forGrammy(signal)));
    // A bot that still has a webhook cannot be polled; this bot is the Dot's own, so the webhook goes.
    await this.#guard("deleteWebhook", () => this.#api.deleteWebhook({ drop_pending_updates: false }, forGrammy(signal)));
    sink.status({ status: "connected", account: me.username });

    let offset: number | undefined;
    while (!signal.aborted) {
      const updates = await this.#guard("getUpdates", () =>
        this.#api.getUpdates({ offset, timeout: this.#pollSeconds, limit: 100, allowed_updates: ["message"] }, forGrammy(signal)),
      );
      for (const update of updates) {
        if (signal.aborted) return;
        await this.#handle(update, sink);
        offset = update.update_id + 1;
      }
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.#api.sendMessage(chatId, text);
    } catch (error) {
      throw this.#sendError(error);
    }
  }

  async typing(chatId: string): Promise<void> {
    await this.#api.sendChatAction(chatId, "typing");
  }

  async #handle(update: Update, sink: ChannelSink): Promise<void> {
    const message = update.message;
    if (!message?.from || message.from.is_bot) return;
    const peerId = String(message.from.id);
    const chatId = String(message.chat.id);
    const direct = message.chat.type === "private";
    const label = labelOf(message);
    const text = message.text ?? message.caption ?? "";

    if (direct && message.text !== undefined) {
      const code = START_WITH_CODE.exec(message.text)?.[1];
      if (code !== undefined) {
        await sink.pairing({ code, peerId, chatId, label });
        return;
      }
      // "Start" pressed on a bot nobody has paired: nothing to say to a stranger, nothing to pass on to the Dot.
      if (START_ALONE.test(message.text)) return;
    }
    // The update ids of two bots overlap, and a Dot's bot can be replaced: the bot's id keeps the ids apart.
    await sink.inbound({
      externalId: `${this.#botId}:${update.update_id}`,
      peerId,
      chatId,
      text,
      direct,
      label,
      ...(message.text === undefined && { attachment: true }),
    });
  }

  /** Run a Bot API call; a failure becomes what the hub understands, with no URL or token in its words. */
  async #guard<T>(method: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 401) throw new ChannelNeedsRelinkError(REFUSED_TOKEN);
      if (error instanceof GrammyError && error.error_code === 409) {
        throw new Error(
          "Telegram says another process is polling this bot (409 Conflict). A bot token serves one Dot on one running server: use a bot of its own for each Dot.",
        );
      }
      throw new Error(describe(error, method, this.#token));
    }
  }

  #sendError(error: unknown): Error {
    const reason = describe(error, "sendMessage", this.#token);
    if (error instanceof GrammyError) {
      const retryAfter = error.parameters.retry_after;
      if (error.error_code === 429) return new ChannelSendError(reason, { retryable: true, retryAfterMs: (retryAfter ?? 1) * 1000 });
      if (FINAL_SEND_CODES.has(error.error_code)) return new ChannelSendError(reason, { retryable: false });
    }
    return new Error(reason);
  }
}

function labelOf(message: Message): string | undefined {
  const from = message.from;
  if (!from) return undefined;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  if (from.username) return name ? `${name} (@${from.username})` : `@${from.username}`;
  return name || undefined;
}

export class TelegramChannelType implements ChannelType {
  readonly kind = "telegram" as const;
  readonly secretNames = [TELEGRAM_TOKEN_SECRET] as const;

  constructor(private readonly options: TelegramOptions = {}) {}

  async check(credentials: Record<string, string>): Promise<{ account: string }> {
    const token = credentials[TELEGRAM_TOKEN_SECRET];
    if (token === undefined) throw new ChannelCredentialsError("A Telegram channel needs the bot token from @BotFather.");
    botIdOf(token);
    try {
      const me = await new Api(token, this.options.apiRoot === undefined ? {} : { apiRoot: this.options.apiRoot }).getMe(forGrammy(AbortSignal.timeout(15_000)));
      return { account: me.username };
    } catch (error) {
      if (error instanceof GrammyError && (error.error_code === 401 || error.error_code === 404)) throw new ChannelCredentialsError(REFUSED_TOKEN);
      throw new Error(describe(error, "getMe", token));
    }
  }

  async create(binding: ChannelBindingRecord, secrets: Pick<SecretsRepository, "get">): Promise<Channel> {
    const token = await secrets.get(binding.dot_id, TELEGRAM_TOKEN_SECRET);
    if (!token) throw new Error("this Dot has no Telegram bot token stored");
    return new TelegramChannel(token, this.options);
  }

  pairingLink(account: string | null, code: string): string | null {
    return account === null ? null : `https://t.me/${account}?start=${code}`;
  }
}
