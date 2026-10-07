-- A Dot has no goal any more: what it is for is what its person asks of it, in the chat, a task or its instructions
-- (architecture section 7). A config saved with one loses it, and its version moves on, so a form opened on the old
-- config cannot save it back.
UPDATE dots
SET config = config - 'goal',
    config_version = config_version + 1
WHERE config ? 'goal';
