// A local HTTP server standing in for cloud-images.ubuntu.com, nodejs.org and
// GitHub releases, so downloads are tested through the real fetch and sockets.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Route =
  | { body: Buffer | string; status?: number }
  | { redirect: string }
  /** Sends `prefix`, then never finishes: a stalled transfer. */
  | { stallAfter: Buffer };

export interface FakeHttp {
  url(path: string): string;
  /** Paths requested so far, in order. */
  requests: string[];
  set(path: string, route: Route): void;
  close(): Promise<void>;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function startFakeHttp(routes: Record<string, Route> = {}): Promise<FakeHttp> {
  const table = new Map(Object.entries(routes));
  const requests: string[] = [];
  const open = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    requests.push(path);
    const route = table.get(path);
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    if ("redirect" in route) {
      res.writeHead(302, { location: route.redirect }).end();
      return;
    }
    if ("stallAfter" in route) {
      res.writeHead(200, { "content-length": String(route.stallAfter.length + 1000) });
      res.write(route.stallAfter);
      return;
    }
    const body = typeof route.body === "string" ? Buffer.from(route.body) : route.body;
    res.writeHead(route.status ?? 200, { "content-length": String(body.length) }).end(body);
  });
  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    requests,
    set: (path, route) => table.set(path, route),
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
