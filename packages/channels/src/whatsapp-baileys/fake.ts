/**
 * A WhatsApp connection for tests: no network, nothing mocked. A test plays WhatsApp through it (a code to
 * scan, a message from a person, a connection that drops) and reads what the channel sent. It is what
 * `WhatsAppChannel` runs on in every test; the real network is not tested.
 */
import type { WhatsAppConnection, WhatsAppConnector, WhatsAppContent, WhatsAppEnd, WhatsAppEvents, WhatsAppIncoming } from "./port.js";

export class FakeWhatsAppConnection implements WhatsAppConnection {
  readonly sent: { chat: string; id: string; text: string }[] = [];
  readonly edits: { chat: string; id: string; text: string }[] = [];
  readonly reads: { chat: string; id: string }[] = [];
  readonly typings: string[] = [];
  closed = false;
  #nextId = 1;
  #nextIncoming = 1;

  constructor(
    private readonly connector: FakeWhatsAppConnector,
    readonly events: WhatsAppEvents,
  ) {}

  // What the channel does

  async sendText(chat: string, text: string): Promise<string> {
    this.#assertOpen();
    const failure = this.connector.sendFailures.shift();
    if (failure) throw failure;
    const id = `sent-${this.#nextId++}`;
    this.sent.push({ chat, id, text });
    return id;
  }

  async editText(chat: string, id: string, text: string): Promise<void> {
    this.#assertOpen();
    this.edits.push({ chat, id, text });
  }

  async markRead(message: { chat: string; id: string }): Promise<void> {
    this.#assertOpen();
    this.reads.push(message);
  }

  async typing(chat: string): Promise<void> {
    this.#assertOpen();
    this.typings.push(chat);
  }

  async phoneForLid(lid: string): Promise<string | null> {
    return this.connector.phonesByLid.get(lid) ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  #assertOpen(): void {
    if (this.closed) throw new Error("the fake WhatsApp connection is closed");
  }

  // What WhatsApp does

  showCode(code: string): void {
    this.events.code(code);
  }

  /** The account is linked and connected. */
  open(phone: string | null = "15550001111"): void {
    this.events.open({ phone });
  }

  /** A person writes: from `chat` (a phone or LID address), with ids that are new each time. */
  receive(chat: string, content: string | WhatsAppContent, more: Partial<WhatsAppIncoming> = {}): void {
    this.events.message({
      id: `msg-${this.#nextIncoming++}`,
      chat,
      fromMe: false,
      content: typeof content === "string" ? { kind: "text", text: content } : content,
      ...more,
    });
  }

  end(end: WhatsAppEnd): void {
    this.events.end(end);
  }

  texts(chat?: string): string[] {
    return this.sent.filter((m) => chat === undefined || m.chat === chat).map((m) => m.text);
  }
}

export class FakeWhatsAppConnector implements WhatsAppConnector {
  /** Every connection made, oldest first: a restart makes a new one. */
  readonly connections: FakeWhatsAppConnection[] = [];
  /** The numbers behind LIDs that the account has learned. */
  readonly phonesByLid = new Map<string, string>();
  /** Each of the next `sendText` calls, on any connection, throws the next of these. */
  readonly sendFailures: Error[] = [];
  /** When set, `connect` rejects with it (once, then it clears). */
  connectFailure: Error | null = null;

  async connect(events: WhatsAppEvents): Promise<WhatsAppConnection> {
    if (this.connectFailure) {
      const failure = this.connectFailure;
      this.connectFailure = null;
      throw failure;
    }
    const connection = new FakeWhatsAppConnection(this, events);
    this.connections.push(connection);
    return connection;
  }

  get current(): FakeWhatsAppConnection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error("no fake WhatsApp connection was made yet");
    return connection;
  }
}
