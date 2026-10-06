-- The version of a Dot's saved config: `updateConfig` and `setPermission` (the only writers of `config`) bump it, and a
-- save made from an old read compares it exactly (`expected_config_version`). `updated_at` cannot do this job: a status
-- change (every task turn moves the status) bumps it too, and a form opened before a turn would be refused with the
-- config unchanged.
ALTER TABLE dots ADD COLUMN config_version integer NOT NULL DEFAULT 1;
