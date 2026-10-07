-- Host to guest events (architecture sections 5.4 and 9.2). An inbound event
-- is stored in the same transaction as what caused it (a claimed task, a
-- resolved approval, a user message, a cancel), before anything is sent, so a
-- failed delivery or a control plane restart cannot lose it: the deliverer
-- sends the undelivered rows of a Dot in `seq` order and marks each one
-- delivered when the guest answers 202. The guest keeps every event id it
-- accepted, so sending a row again after an unknown outcome is harmless.

CREATE TABLE inbound_events (
  seq           bigserial PRIMARY KEY,
  id            text NOT NULL UNIQUE,
  dot_id        text NOT NULL REFERENCES dots (id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('user.message', 'task.created', 'approval.received', 'system.event')),
  data          jsonb NOT NULL,
  -- The event's own timestamp, as the guest receives it.
  ts            text NOT NULL,
  -- The task a task.created or a task cancel is about, and the run a task.created opened.
  task_id       text,
  run_id        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when the first send began: from then on the guest may hold the event,
  -- whatever the outcome of that request was.
  sent_at       timestamptz,
  delivered_at  timestamptz,
  dropped_at    timestamptz,
  drop_reason   text,
  -- Failed sends whose outcome was known (refused, or never reached the guest).
  failures      integer NOT NULL DEFAULT 0,
  last_error    text,
  retry_at      timestamptz
);

CREATE INDEX inbound_events_pending_idx ON inbound_events (dot_id, seq) WHERE delivered_at IS NULL AND dropped_at IS NULL;

-- An approval whose task ended before anybody decided is expired: nothing
-- waits for it any more, so it must not stay in the pending list.
ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'expired'));
