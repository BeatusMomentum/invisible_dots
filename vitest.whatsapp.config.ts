import { defineConfig } from "vitest/config";

// The tests that need the real WhatsApp client (Baileys), which is not part of the default install because it depends
// on libsignal (GPL-3.0). Run `npm run whatsapp:install` first; `npm run test:whatsapp` runs them. The default suite
// (vitest.config.ts) never includes this folder.
export default defineConfig({
  test: {
    include: ["packages/channels/test-optin/**/*.test.ts"],
    environment: "node",
    // Same allowances as the default suite: a real test database boots in a hook.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
