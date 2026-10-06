-- Dot configs stored before the config schema closed two lists (architecture section 7).
-- `dots.config` is jsonb that is never parsed again on its way to the guest, so a stored name the
-- schema no longer knows reaches the engine, which refuses the whole config, or makes every
-- update of the Dot fail until the person removes it by hand.
--
-- models: only the `summary` role is left (MODEL_ROLES); any other role goes.
UPDATE dots
SET config = jsonb_set(
  config,
  '{models}',
  COALESCE(
    (SELECT jsonb_object_agg(m.role, m.model) FROM jsonb_each(config -> 'models') AS m(role, model) WHERE m.role = 'summary'),
    '{}'::jsonb
  )
)
WHERE jsonb_typeof(config -> 'models') = 'object'
  AND EXISTS (SELECT 1 FROM jsonb_object_keys(config -> 'models') AS k(role) WHERE k.role <> 'summary');

-- permissions: the five names no tool of the Dot can exercise were deleted from PERMISSIONS.
UPDATE dots
SET config = jsonb_set(
  config,
  '{permissions}',
  (config -> 'permissions') - ARRAY['web.fetch', 'web.search', 'subagents', 'message.send', 'memory.write']
)
WHERE jsonb_typeof(config -> 'permissions') = 'object'
  AND (config -> 'permissions') - ARRAY['web.fetch', 'web.search', 'subagents', 'message.send', 'memory.write']
      <> (config -> 'permissions');
