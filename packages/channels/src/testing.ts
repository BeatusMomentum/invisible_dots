/**
 * An in-memory channel for tests: no network, nothing mocked. FakeChannelType makes FakeChannels the way a
 * real type makes adapters, and a test plays the person (`receive`, `pair`) and the network (`crash`,
 * `sendFailures`) through them. `FakeBotApi` is a Bot API server the real Telegram adapter talks to.
 */
import type { ChannelBindingRecord, SecretsRepository } from "@invisible-dots/database";
import type { ChannelKind } from "@invisible-dots/shared";
import type { ApprovalPrompt, Channel, ChannelCapabilities, ChannelSink, ChannelType, InboundChat } from "./channel.js";

export * from "./telegram/fake-bot-api.js";

export class FakeChannel implements Channel {
  readonly sent: { chatId: string; text: string }[] = [];
  readonly typings: string[] = [];
  /** The approval prompts sent, in order; `ref` is what `editApproval` was given. */
  readonly prompts: { chatId: string; ref: string; approvalId: string; text: string }[] = [];
  readonly edits: { chatId: string; ref: string; text: string }[] = [];
  /** The sink while `run` is running; null before and after. */
  sink: ChannelSink | null = null;
  #crash: ((error: Error) => void) | null = null;
  #nextId = 1;

  constructor(
    private readonly type: FakeChannelType,
    readonly binding: ChannelBindingRecord,
    readonly capabilities: ChannelCapabilities,
  ) {}

  async run(sink: ChannelSink, signal: AbortSignal): Promise<void> {
    this.sink = sink;
    sink.status({ status: "connected", account: "fake_bot" });
    try {
      await new Promise<void>((resolve, reject) => {
        this.#crash = reject;
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      this.sink = null;
    }
  }

  /** The connection drops: `run` rejects with `error`. */
  crash(error: Error): void {
    this.#crash?.(error);
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const failure = this.type.sendFailures.shift();
    if (failure) throw failure;
    this.sent.push({ chatId, text });
  }

  async typing(chatId: string): Promise<void> {
    this.typings.push(chatId);
  }

  async sendApproval(chatId: string, prompt: ApprovalPrompt): Promise<string> {
    const failure = this.type.sendFailures.shift();
    if (failure) throw failure;
    const ref = `prompt-${this.prompts.length + 1}`;
    this.prompts.push({ chatId, ref, approvalId: prompt.approvalId, text: prompt.text });
    return ref;
  }

  async editApproval(chatId: string, ref: string, text: string): Promise<void> {
    const failure = this.type.sendFailures.shift();
    if (failure) throw failure;
    this.edits.push({ chatId, ref, text });
  }

  /** A person presses Approve or Reject on a prompt; resolves with the notice they are shown. */
  press(approvalId: string, decision: "approve" | "reject", peerId = "1", chatId = peerId, direct = true): Promise<string> {
    if (!this.sink) throw new Error("the fake channel is not running");
    return this.sink.approval({ approvalId, decision, peerId, chatId, direct });
  }

  /** A message arrives from a private chat (peer and chat "1", a new channel id each time) unless `message` says otherwise. */
  receive(message: Partial<InboundChat> & { text: string }): Promise<void> {
    if (!this.sink) throw new Error("the fake channel is not running");
    return this.sink.inbound({ externalId: `update-${this.#nextId++}`, peerId: "1", chatId: "1", direct: true, ...message });
  }

  /** Someone sends a pairing code. */
  pair(code: string, peerId = "1", chatId = peerId, label?: string): Promise<boolean> {
    if (!this.sink) throw new Error("the fake channel is not running");
    return this.sink.pairing({ code, peerId, chatId, label });
  }

  texts(chatId?: string): string[] {
    return this.sent.filter((m) => chatId === undefined || m.chatId === chatId).map((m) => m.text);
  }
}

export class FakeChannelType implements ChannelType {
  readonly secretNames = ["telegram_bot_token"];
  /** Every channel made, oldest first: a restart makes a new one. */
  readonly channels: FakeChannel[] = [];
  /** Each of the next `sendText` calls, on any channel, throws the next of these. */
  readonly sendFailures: Error[] = [];
  /** When set, `create` throws it (once, then it clears). */
  createFailure: Error | null = null;
  capabilities: ChannelCapabilities = { maxText: 4000, typing: true };

  constructor(readonly kind: ChannelKind = "telegram") {}

  async create(binding: ChannelBindingRecord, _secrets: Pick<SecretsRepository, "get">): Promise<Channel> {
    if (this.createFailure) {
      const failure = this.createFailure;
      this.createFailure = null;
      throw failure;
    }
    const channel = new FakeChannel(this, binding, this.capabilities);
    this.channels.push(channel);
    return channel;
  }

  pairingLink(account: string | null, code: string): string | null {
    return account === null ? null : `https://chat.test/${account}?start=${code}`;
  }

  get current(): FakeChannel {
    const channel = this.channels.at(-1);
    if (!channel) throw new Error("no fake channel was made yet");
    return channel;
  }
}
