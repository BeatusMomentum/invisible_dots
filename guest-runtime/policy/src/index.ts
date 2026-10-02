/**
 * ALLOW / ASK / DENY (architecture section 8.4). Every tool call is decided
 * here before it runs; the rules themselves live in `resolvePermission` in
 * the shared package so the host and the guest cannot disagree on a default.
 */
import { resolvePermission, type DotRuntimeConfig, type PolicyDecision, type ToolDefinition } from "@invisible-dots/shared";

export type PolicyConfig = Pick<DotRuntimeConfig, "permissions">;

export interface ToolDecision {
  decision: PolicyDecision;
  /** The permission the tool declares; empty for a tool nobody offered. */
  permission: string;
  /** One sentence for the model and for the approval request. */
  reason: string;
}

export class PolicyEngine {
  #config: PolicyConfig;

  constructor(config: PolicyConfig) {
    this.#config = config;
  }

  /** Swap the rules, e.g. after `PUT /config`; the next decision uses them. */
  update(config: PolicyConfig): void {
    this.#config = config;
  }

  decide(permission: string): PolicyDecision {
    return resolvePermission(this.#config, permission);
  }

  /**
   * Decide a call by tool name against the tools actually offered. A name
   * that is not among them is denied whatever its permission would say,
   * because the model can invent names.
   */
  decideTool(name: string, offered: readonly ToolDefinition[]): ToolDecision {
    const tool = offered.find((t) => t.name === name);
    if (!tool) return { decision: "deny", permission: "", reason: `the tool "${name}" does not exist` };
    const decision = this.decide(tool.permission);
    const explicit = this.#config.permissions[tool.permission] !== undefined;
    const source = explicit ? "the Dot's configuration" : "the default policy";
    const reason =
      decision === "allow"
        ? `${tool.permission} is allowed by ${source}`
        : decision === "ask"
          ? `${tool.permission} requires the user's approval (${source})`
          : `${tool.permission} is denied by ${source}`;
    return { decision, permission: tool.permission, reason };
  }
}
