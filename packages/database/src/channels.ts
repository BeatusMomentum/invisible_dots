/**
 * Messaging channels (migrations 0004 and 0005): a Dot's bindings to a channel kind, the people paired to them,
 * one-time pairing codes, the record of inbound messages already handled and the approval prompts sent. The rules (who may talk,
 * what a reply is routed to) belong to the channel hub; this file only stores and reads.
 */
import type { ChannelKind, ChannelSettings, ChannelStatus } from "@invisible-dots/shared";
import { isoRequired, type Queryable } from "./rows.js";

interface BindingRow {
  id: string;
  dot_id: string;
  kind: ChannelKind;
  enabled: boolean;
  settings: ChannelSettings;
  status: ChannelStatus;
  status_detail: string | null;
  account: string | null;
  event_cursor: number;
  created_at: Date;
}

export interface ChannelBindingRecord {
  id: string;
  dot_id: string;
  kind: ChannelKind;
  enabled: boolean;
  settings: ChannelSettings;
  status: ChannelStatus;
  status_detail: string | null;
  /** The channel's public name for the account (a Telegram bot's username), or null. */
  account: string | null;
  /** The id of the last event of the Dot the hub dealt with. */
  event_cursor: number;
  created_at: string;
}

function toBinding(row: BindingRow): ChannelBindingRecord {
  return { ...row, created_at: isoRequired(row.created_at) };
}

interface PeerRow {
  binding_id: string;
  peer_id: string;
  chat_id: string;
  role: "owner" | "user";
  label: string;
  created_at: Date;
}

export interface ChannelPeerRow {
  binding_id: string;
  peer_id: string;
  chat_id: string;
  role: "owner" | "user";
  label: string;
  created_at: string;
}

function toPeer(row: PeerRow): ChannelPeerRow {
  return { ...row, created_at: isoRequired(row.created_at) };
}

interface PromptRow {
  binding_id: string;
  approval_id: string;
  chat_id: string;
  ref: string;
  created_at: Date;
}

/** An approval prompt a channel sent: `ref` is the channel's handle for the message, what an edit needs. */
export interface ChannelPromptRow {
  binding_id: string;
  approval_id: string;
  chat_id: string;
  ref: string;
  created_at: string;
}

function toPrompt(row: PromptRow): ChannelPromptRow {
  return { ...row, created_at: isoRequired(row.created_at) };
}

export interface NewChannelBinding {
  id: string;
  dotId: string;
  kind: ChannelKind;
  settings: ChannelSettings;
  /** Events up to and including this id are not the channel's: it starts with what comes after. */
  eventCursor: number;
  /** The channel's public name for the account, when the credentials were checked before the binding was made. */
  account?: string;
}

export interface NewChannelPeer {
  bindingId: string;
  peerId: string;
  chatId: string;
  role: "owner" | "user";
  label: string;
}

export class ChannelsRepository {
  constructor(private readonly q: Queryable) {}

  /** Insert the binding, `connecting`; a Dot has one per kind, so a second one is a unique violation (`isUniqueViolation`). */
  async createBinding(binding: NewChannelBinding): Promise<ChannelBindingRecord> {
    const { rows } = await this.q.query<BindingRow>(
      `INSERT INTO channel_bindings (id, dot_id, kind, settings, status, event_cursor, account)
       VALUES ($1, $2, $3, $4::jsonb, 'connecting', $5, $6) RETURNING *`,
      [binding.id, binding.dotId, binding.kind, JSON.stringify(binding.settings), binding.eventCursor, binding.account ?? null],
    );
    return toBinding(rows[0]!);
  }

  async binding(dotId: string, kind: ChannelKind): Promise<ChannelBindingRecord | null> {
    const { rows } = await this.q.query<BindingRow>("SELECT * FROM channel_bindings WHERE dot_id = $1 AND kind = $2", [dotId, kind]);
    return rows[0] ? toBinding(rows[0]) : null;
  }

