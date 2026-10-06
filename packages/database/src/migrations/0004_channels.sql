-- Messaging channels of a Dot (architecture sections 5.4 and 9.8). A binding is one Dot's link to one
-- channel kind; everything below it goes with it, and all of it goes with the Dot. Credentials are
-- not here: they are rows of `secrets` scoped to the Dot, encrypted like the OpenRouter key.

CREATE TABLE channel_bindings (
  id             text PRIMARY KEY,
  dot_id         text NOT NULL REFERENCES dots (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('telegram', 'whatsapp')),
  enabled        boolean NOT NULL DEFAULT true,
  -- What the channel sends unasked: {approvals, notify_tasks}. Never a credential.
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

-- A message the hub already handed to the Dot, by the channel's own id: a redelivered update is
-- recognised here and dropped. Only idempotency lives here; where a message came from is in the
-- `user.message` event it became.
CREATE TABLE channel_inbound (
  binding_id   text NOT NULL REFERENCES channel_bindings (id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  message_id   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (binding_id, external_id)
);

CREATE INDEX channel_inbound_created_idx ON channel_inbound (created_at);

-- A reply is routed back to its chat by the `user.message` event it answers (`in_reply_to` is that
-- event's message id), so the event log needs a way to find one.
CREATE INDEX events_user_message_idx ON events (dot_id, (data->>'message_id')) WHERE type = 'user.message';
