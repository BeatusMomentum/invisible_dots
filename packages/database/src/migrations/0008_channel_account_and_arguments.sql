-- One account (a Telegram bot) serves one Dot: two pollers on one bot take turns failing. The check in the hub
-- answers a clear 409 early; this index is the rule, so two requests that race past the check cannot both win.
CREATE UNIQUE INDEX channel_bindings_account_key ON channel_bindings (kind, account) WHERE account IS NOT NULL;

-- The setting `show_arguments` (an approval prompt in the chat shows the tool's arguments) is new: a binding
-- made before it keeps the behavior it had, which showed them.
UPDATE channel_bindings SET settings = settings || '{"show_arguments": true}'::jsonb WHERE settings->'show_arguments' IS NULL;
