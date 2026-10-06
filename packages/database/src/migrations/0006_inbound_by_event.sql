-- A channel message is handed to the Dot once, by the channel's own id. That was recorded in
-- `channel_inbound` after the `user.message` committed, so a failure between the two handed the same
-- message over twice. The `user.message` event already carries where the message came from, so the event
-- log is the one owner: a second row for the same Dot, binding and channel message id is refused by the index,
-- in the transaction that would have written it.
DROP TABLE channel_inbound;

CREATE UNIQUE INDEX events_user_message_origin_key
  ON events (dot_id, (data->'origin'->>'binding_id'), (data->'origin'->>'external_id'))
  WHERE type = 'user.message' AND data->'origin' IS NOT NULL;
