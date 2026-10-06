-- The approval prompts a channel sent (architecture section 9.8): one message in one chat per approval, so
-- the prompt can be edited to the outcome when the approval is resolved, from the chat or from anywhere
-- else, and so a restart sends a prompt only to a chat that has not got one. A prompt goes with its binding
-- and with its approval.

CREATE TABLE channel_prompts (
  binding_id   text NOT NULL REFERENCES channel_bindings (id) ON DELETE CASCADE,
  approval_id  text NOT NULL REFERENCES approvals (id) ON DELETE CASCADE,
  chat_id      text NOT NULL,
  -- The channel's own handle for the sent message (a Telegram message id), what an edit needs.
  ref          text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (binding_id, approval_id, chat_id)
);

CREATE INDEX channel_prompts_approval_idx ON channel_prompts (approval_id);
