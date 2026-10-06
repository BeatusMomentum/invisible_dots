/**
 * What an approval prompt says in a chat, and what it says once the approval is settled. One owner of the
 * wording, so every channel shows the same thing. Plain text: a channel adds its own means of answering.
 *
 * The prompt goes through a third party that can read it (a chat is not end-to-end encrypted), so the arguments of the
 * tool, which can hold private data, are cut to `ARGUMENTS_MAX` characters.
 */
import type { ApprovalRecord } from "@invisible-dots/shared";

/** The most characters of the tool's arguments, and of the reason, a prompt shows. */
export const ARGUMENTS_MAX = 300;

const MORE = "...";

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - MORE.length).trimEnd()}${MORE}`;
}

export function approvalPromptText(approval: ApprovalRecord): string {
  const lines = [`The Dot asks to use ${approval.tool} (permission ${approval.permission}).`];
  const reason = cut(approval.reason, ARGUMENTS_MAX);
  if (reason !== "") lines.push(`Reason: ${reason}`);
  const args = cut(JSON.stringify(approval.arguments), ARGUMENTS_MAX);
  if (args !== "{}") lines.push(`Arguments: ${args}`);
  return lines.join("\n");
}

const OUTCOMES: Record<ApprovalRecord["status"], string> = {
  pending: "Waiting for an answer.",
  approved: "Approved.",
  rejected: "Rejected.",
  expired: "No longer needed: the task ended before anyone answered.",
};

/** The prompt as it reads once the approval is settled: the question stays, the answer is added. */
export function approvalOutcomeText(approval: ApprovalRecord): string {
  return `${approvalPromptText(approval)}\n\n${OUTCOMES[approval.status]}`;
}
