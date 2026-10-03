/** The `invisible-dots` executable: wires `run` to the real process. */
import { createInterface } from "node:readline";
import { commandOf, run } from "./cli.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** One line from the terminal: Enter ends it on Linux and on Windows alike. */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, terminal: false });
    let line = "";
    lines.once("line", (text) => {
      line = text;
      lines.close();
    });
    lines.once("close", () => resolve(line));
  });
}

const argv = process.argv.slice(2);
const command = commandOf(argv);
const controller = new AbortController();

// What Ctrl-C does depends on the command. `logs` ends cleanly. `image build`
// is asked to stop, so it can kill its builder VM, and a second Ctrl-C exits
// at once. `server` installs its own handlers (it closes the database before
// exiting). Every other command keeps Node's default: exit immediately.
if (command === "logs" || command === "image") {
  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  });
}

const code = await run(argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  readLine,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
});
process.exitCode = code;
// After a clean stop the server has nothing left to say, but a database or
// VM-manager handle may still hold the event loop; the server's own bin
// exits the same way. Other commands end naturally, which lets piped output
// flush on Windows, where pipe writes are asynchronous.
if (command === "server") process.exit(code);
