-- The rule "one bot per Dot" is a Telegram rule: a bot takes updates from one poller. A WhatsApp number is learned
-- only when the phone is scanned, and several Dots may be devices linked to one phone, so the unique index (0008)
-- covers Telegram alone. Were it to cover WhatsApp, the write of the scanned number would fail after the link, with
-- the Dot connected and the link stream never ending.
DROP INDEX channel_bindings_account_key;
CREATE UNIQUE INDEX channel_bindings_account_key ON channel_bindings (account) WHERE kind = 'telegram' AND account IS NOT NULL;
