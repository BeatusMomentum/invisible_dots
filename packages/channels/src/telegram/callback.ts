/**
 * What the Approve and Reject buttons carry. A button's `callback_data` comes back from Telegram exactly as sent,
 * but anyone can send a forged one to the bot, so it is parsed strictly and proves nothing by itself: the hub
 * checks who pressed it and whose approval it names. The data is versioned (`ap1`) so a later format can be told
 * from this one, and it is held to Telegram's limit of 64 bytes both ways: a longer id is refused when the
 * prompt is made, and longer data is not parsed.
 */
export const CALLBACK_DATA_MAX_BYTES = 64;

const PREFIX = "ap1";
/** The characters an approval id is made of; what could change the shape of the data stays out. */
const ID_SHAPE = /^[A-Za-z0-9_-]+$/;
const DATA_SHAPE = /^ap1:([yn]):([A-Za-z0-9_-]+)$/;

export interface ApprovalCallback {
  decision: "approve" | "reject";
  approvalId: string;
}

/** The data of a button; throws when the id cannot be carried (a bug of the caller: ids are `appr_<uuid>`, 41 bytes, 47 with the prefix). */
export function encodeApprovalCallback(decision: ApprovalCallback["decision"], approvalId: string): string {
  const data = `${PREFIX}:${decision === "approve" ? "y" : "n"}:${approvalId}`;
  if (!ID_SHAPE.test(approvalId) || Buffer.byteLength(data) > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`approval id "${approvalId.slice(0, 20)}" cannot be carried in a button of ${CALLBACK_DATA_MAX_BYTES} bytes`);
  }
  return data;
}

/** What a button said, or null for anything that is not data this version made. */
export function parseApprovalCallback(data: string | undefined): ApprovalCallback | null {
  if (data === undefined || Buffer.byteLength(data) > CALLBACK_DATA_MAX_BYTES) return null;
  const match = DATA_SHAPE.exec(data);
  if (!match) return null;
  return { decision: match[1] === "y" ? "approve" : "reject", approvalId: match[2]! };
}
