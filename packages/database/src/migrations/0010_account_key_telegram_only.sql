-- The rule "one bot per Dot" is a Telegram rule: a bot takes updates from one poller. A WhatsApp number is learned
-- only when the phone is scanned, and several Dots may be devices linked to one phone. The first form of 0008 made
-- the unique index over every kind, so a database that applied it has that index; 0008 now creates the Telegram-only
-- one directly, and this migration brings the first form to it. Were WhatsApp covered, the write of the scanned
-- number would fail after the link, with the Dot connected and the link stream never ending.
DROP INDEX channel_bindings_account_key;
CREATE UNIQUE INDEX channel_bindings_account_key ON channel_bindings (account) WHERE kind = 'telegram' AND account IS NOT NULL;
