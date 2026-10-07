-- A Dot has no browser settings any more: it manages its identities itself, within the engine's own limits (3 open,
-- 20 in all; architecture section 6). A config saved with the section loses it, and its version moves on, so a form
-- opened on the old config cannot save it back.
UPDATE dots
SET config = config - 'browser',
    config_version = config_version + 1
WHERE config ? 'browser';
