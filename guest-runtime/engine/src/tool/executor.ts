// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Tool executor with error isolation.
 *
 * Runs one call through the {@link ToolRegistry}, which validates the
 * arguments against the tool's JSON Schema, and surfaces any execution error
 * as a {@link ToolResult} rather than a thrown exception, so the model can
 * read what went wrong.
 */
import type { ParsedToolCall } from "@invisible-dots/openrouter-client";
import type { Logger } from "../types.js";
import type { ToolContext, ToolRegistry, ToolResult } from "./framework.js";

export interface ToolExecution {
  readonly result: ToolResult;
  /** Wall-clock duration of the call in milliseconds. */
  readonly durationMs: number;
}

/**
 * Executes tools from a {@link ToolRegistry}.
 *
 * All errors, including unknown tool names, validation failures and
 * exceptions thrown by a tool, come back as results with `ok: false`; this
 * class never rejects.
 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly log: Logger,
  ) {}

  async execute(call: ParsedToolCall, context: ToolContext): Promise<ToolExecution> {
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await this.registry.call(call.name, call.arguments, context);
    } catch (err) {
      result = { ok: false, text: `${call.name} failed: ${errorMessage(err)}` };
    }
    const durationMs = Date.now() - started;
    this.log.info("tool called", { tool: call.name, ok: result.ok, duration_ms: durationMs, task_id: context.taskId });
    return { result, durationMs };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
}
