import { describe, expect, it } from "vitest";
import { SseParser, type SseMessage } from "../src/index.js";

function feedAll(parser: SseParser, chunks: string[]): SseMessage[] {
  return chunks.flatMap((chunk) => parser.feed(chunk));
}

describe("SseParser", () => {
  it("parses a complete message with id and event name", () => {
    const messages = new SseParser().feed('id: 7\nevent: task.started\ndata: {"a":1}\n\n');
    expect(messages).toEqual([{ event: "task.started", data: '{"a":1}', id: "7", retry: null }]);
  });

  it("joins multi-line data and defaults the event name to message", () => {
    const messages = new SseParser().feed("data: one\ndata: two\n\n");
    expect(messages).toEqual([{ event: "message", data: "one\ntwo", id: null, retry: null }]);
  });

  it("handles messages split at any point across chunks", () => {
    const text = 'id: 1\ndata: {"x":"hello"}\n\nid: 2\ndata: second\n\n';
    for (let cut = 1; cut < text.length; cut++) {
      const messages = feedAll(new SseParser(), [text.slice(0, cut), text.slice(cut)]);
      expect(messages.map((m) => [m.id, m.data])).toEqual([
        ["1", '{"x":"hello"}'],
        ["2", "second"],
      ]);
    }
  });

  it("assembles messages fed one character at a time with mixed line endings", () => {
    const parser = new SseParser();
    const text = ': hello\r\nid: 1\r\ndata: {"a":\r\ndata: 1}\r\n\r\nid: 2\nevent: x\ndata: two\n\n';
    const out = feedAll(parser, [...text]);
    expect(out.map((m) => [m.id, m.event, m.data])).toEqual([
      ["1", "message", '{"a":\n1}'],
      ["2", "x", "two"],
    ]);
  });

  it("handles split chunks with multi-line data and a CR left at the end of a chunk", () => {
    const parser = new SseParser();
    expect(parser.feed("id: 1\ndata: a\nda")).toEqual([]);
    expect(parser.feed("ta: b\n")).toEqual([]);
    expect(parser.feed("\n").map((m) => [m.id, m.data])).toEqual([["1", "a\nb"]]);
    expect(parser.feed("event: x\ndata:c\r")).toEqual([]);
    expect(parser.feed("\n\r\n").map((m) => [m.event, m.data])).toEqual([["x", "c"]]);
  });

  it("treats CRLF split between two chunks as one line break", () => {
    const messages = feedAll(new SseParser(), ["data: a\r", "\n\r", "\n"]);
    expect(messages).toEqual([{ event: "message", data: "a", id: null, retry: null }]);
  });

  it("accepts bare CR line endings", () => {
    expect(new SseParser().feed("data: a\r\r").map((m) => m.data)).toEqual(["a"]);
  });

  it("ignores comments, unknown fields and blocks without data", () => {
    const messages = new SseParser().feed(": keep-alive\n\nfoo: bar\n\nevent: x\n\ndata: y\n\n");
    expect(messages).toEqual([{ event: "message", data: "y", id: null, retry: null }]);
  });

  it("keeps the last id across messages and reads retry", () => {
    const messages = new SseParser().feed("id: 5\ndata: a\n\nretry: 2500\ndata: b\n\n");
    expect(messages.map((m) => [m.id, m.retry])).toEqual([
      ["5", null],
      ["5", 2500],
    ]);
  });

  it("strips a leading byte order mark", () => {
    expect(new SseParser().feed(`${String.fromCharCode(0xfeff)}data: a\n\n`).map((m) => m.data)).toEqual(["a"]);
  });

  it("keeps a value without the optional leading space intact", () => {
    expect(new SseParser().feed("data:  two spaces\n\n").map((m) => m.data)).toEqual([" two spaces"]);
  });
});
