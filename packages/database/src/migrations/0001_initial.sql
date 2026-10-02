-- The control-plane schema of architecture section 9.1.

CREATE TABLE dots (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  config      jsonb NOT NULL,
  status      text NOT NULL CHECK (status IN ('CREATING', 'READY', 'IDLE', 'RUNNING', 'WAITING_APPROVAL', 'ERROR', 'DISABLED')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE computers (
  dot_id          text PRIMARY KEY REFERENCES dots (id) ON DELETE CASCADE,
  domain_name     text NOT NULL,
  cid             integer NOT NULL UNIQUE CHECK (cid >= 3),
  state           text NOT NULL CHECK (state IN ('PROVISIONING', 'STARTING', 'RUNNING', 'IDLE', 'STOPPING', 'STOPPED', 'ERROR', 'DELETING')),
  golden_image    text,
  runtime_image   text,
  token_enc       bytea NOT NULL,
  event_cursor    bigint NOT NULL DEFAULT 0,
  last_active_at  timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id            text PRIMARY KEY,
  dot_id        text NOT NULL REFERENCES dots (id) ON DELETE CASCADE,
  description   text NOT NULL,
  priority      integer NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  scheduled_at  timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  summary       text,
  error         text
);

-- The dispatcher scans pending work; the busy check looks up active tasks per Dot.
CREATE INDEX tasks_pending_idx ON tasks (priority DESC, created_at, id) WHERE status = 'PENDING';
CREATE INDEX tasks_dot_status_idx ON tasks (dot_id, status);

CREATE TABLE task_runs (
  id            text PRIMARY KEY,
  task_id       text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  -- Set once task.created reached the guest; a run without it was interrupted before delivery.
  delivered_at  timestamptz,
  finished_at   timestamptz,
  outcome       text
);

CREATE INDEX task_runs_task_idx ON task_runs (task_id);

-- No foreign key on dot_id: the log outlives a deleted Dot, so dot.deleted stays readable.
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  dot_id      text NOT NULL,
  type        text NOT NULL,
  data        jsonb NOT NULL,
  source      text NOT NULL CHECK (source IN ('host', 'guest')),
  guest_seq   bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dot_id, guest_seq),
  CHECK ((source = 'guest') = (guest_seq IS NOT NULL))
);

CREATE INDEX events_dot_idx ON events (dot_id, id);

CREATE TABLE approvals (
  id           text PRIMARY KEY,
  dot_id       text NOT NULL REFERENCES dots (id) ON DELETE CASCADE,
  task_id      text,
  tool         text NOT NULL,
  permission   text NOT NULL,
  arguments    jsonb NOT NULL,
  reason       text NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX approvals_status_idx ON approvals (status, created_at);

CREATE TABLE secrets (
  scope       text NOT NULL,
  name        text NOT NULL,
  value_enc   bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, name)
);
