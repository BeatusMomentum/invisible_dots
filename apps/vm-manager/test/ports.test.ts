import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { pickFreePort } from "../src/index.js";

describe("pickFreePort", () => {
  it("returns a port on 127.0.0.1 that can be bound again right away", async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("gives different ports to back-to-back calls most of the time", async () => {
    const ports = new Set(await Promise.all([pickFreePort(), pickFreePort(), pickFreePort()]));
    expect(ports.size).toBeGreaterThan(1);
  });
});
