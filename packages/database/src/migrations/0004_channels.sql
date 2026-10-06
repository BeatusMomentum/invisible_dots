-- Messaging channels of a Dot (architecture sections 5.4 and 9.8). A binding is one Dot's link to one
-- channel kind; everything below it goes with it, and all of it goes with the Dot. Credentials are
-- not here: they are rows of `secrets` scoped to the Dot, encrypted like the OpenRouter key.

CREATE TABLE channel_bindings (
  id             text PRIMARY KEY,
  dot_id         text NOT NULL REFERENCES dots (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('telegram', 'whatsapp')),
  enabled        boolean NOT NULL DEFAULT true,
  -- What the channel sends unasked: {approvals, notify_tasks, show_arguments}. Never a credential.
  settings       jsonb NOT NULL,
  status         text NOT NULL CHECK (status IN ('connecting', 'connected', 'needs_relink', 'error')),
  status_detail  text,
  -- The channel's public name for the account (a Telegram bot's username), reported by the adapter.
  account        text,
  -- The id of the last event of the Dot the hub has dealt with: a restart resumes after it.
  event_cursor   bigint NOT NULL CHECK (event_cursor >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dot_id, kind)
);

-- One Telegram bot serves one Dot: two pollers on one bot take turns failing. The check in the hub answers a clear
-- 409 early; this index is the rule, so two requests that race past the check cannot both win. It covers Telegram
-- alone: a WhatsApp number is learned only when the phone is scanned, and several Dots may be devices linked to one
-- phone.
CREATE UNIQUE INDEX channel_bindings_account_key ON channel_bindings (account) WHERE kind = 'telegram' AND account IS NOT NULL;

-- The people allowed to talk to the Dot through the binding. Anyone else is dropped before a write.
CREATE TABLE channel_peers (
  binding_id  text NOT NULL REFERENCES channel_bindings (id) ON DELETE CASCADE,
  -- The channel's stable id for the person (a Telegram numeric user id), never a mutable name.
  peer_id     text NOT NULL,
  -- The chat the person paired from; replies and proactive messages go there.
  chat_id     text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'user')),
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (binding_id, peer_id)
);

CREATE INDEX channel_peers_chat_idx ON channel_peers (binding_id, chat_id);

-- One-time pairing codes, stored hashed.
CREATE TABLE channel_pairings (
  binding_id   text NOT NULL REFERENCES channel_bindings (id) ON DELETE CASCADE,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  PRIMARY KEY (binding_id, code_hash)
);

-- A reply is routed back to its chat by the `user.message` event it answers (`in_reply_to` is that
-- event's message id), so the event log needs a way to find one.
CREATE INDEX events_user_message_idx ON events (dot_id, (data->>'message_id')) WHERE type = 'user.message';

-- A channel message is handed to the Dot once, by the channel's own id. The `user.message` event already carries where
-- the message came from, so the event log is the one owner: a second row for the same Dot, binding and channel
-- message id is refused by the index, in the transaction that would have written it.
CREATE UNIQUE INDEX events_user_message_origin_key
  ON events (dot_id, (data->'origin'->>'binding_id'), (data->'origin'->>'external_id'))
  WHERE type = 'user.message' AND data->'origin' IS NOT NULL;
