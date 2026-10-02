import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/{src,test}/**/*.test.ts",
      "packages/*/{src,test}/**/*.test.ts",
      "guest/invisible-dots-agent/{src,test}/**/*.test.ts",
      "guest-runtime/*/{src,test}/**/*.test.ts",
    ],
    // The web client's tests need no DOM: they run here with everything else.
    exclude: ["**/node_modules/**", "**/.next/**"],
    environment: "node",
    passWithNoTests: true,
  },
});
