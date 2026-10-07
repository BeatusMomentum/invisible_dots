/**
 * The line a person pastes at a prompt (an OpenRouter key, a bot token) is read with the echo off. The tests play the
 * terminal: a stream that says it is a TTY, takes raw mode and records what is written to the screen.
 */
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readSecretLine, SecretInputCancelled, type TerminalInput } from "../src/secret-input.js";

function terminal() {
  const input = new PassThrough() as PassThrough & TerminalInput & { raw: boolean[] };
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (mode: boolean) => void input.raw.push(mode);
  const screen: string[] = [];
  const output = { write: (text: string) => (screen.push(String(text)), true) };
  return { input, output, screen: () => screen.join("") };
}

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

describe("a secret typed at a prompt", () => {
  it("would show on the screen if the line were read by a readline that writes there (so the checks below can fail)", async () => {
    const t = terminal();
    const echoed: string[] = [];
    const screen = new Writable({
      write(chunk, _encoding, done) {
        echoed.push(String(chunk));
        done();
      },
    });
    const lines = createInterface({ input: t.input, output: screen, terminal: true });
    const line = new Promise<string>((resolve) => lines.once("line", resolve));
    t.input.write(`${KEY}\r`);
    await line;
    lines.close();
    expect(echoed.join("")).toContain(KEY);
  });

  it("is read as typed, and nothing of it is written to the screen, not as it is typed and not after", async () => {
    const t = terminal();
    const read = readSecretLine(t.input, t.output);
    t.input.write(KEY);
    t.input.write("\r");
    expect(await read).toBe(KEY);
    // Only the newline that Enter would have echoed: the next line of output does not follow the prompt.
    expect(t.screen()).toBe("\n");
    expect(t.screen()).not.toContain("sk-or");
  });

  it("is read when it arrives in pieces, as a paste does, and keeps what backspace did not take", async () => {
    const t = terminal();
    const read = readSecretLine(t.input, t.output);
    t.input.write("123456:AA");
    t.input.write("BBxx\u007f\u007fCC");
    t.input.write("\n");
    expect(await read).toBe("123456:AABBCC");
    expect(t.screen()).toBe("\n");
  });

  it("is given up at Ctrl-C, with nothing of what was typed shown", async () => {
    const t = terminal();
    const read = readSecretLine(t.input, t.output);
    t.input.write("half of a key");
    t.input.write("\u0003");
    await expect(read).rejects.toBeInstanceOf(SecretInputCancelled);
    expect(t.screen()).not.toContain("half");
  });

  it("returns what was typed when the input ends before Enter", async () => {
    const t = terminal();
    const read = readSecretLine(t.input, t.output);
    t.input.write("abc");
    t.input.end();
    expect(await read).toBe("abc");
  });

  it("puts the terminal back as it found it", async () => {
    const t = terminal();
    const read = readSecretLine(t.input, t.output);
    t.input.write("x\r");
    await read;
    expect(t.input.raw.at(-1)).toBe(false);
  });
});
