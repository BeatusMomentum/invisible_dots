/**
 * A Bot API server for tests: a real HTTP server on a local port that speaks the part of the Telegram Bot
 * API the adapter uses (`getMe`, `getUpdates`, `deleteWebhook`, `sendMessage`, `sendChatAction`), with
 * Telegram's observable behaviour where the adapter depends on it: a long poll that waits for an update,
 * an offset that confirms what came before it, a 409 for a second poller (Telegram ends the older poll),
 * a 409 while a webhook is set, a 401 for an unknown or revoked token, a 429 with `retry_after`, a 403 for
 * a person who blocked the bot. The real grammY client points at it with `apiRoot`; nothing is mocked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakePerson {
  id: number;
  first_name?: string;
  username?: string;
}

export interface FakeAnswer {
  error_code: number;
  description: string;
  /** Makes it a 429 with this wait. */
  retry_after?: number;
}

interface FakeUpdate {
  update_id: number;
  message: Record<string, unknown>;
}

interface Poll {
  res: ServerResponse;
  timer: NodeJS.Timeout;
  limit: number;
}

interface FakeBot {
  token: string;
  id: number;
  username: string;
  revoked: boolean;
  /** Chats whose person blocked the bot. */
  blocked: Set<string>;
  nextUpdateId: number;
  /** Updates Telegram holds: not yet confirmed by an offset. */
  queue: FakeUpdate[];
  /** Every update ever made, for `redeliver`. */
  history: FakeUpdate[];
  poll: Poll | null;
  webhook: string | null;
  sent: { chat_id: string; text: string }[];
  actions: { chat_id: string; action: string }[];
  /** How many `getUpdates` calls arrived. */
  polls: number;
  /** The `offset` of the last poll that had one. */
  confirmedOffset: number | null;
}

interface Injection {
  token: string;
  method: string;
  answer: FakeAnswer | "drop";
  remaining: number;
}

export class FakeBotApi {
  /** Every request, in order, with the token from its path: the tests look for a token that must not leak. */
  readonly requests: { method: string; token: string }[] = [];
  readonly #server: Server;
  readonly #bots = new Map<string, FakeBot>();
  readonly #injections: Injection[] = [];
  #messageIds = 1;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<FakeBotApi> {
    const server = createServer();
    const fake = new FakeBotApi(server);
    server.on("request", (req, res) => void fake.#handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  /** What to give grammY as `apiRoot`. */
  get apiRoot(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const bot of this.#bots.values()) this.#endPoll(bot, []);
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  // The world the tests set up

  /** A bot that exists: its id is the number before the colon of its token. */
  addBot(token: string, username = "fake_bot"): void {
    this.#bots.set(token, {
      token,
      id: Number(token.split(":")[0]),
      username,
      revoked: false,
      blocked: new Set(),
      nextUpdateId: 1000,
      queue: [],
      history: [],
      poll: null,
      webhook: null,
      sent: [],
      actions: [],
      polls: 0,
      confirmedOffset: null,
    });
  }

  /** The token is revoked in @BotFather: every call answers 401 from now on. */
  revoke(token: string): void {
    this.#bot(token).revoked = true;
    this.#endPoll(this.#bot(token), { error_code: 401, description: "Unauthorized" });
  }

  setWebhook(token: string, url: string | null): void {
    this.#bot(token).webhook = url;
  }

  /** Sending to this chat answers 403, as it does when the person blocked the bot. */
  blockChat(token: string, chatId: number | string): void {
    this.#bot(token).blocked.add(String(chatId));
  }

  /** The next `times` calls of `method` by this bot fail with `answer`, or the connection drops (`"drop"`). */
  failNext(token: string, method: string, answer: FakeAnswer | "drop", times = 1): void {
    this.#injections.push({ token, method, answer, remaining: times });
  }

  /** A person writes to the bot (a private chat with them, unless `chat` says otherwise). Returns the update id. */
  say(token: string, text: string, from: FakePerson = { id: 10, first_name: "Ann" }, chat?: { id: number; type: string }): number {
    return this.#deliver(token, from, chat, { text });
  }

  /** A person sends a photo (no text). */
  sendPhoto(token: string, from: FakePerson = { id: 10, first_name: "Ann" }, caption?: string): number {
    return this.#deliver(token, from, undefined, { photo: [{ file_id: "photo-1", file_unique_id: "p1", width: 1, height: 1 }], ...(caption !== undefined && { caption }) });
  }

  /** Telegram offers an update again, as it does when the bot died before it confirmed it. */
  redeliver(token: string, updateId: number): void {
    const bot = this.#bot(token);
    const update = bot.history.find((u) => u.update_id === updateId);
    if (!update) throw new Error(`the fake bot has no update ${updateId}`);
    bot.queue.push(update);
    if (bot.poll) this.#endPoll(bot, bot.queue.slice(0, bot.poll.limit));
  }

  // What the tests look at

  sent(token: string, chatId?: number | string): { chat_id: string; text: string }[] {
    return this.#bot(token).sent.filter((m) => chatId === undefined || m.chat_id === String(chatId));
  }

  /** Forget what was sent so far, to look at only what comes next. */
  clearSent(token: string): void {
    const bot = this.#bot(token);
    bot.sent.length = 0;
    bot.actions.length = 0;
  }

