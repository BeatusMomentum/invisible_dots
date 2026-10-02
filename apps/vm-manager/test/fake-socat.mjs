// Stands in for socat in the bridge tests: listens on the UNIX-LISTEN path of
// its first argument and answers every connection with a tiny HTTP response.
// FAKE_SOCAT_EXIT_AFTER_MS makes it exit with code 3 after that long, to
// exercise the restart path; FAKE_SOCAT_FAIL makes it exit at once.
import { createServer } from "node:net";

const listen = process.argv[2] ?? "";
const connectTo = process.argv[3] ?? "";
const match = /^UNIX-LISTEN:([^,]+),fork,mode=600$/.exec(listen);
if (!match || !/^VSOCK-CONNECT:\d+:1024$/.test(connectTo)) {
  process.stderr.write(`fake-socat: unexpected arguments ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}
if (process.env.FAKE_SOCAT_FAIL) {
  process.stderr.write("fake-socat: E connect(5, AF=40 cid:1 port:1024): Connection refused\n");
  process.exit(1);
}

const server = createServer((socket) => {
  socket.on("error", () => {});
  socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
});
server.listen(match[1]);

const exitAfter = Number(process.env.FAKE_SOCAT_EXIT_AFTER_MS ?? 0);
if (exitAfter > 0) setTimeout(() => process.exit(3), exitAfter);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
