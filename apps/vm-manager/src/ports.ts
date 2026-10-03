/**
 * The guest port of section 3.5: bind port 0 on 127.0.0.1, read the port the
 * kernel chose, release it and hand it to QEMU. Another process can take it in
 * between, which is why the start retries when QEMU reports the forward could
 * not be set up. Asking the kernel also keeps clear of ports Windows reserves
 * (Hyper-V's excluded ranges), which a fixed or random choice could hit.
 */
import { connect, createServer } from "node:net";

export const GUEST_PORT_HOST = "127.0.0.1";

export function pickFreePort(host: string = GUEST_PORT_HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error(`could not read the port bound on ${host}`))));
    });
  });
}

/**
 * Whether something accepts TCP connections on 127.0.0.1:`port`. QEMU's user
 * networking listens on a Dot's guest port from the moment its netdev is set
 * up until the process exits, whether or not the guest inside is up, and the
 * kernel completes the handshake for a listening socket. So "the recorded pid
 * is alive AND its recorded guest port listens" is what tells our QEMU from a
 * process that inherited a recycled pid, the same way on both hosts.
 */
export function portListens(port: number, host: string = GUEST_PORT_HOST, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (listens: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listens);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
