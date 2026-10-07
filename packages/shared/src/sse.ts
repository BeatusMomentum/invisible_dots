/**
 * Incremental parser for the text/event-stream format (WHATWG HTML,
 * "Server-sent events"), shared by every SSE reader: the SDK and the web
 * client on `/api/stream`, the vm-manager on the guest's `/events/stream`.
 * Readers use fetch or node:http rather than EventSource, which cannot send a
 * bearer token and drops named events that have no listener.
 */

export interface SseMessage {
  /** The `event:` field, "message" when absent. */
  event: string;
  data: string;
  /** The last event id seen on the stream so far, as the spec defines it. */
  id: string | null;
  retry: number | null;
}

/** Feed it text in any chunking; it returns the messages completed by that chunk. */
export class SseParser {
  #buffer = "";
  #data: string[] = [];
  #event = "";
  #retry: number | null = null;
  #lastId: string | null = null;
  #first = true;
  /** A chunk ended with "\r": a following "\n" belongs to the same line break. */
  #pendingCr = false;

  feed(chunk: string): SseMessage[] {
    let text = chunk;
    if (this.#first && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.#first = false;
    }
    if (this.#pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.#pendingCr = false;
    this.#buffer += text;

    const out: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.#buffer.length; i++) {
      const ch = this.#buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      const line = this.#buffer.slice(start, i);
      if (ch === "\r") {
        if (i + 1 < this.#buffer.length) {
          if (this.#buffer[i + 1] === "\n") i++;
        } else {
          this.#pendingCr = true;
        }
      }
      start = i + 1;
      const message = this.#line(line);
      if (message) out.push(message);
    }
    this.#buffer = this.#buffer.slice(start);
    return out;
  }

  #line(line: string): SseMessage | null {
    if (line === "") return this.#dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.#data.push(value);
        break;
      case "event":
        this.#event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.#lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.#retry = Number(value);
        break;
      default:
        break;
    }
    return null;
  }

  #dispatch(): SseMessage | null {
    const hasData = this.#data.length > 0;
    const message: SseMessage = {
      event: this.#event || "message",
      data: this.#data.join("\n"),
      id: this.#lastId,
      retry: this.#retry,
    };
    this.#data = [];
    this.#event = "";
    this.#retry = null;
    return hasData ? message : null;
  }
}