  actions(token: string): { chat_id: string; action: string }[] {
    return [...this.#bot(token).actions];
  }

  /** Updates Telegram still holds for the bot: not confirmed by an offset yet. */
  unconfirmed(token: string): number[] {
    return this.#bot(token).queue.map((u) => u.update_id);
  }

  polls(token: string): number {
    return this.#bot(token).polls;
  }

  webhook(token: string): string | null {
    return this.#bot(token).webhook;
  }

  /** True while a long poll is waiting. */
  polling(token: string): boolean {
    return this.#bot(token).poll !== null;
  }

  // The server

  #bot(token: string): FakeBot {
    const bot = this.#bots.get(token);
    if (!bot) throw new Error("the fake bot API has no such bot");
    return bot;
  }

  #deliver(token: string, from: FakePerson, chat: { id: number; type: string } | undefined, content: Record<string, unknown>): number {
    const bot = this.#bot(token);
    const update: FakeUpdate = {
      update_id: bot.nextUpdateId++,
      message: {
        message_id: this.#messageIds++,
        date: Math.floor(Date.now() / 1000),
        chat: chat ?? { id: from.id, type: "private", first_name: from.first_name ?? "Person" },
        from: { is_bot: false, first_name: "Person", ...from },
        ...content,
      },
    };
    bot.history.push(update);
    bot.queue.push(update);
    if (bot.poll) this.#endPoll(bot, bot.queue.slice(0, bot.poll.limit));
    return update.update_id;
  }

  #endPoll(bot: FakeBot, result: FakeUpdate[] | FakeAnswer): void {
    const poll = bot.poll;
    if (!poll) return;
    bot.poll = null;
    clearTimeout(poll.timer);
    if (Array.isArray(result)) reply(poll.res, 200, { ok: true, result });
    else fail(poll.res, result);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = /^\/bot([^/]+)\/(\w+)$/.exec((req.url ?? "").split("?")[0]!);
    if (!url) return fail(res, { error_code: 404, description: "Not Found" });
    const [, token, method] = url as unknown as [string, string, string];
    this.requests.push({ method, token });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown> = {};
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail(res, { error_code: 400, description: "Bad Request: invalid JSON" });
    }

    const bot = this.#bots.get(decodeURIComponent(token));
    if (!bot || bot.revoked) return fail(res, { error_code: 401, description: "Unauthorized" });

    const injection = this.#injections.find((i) => i.token === bot.token && i.method === method && i.remaining > 0);
    if (injection) {
      injection.remaining--;
      if (injection.answer === "drop") return void req.socket.destroy();
      return fail(res, injection.answer);
    }

    switch (method) {
      case "getMe":
        return reply(res, 200, { ok: true, result: { id: bot.id, is_bot: true, first_name: "Fake Bot", username: bot.username } });
      case "deleteWebhook":
        bot.webhook = null;
        return reply(res, 200, { ok: true, result: true });
      case "getUpdates":
        return this.#getUpdates(bot, body, res);
      case "sendMessage": {
        const chatId = String(body.chat_id);
        if (bot.blocked.has(chatId)) return fail(res, { error_code: 403, description: "Forbidden: bot was blocked by the user" });
        const text = body.text;
        if (typeof text !== "string" || text === "") return fail(res, { error_code: 400, description: "Bad Request: message text is empty" });
        if (text.length > 4096) return fail(res, { error_code: 400, description: "Bad Request: message is too long" });
        bot.sent.push({ chat_id: chatId, text });
        return reply(res, 200, { ok: true, result: { message_id: this.#messageIds++, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: "private" }, text } });
      }
      case "sendChatAction":
        bot.actions.push({ chat_id: String(body.chat_id), action: String(body.action) });
        return reply(res, 200, { ok: true, result: true });
      default:
        return fail(res, { error_code: 404, description: "Not Found" });
    }
  }

  #getUpdates(bot: FakeBot, body: Record<string, unknown>, res: ServerResponse): void {
    bot.polls++;
    if (bot.webhook !== null) {
      return fail(res, { error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" });
    }
    // Telegram ends the older poll when a newer one arrives.
    this.#endPoll(bot, { error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" });
    if (typeof body.offset === "number") {
      bot.confirmedOffset = body.offset;
      bot.queue = bot.queue.filter((u) => u.update_id >= (body.offset as number));
    }
    const limit = typeof body.limit === "number" ? body.limit : 100;
    if (bot.queue.length > 0) return reply(res, 200, { ok: true, result: bot.queue.slice(0, limit) });
    const seconds = typeof body.timeout === "number" ? body.timeout : 0;
    const timer = setTimeout(() => this.#endPoll(bot, []), seconds * 1000);
    bot.poll = { res, timer, limit };
    res.on("close", () => {
      if (bot.poll?.res === res) {
        clearTimeout(timer);
        bot.poll = null;
      }
    });
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, answer: FakeAnswer): void {
  const retry = answer.retry_after;
  const code = retry === undefined ? answer.error_code : 429;
  reply(res, code, {
    ok: false,
    error_code: code,
    description: retry === undefined ? answer.description : `Too Many Requests: retry after ${retry}`,
    ...(retry !== undefined && { parameters: { retry_after: retry } }),
  });
}
