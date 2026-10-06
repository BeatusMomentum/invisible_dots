/** The `invisible-dots` executable: wires `run` to the real process. */
import { commandOf, interruptIsAsked, run } from "./cli.js";
import { readSecretLine } from "./secret-input.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}


const argv = process.argv.slice(2);
const command = commandOf(argv);
const controller = new AbortController();

// What Ctrl-C does depends on the command. `logs` ends cleanly. `image build`
// (and `setup --all`, which ends with it) is asked to stop, so it can kill its
// builder VM, and a second Ctrl-C exits at once. `server` installs its own
// handlers (it closes the database before exiting). Every other command keeps
// Node's default: exit immediately.
if (interruptIsAsked(argv)) {
  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  });
}

const code = await run(argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  readSecret: () => readSecretLine(process.stdin, process.stderr),
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
