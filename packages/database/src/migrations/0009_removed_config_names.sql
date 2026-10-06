-- Dot configs stored before the config schema closed two lists (architecture section 7).
-- `dots.config` is jsonb that is never parsed again on its way to the guest, so a stored name the
-- schema no longer knows reaches the engine, which refuses the whole config, or makes every
-- update of the Dot fail until the person removes it by hand.
--
-- models: only the `summary` role is left (MODEL_ROLES); any other role goes.
-- permissions: the five names no tool of the Dot can exercise were deleted from PERMISSIONS.
--
-- One statement, so a Dot that needs both is one rewrite of `config` and `config_version` (0007) moves once, as it does
-- with every save: a form opened before the migration compares the version, and the stored config is not the one it read.
UPDATE dots
SET config = config
      || CASE
           WHEN jsonb_typeof(config -> 'models') = 'object' THEN jsonb_build_object(
             'models',
             COALESCE(
               (SELECT jsonb_object_agg(m.role, m.model) FROM jsonb_each(config -> 'models') AS m(role, model) WHERE m.role = 'summary'),
               '{}'::jsonb
             )
           )
           ELSE '{}'::jsonb
         END
      || CASE
           WHEN jsonb_typeof(config -> 'permissions') = 'object' THEN jsonb_build_object(
             'permissions',
             (config -> 'permissions') - ARRAY['web.fetch', 'web.search', 'subagents', 'message.send', 'memory.write']
           )
           ELSE '{}'::jsonb
         END,
    config_version = config_version + 1
WHERE (
    jsonb_typeof(config -> 'models') = 'object'
    AND EXISTS (SELECT 1 FROM jsonb_object_keys(config -> 'models') AS k(role) WHERE k.role <> 'summary')
  )
  OR (
    jsonb_typeof(config -> 'permissions') = 'object'
    AND (config -> 'permissions') - ARRAY['web.fetch', 'web.search', 'subagents', 'message.send', 'memory.write']
        <> (config -> 'permissions')
  );
