-- What a task has spent on model requests, in USD (architecture sections 5.4 and 8.2).
-- The guest reports it on the events of the task (`spent_usd`, the task's spend so far) and
-- the host keeps the highest value it has heard, so an event that arrives late or twice never
-- lowers it. Tasks that ended before this migration, and tasks of a guest that does not
-- report spend, stay at 0.
ALTER TABLE tasks ADD COLUMN spent_usd double precision NOT NULL DEFAULT 0 CHECK (spent_usd >= 0);
