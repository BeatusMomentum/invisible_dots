-- The Dot keeps its memory itself, as notes it reads and writes with the file tools (architecture section 8.6): a
-- config has no `memory` switch and no `memory.read` permission any more, and the guest reports no `memory.written`.
-- A config saved before loses both, and its version moves on, so a form opened on the old config cannot save it
-- back. The `memory.written` rows of the log go too: the `tool.called` of the call that wrote each note stays, with
-- the note's path as its target.
UPDATE dots
SET config = jsonb_set(config - 'memory', '{permissions}', COALESCE(config -> 'permissions', '{}'::jsonb) - 'memory.read'),
    config_version = config_version + 1
WHERE config ? 'memory' OR COALESCE(config -> 'permissions', '{}'::jsonb) ? 'memory.read';

DELETE FROM events WHERE type = 'memory.written';