  async bindingById(id: string): Promise<ChannelBindingRecord | null> {
    const { rows } = await this.q.query<BindingRow>("SELECT * FROM channel_bindings WHERE id = $1", [id]);
    return rows[0] ? toBinding(rows[0]) : null;
  }

  /** Every binding of the Dot, or of every Dot when `dotId` is omitted, oldest first. */
  async listBindings(dotId?: string): Promise<ChannelBindingRecord[]> {
    const { rows } = await this.q.query<BindingRow>(
      "SELECT * FROM channel_bindings WHERE ($1::text IS NULL OR dot_id = $1) ORDER BY created_at, id",
      [dotId ?? null],
    );
    return rows.map(toBinding);
  }

  /** Delete the binding with its peers, pairing codes and inbound record. */
  async deleteBinding(id: string): Promise<boolean> {
    const { rowCount } = await this.q.query("DELETE FROM channel_bindings WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }

  async setSettings(id: string, settings: ChannelSettings): Promise<ChannelBindingRecord | null> {
    const { rows } = await this.q.query<BindingRow>("UPDATE channel_bindings SET settings = $2::jsonb WHERE id = $1 RETURNING *", [
      id,
      JSON.stringify(settings),
    ]);
    return rows[0] ? toBinding(rows[0]) : null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<ChannelBindingRecord | null> {
    const { rows } = await this.q.query<BindingRow>("UPDATE channel_bindings SET enabled = $2 WHERE id = $1 RETURNING *", [id, enabled]);
    return rows[0] ? toBinding(rows[0]) : null;
  }

  /**
   * Record where the connection stands. True when something changed (status, detail or account), so
   * the caller announces only a real change. `account` is kept when omitted.
   */
  async setStatus(id: string, status: ChannelStatus, detail: string | null, account?: string): Promise<boolean> {
    const { rowCount } = await this.q.query(
      `UPDATE channel_bindings SET status = $2::text, status_detail = $3::text, account = COALESCE($4::text, account)
        WHERE id = $1 AND (status <> $2::text OR status_detail IS DISTINCT FROM $3::text OR ($4::text IS NOT NULL AND account IS DISTINCT FROM $4::text))`,
      [id, status, detail, account ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Move the cursor forward; it never moves back. */
  async advanceCursor(id: string, cursor: number): Promise<void> {
    await this.q.query("UPDATE channel_bindings SET event_cursor = $2 WHERE id = $1 AND event_cursor < $2", [id, cursor]);
  }

  // Peers

  async peers(bindingId: string): Promise<ChannelPeerRow[]> {
    const { rows } = await this.q.query<PeerRow>("SELECT * FROM channel_peers WHERE binding_id = $1 ORDER BY created_at, peer_id", [bindingId]);
    return rows.map(toPeer);
  }

  async peer(bindingId: string, peerId: string): Promise<ChannelPeerRow | null> {
    const { rows } = await this.q.query<PeerRow>("SELECT * FROM channel_peers WHERE binding_id = $1 AND peer_id = $2", [bindingId, peerId]);
    return rows[0] ? toPeer(rows[0]) : null;
  }

  /** The peer whose chat this is, or null: a reply goes only to the chat of someone still paired. */
  async peerByChat(bindingId: string, chatId: string): Promise<ChannelPeerRow | null> {
    const { rows } = await this.q.query<PeerRow>("SELECT * FROM channel_peers WHERE binding_id = $1 AND chat_id = $2 LIMIT 1", [bindingId, chatId]);
    return rows[0] ? toPeer(rows[0]) : null;
  }

  /** Add the peer, or update the chat and label of one already paired (its role and age stay). */
  async upsertPeer(peer: NewChannelPeer): Promise<ChannelPeerRow> {
    const { rows } = await this.q.query<PeerRow>(
      `INSERT INTO channel_peers (binding_id, peer_id, chat_id, role, label) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (binding_id, peer_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, label = EXCLUDED.label RETURNING *`,
      [peer.bindingId, peer.peerId, peer.chatId, peer.role, peer.label],
    );
    return toPeer(rows[0]!);
  }

  async deletePeer(bindingId: string, peerId: string): Promise<boolean> {
    const { rowCount } = await this.q.query("DELETE FROM channel_peers WHERE binding_id = $1 AND peer_id = $2", [bindingId, peerId]);
    return (rowCount ?? 0) > 0;
  }

  // Pairing codes

  /** Store a code's hash; codes that expired or were used are removed with it. */
  async createPairing(bindingId: string, codeHash: string, expiresAt: Date, now: Date): Promise<void> {
    await this.q.query("DELETE FROM channel_pairings WHERE binding_id = $1 AND (consumed_at IS NOT NULL OR expires_at <= $2)", [bindingId, now]);
    await this.q.query("INSERT INTO channel_pairings (binding_id, code_hash, expires_at) VALUES ($1, $2, $3)", [bindingId, codeHash, expiresAt]);
  }

  /** Use the code: true once, for a code that exists, is not expired and was not used; false for every other attempt. */
  async consumePairing(bindingId: string, codeHash: string, now: Date): Promise<boolean> {
    const { rowCount } = await this.q.query(
      "UPDATE channel_pairings SET consumed_at = $3 WHERE binding_id = $1 AND code_hash = $2 AND consumed_at IS NULL AND expires_at > $3",
      [bindingId, codeHash, now],
    );
    return (rowCount ?? 0) > 0;
  }

  // Inbound messages already handled

  /** The id of the message the Dot got for this channel message, or null when it was not handled. */
  async inboundMessageId(bindingId: string, externalId: string): Promise<string | null> {
    const { rows } = await this.q.query<{ message_id: string }>("SELECT message_id FROM channel_inbound WHERE binding_id = $1 AND external_id = $2", [
      bindingId,
      externalId,
    ]);
    return rows[0]?.message_id ?? null;
  }

  async recordInbound(bindingId: string, externalId: string, messageId: string): Promise<void> {
    await this.q.query(
      "INSERT INTO channel_inbound (binding_id, external_id, message_id) VALUES ($1, $2, $3) ON CONFLICT (binding_id, external_id) DO NOTHING",
      [bindingId, externalId, messageId],
    );
  }

  /** Forget what was handled before `before`: a channel redelivers recent messages only. Returns how many rows went. */
  async pruneInbound(before: Date): Promise<number> {
    const { rowCount } = await this.q.query("DELETE FROM channel_inbound WHERE created_at < $1", [before]);
    return rowCount ?? 0;
  }

  // Approval prompts

  /** Record that the approval was sent to the chat as the message `ref`; sending it again to the same chat keeps the first. */
  async addPrompt(bindingId: string, approvalId: string, chatId: string, ref: string): Promise<void> {
    await this.q.query(
      "INSERT INTO channel_prompts (binding_id, approval_id, chat_id, ref) VALUES ($1, $2, $3, $4) ON CONFLICT (binding_id, approval_id, chat_id) DO NOTHING",
      [bindingId, approvalId, chatId, ref],
    );
  }

  /** The prompts of the binding, for one approval or (when `approvalId` is omitted) for all, oldest first. */
  async prompts(bindingId: string, approvalId?: string): Promise<ChannelPromptRow[]> {
    const { rows } = await this.q.query<PromptRow>(
      "SELECT * FROM channel_prompts WHERE binding_id = $1 AND ($2::text IS NULL OR approval_id = $2) ORDER BY created_at, approval_id, chat_id",
      [bindingId, approvalId ?? null],
    );
    return rows.map(toPrompt);
  }

  async deletePrompt(bindingId: string, approvalId: string, chatId: string): Promise<void> {
    await this.q.query("DELETE FROM channel_prompts WHERE binding_id = $1 AND approval_id = $2 AND chat_id = $3", [bindingId, approvalId, chatId]);
  }
}
