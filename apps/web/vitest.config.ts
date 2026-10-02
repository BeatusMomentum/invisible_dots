import { defineConfig } from "vitest/config";

// The root config leaves apps/web out; this one runs the web client's tests on their own.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
