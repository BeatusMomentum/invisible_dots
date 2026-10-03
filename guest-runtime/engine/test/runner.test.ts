/**
 * The runner on its own: a unit driven against a real `dot.db`, a scripted
 * model and a counting registry, without the HTTP fake or the driver.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bench, call, type Bench } from "./bench.js";

let b: Bench | undefined;
afterEach(() => {
  b?.close();
  b = undefined;
});

describe("AgentRunner", () => {
  it("runs the calls of one answer one at a time, in the model's order", async () => {
    b = bench();
    let running = 0;
    let overlap = 0;
    const slow = async () => {
      running++;
      overlap = Math.max(overlap, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return { ok: true, text: "done" };
    };
    b.registry.handlers.set("files_read", slow);
    b.registry.handlers.set("files_list", slow);
    b.model.script.push(() => ({ calls: [call("a", "files_read", { path: "x" }), call("b", "files_list", { path: "." })] }), () => ({ text: "ok" }));
    expect(await b.run()).toEqual({ status: "completed", output: "ok" });
    expect(overlap).toBe(1);
    expect(b.registry.calls.map((c) => c.name)).toEqual(["files_read", "files_list"]);
    expect(b.thread().filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(["a", "b"]);
  });
});
