-- A Dot sets no token limit any more: every request uses its model's own context window and answer length, read
-- from OpenRouter (architecture section 8.5). A config saved with limits.context_tokens loses it, and its version moves
-- on, so a form opened on the old config cannot save it back.
UPDATE dots
SET config = jsonb_set(config, '{limits}', (config -> 'limits') - 'context_tokens'),
    config_version = config_version + 1
WHERE config -> 'limits' ? 'context_tokens';
