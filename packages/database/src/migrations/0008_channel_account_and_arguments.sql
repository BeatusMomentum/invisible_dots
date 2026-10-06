-- One Telegram bot serves one Dot: two pollers on one bot take turns failing. The check in the hub answers a clear
-- 409 early; this index is the rule, so two requests that race past the check cannot both win. It covers Telegram
-- alone: a WhatsApp number is learned only when the phone is scanned, and several Dots may be devices linked to one
-- phone.
--
-- Before this index nothing stopped a bot from being bound twice (the check and the write were two steps), and the
-- index cannot be built over such rows. The binding that is oldest (then by id) keeps the bot; each other binding
-- of it goes to `needs_relink` with the account cleared and a detail naming the bot, which the hub shows to the
-- person and does not start: the credentials stay where they are, and entering a token again is what links it.
UPDATE channel_bindings AS b
   SET status = 'needs_relink',
       status_detail = 'The Telegram bot ' || d.account || ' is already linked to another Dot, and a bot serves one Dot: enter a bot token for this Dot.',
       account = NULL
  FROM (
    SELECT id, account, row_number() OVER (PARTITION BY account ORDER BY created_at, id) AS rank
      FROM channel_bindings
     WHERE kind = 'telegram' AND account IS NOT NULL
  ) AS d
 WHERE b.id = d.id AND d.rank > 1;

CREATE UNIQUE INDEX channel_bindings_account_key ON channel_bindings (account) WHERE kind = 'telegram' AND account IS NOT NULL;

-- The setting `show_arguments` (an approval prompt in the chat shows the tool's arguments) is new: a binding
-- made before it keeps the behavior it had, which showed them.
UPDATE channel_bindings SET settings = settings || '{"show_arguments": true}'::jsonb WHERE settings->'show_arguments' IS NULL;
