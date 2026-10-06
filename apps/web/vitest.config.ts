import { defineConfig } from "vitest/config";

// The root config leaves apps/web out; this one runs the web client's tests on their own.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
