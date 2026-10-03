/**
 * ALLOW / ASK / DENY (architecture section 8.4): the decision for one tool
 * call, a pure function of the current config and the tools it offers. The
 * rules themselves live in `resolvePermission` in the shared package, so the
 * host and the guest cannot disagree on a default.
 */
import { resolvePermission, type DotRuntimeConfig, type PolicyDecision, type ToolDefinition } from "@invisible-dots/shared";

export interface ToolDecision {
  decision: PolicyDecision;
  /** The permission the tool declares; empty for a tool nobody offered. */
  permission: string;
  /** One sentence for the model and for the approval request. */
  reason: string;
}

/**
 * Decide a call by tool name against the tools actually offered. A name that
 * is not among them is denied whatever its permission would say, because the
 * model can invent names.
 */
export function decideTool(
  config: Pick<DotRuntimeConfig, "permissions">,
  offered: readonly ToolDefinition[],
  name: string,
): ToolDecision {
  const tool = offered.find((t) => t.name === name);
  if (!tool) return { decision: "deny", permission: "", reason: `the tool "${name}" does not exist` };
  const decision = resolvePermission(config, tool.permission);
  const explicit = config.permissions[tool.permission] !== undefined;
  const source = explicit ? "the Dot's configuration" : "the default policy";
  const reason =
    decision === "allow"
      ? `${tool.permission} is allowed by ${source}`
      : decision === "ask"
        ? `${tool.permission} requires the user's approval (${source})`
        : `${tool.permission} is denied by ${source}`;
  return { decision, permission: tool.permission, reason };
}
