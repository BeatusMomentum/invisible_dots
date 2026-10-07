/**
 * The API answers as the web client reads them. They are the SDK's wire
 * types, under the shorter names the components use.
 */
import type {
  ApprovalRecord,
  ComputerAnswer,
  ConversationMessage,
  DotSummary,
  TaskRecord,
} from "@invisible-dots/sdk";

export type {
  BrowserIdentity,
  DotConfig,
  DotState,
  StoredEvent,
  SystemAnswer,
  TaskState,
  VmState,
} from "@invisible-dots/shared/browser";

export type Dot = DotSummary;
export type Computer = ComputerAnswer;
export type Task = TaskRecord;
export type Approval = ApprovalRecord;
export type ChatMessage = ConversationMessage;
