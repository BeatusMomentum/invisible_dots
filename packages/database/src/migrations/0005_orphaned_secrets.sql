-- Secrets that outlived their Dot. `secrets.scope` holds a Dot id or `global`, so no foreign
-- key could cascade a Dot's secrets when the Dot was deleted, and every deletion made before
-- Dots.delete removed them in the same statement left them behind: an OpenRouter key, encrypted
-- but kept for good. Whatever is scoped to a Dot that no longer exists goes.
DELETE FROM secrets WHERE scope <> 'global' AND scope NOT IN (SELECT id FROM dots);
