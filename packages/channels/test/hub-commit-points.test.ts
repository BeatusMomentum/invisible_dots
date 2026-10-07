/**
 * What the person did to a channel, and what the channel reported, commits together with the host event that tells it, or
 * neither does: a control plane killed between the two statements leaves the channel as it was, never changed with
 * nobody told. Each test plays the kill by making one write of the change throw (`killedAt`, database/testing).
 */
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, killedAt, type TestDatabase } from "@invisible-dots/database/testing";
import { waitFor } from "@invisible-dots/scheduler/testing";
import type { StoredEvent } from "@invisible-dots/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeChannelType } from "../src/testing.js";
import { makeWorlds, quiet } from "./world.js";

describe("the commit points of the channel hub", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Database;
  let world: ReturnType<typeof makeWorlds>["world"];
  let closeAll: ReturnType<typeof makeWorlds>["closeAll"];

  beforeAll(async () => {
    t = await createTestDatabase("pglite");
    db = t.db;
    ({ world, closeAll } = makeWorlds(db));
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
  }, 60_000);

  afterEach(async () => {
    await closeAll();
    await db.query("DELETE FROM channel_bindings");
  });

  afterAll(async () => {
    await t?.drop();
  });

  const eventsOf = async (dotId: string, type: string): Promise<StoredEvent[]> => db.events.list({ dotId, types: [type] });

  it("a status killed at its write is not announced and not recorded; the report that comes next is both", async () => {
    const killed = killedAt(db, "channels", "setStatus");
    const w = await world();
    const { hub, type } = await w.hub<FakeChannelType>(undefined, { db: killed.db });
    const dot = await w.dot();

    killed.kill();
    await hub.add(dot.id, "telegram");
    const first = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the channel");
    await quiet();
    expect(await eventsOf(dot.id, "channel.status")).toEqual([]);
    expect((await hub.list(dot.id))[0]!.status).toBe("connecting");

    killed.revive();
    first.crash(new Error("boom"));
    await waitFor(async () => (await eventsOf(dot.id, "channel.status")).length >= 2, "the error and the connection again");
    expect((await eventsOf(dot.id, "channel.status")).map((e) => e.data.status)).toEqual(["error", "connected"]);
  });

  it("a pause killed at its write is not announced and does not happen; a pause that happens is announced", async () => {
    const killed = killedAt(db, "channels", "setEnabled");
    const w = await world();
    const { hub } = await w.hub<FakeChannelType>(undefined, { db: killed.db });
    const dot = await w.dot();
    await hub.add(dot.id, "telegram");

    killed.kill();
    await expect(hub.setEnabled(dot.id, "telegram", false)).rejects.toThrow(/killed at channels.setEnabled/);
    expect(await eventsOf(dot.id, "channel.changed")).toEqual([]);
    expect((await hub.list(dot.id))[0]!.enabled).toBe(true);

    killed.revive();
    expect((await hub.setEnabled(dot.id, "telegram", false)).enabled).toBe(false);
    expect((await eventsOf(dot.id, "channel.changed")).map((e) => e.data.change)).toEqual(["paused"]);
  });

  it("a removal killed at its write is not announced and the channel is still there", async () => {
    const killed = killedAt(db, "channels", "deleteBinding");
    const w = await world();
    const { hub } = await w.hub<FakeChannelType>(undefined, { db: killed.db });
    const dot = await w.dot();
    await hub.add(dot.id, "telegram");

    killed.kill();
    await expect(hub.remove(dot.id, "telegram")).rejects.toThrow(/killed at channels.deleteBinding/);
    expect(await eventsOf(dot.id, "channel.changed")).toEqual([]);
    expect(await hub.list(dot.id)).toHaveLength(1);

    killed.revive();
    await hub.remove(dot.id, "telegram");
    expect((await eventsOf(dot.id, "channel.changed")).map((e) => e.data.change)).toEqual(["removed"]);
    expect(await hub.list(dot.id)).toEqual([]);
  });

  it("a pairing killed at its write is not announced, the person is not paired and the code is still good", async () => {
    const killed = killedAt(db, "channels", "upsertPeer");
    const w = await world();
    const { hub, type } = await w.hub<FakeChannelType>(undefined, { db: killed.db });
    const dot = await w.dot();
    await hub.add(dot.id, "telegram");
    const channel = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the channel");
    const { code } = await hub.pair(dot.id, "telegram");

    killed.kill();
    await expect(channel.pair(code, "10", "10", "Ann")).rejects.toThrow(/killed at channels.upsertPeer/);
    expect(await eventsOf(dot.id, "channel.peer.paired")).toEqual([]);
    expect((await hub.list(dot.id))[0]!.peers).toEqual([]);

    killed.revive();
    expect(await channel.pair(code, "10", "10", "Ann")).toBe(true);
    expect((await eventsOf(dot.id, "channel.peer.paired")).map((e) => e.data.peer_id)).toEqual(["10"]);
  });
});
