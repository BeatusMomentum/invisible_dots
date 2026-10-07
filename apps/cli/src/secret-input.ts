/**
 * One line a person types in the terminal that must not show: an API key or a bot token pasted at a prompt. The
 * terminal's own echo would leave it in the scrollback and in any session recording, so the line is read through a
 * readline whose output is a stream that swallows what it is given: readline still handles the keys (backspace,
 * Ctrl-U, paste) and the terminal is in raw mode, but nothing of the value is written back to the screen.
 */
import { createInterface } from "node:readline";
import { Writable, type Readable } from "node:stream";

/** What a terminal's input is to this reader: a stream that may be put in raw mode. */
export type TerminalInput = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

/** The person pressed Ctrl-C at the prompt. */
export class SecretInputCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * Read one line from `input` with the echo off, then write one newline to `output` (Enter was not echoed either,
 * and the next line of output must not follow the prompt on the same line). The line is returned as typed; an end
 * of input before Enter returns what was typed so far.
 */
export function readSecretLine(input: TerminalInput, output: Pick<Writable, "write">): Promise<string> {
  return new Promise((resolve, reject) => {
    const swallowed = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const lines = createInterface({ input, output: swallowed, terminal: true, historySize: 0 });
    let line = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      lines.close();
      output.write("\n");
      settle();
    };
    lines.once("line", (text) => {
      line = text;
      finish(() => resolve(line));
    });
    lines.once("SIGINT", () => finish(() => reject(new SecretInputCancelled())));
    lines.once("close", () => finish(() => resolve(line)));
  });
}
