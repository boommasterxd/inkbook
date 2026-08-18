import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(
        new URL("./test/fakes/obsidian.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      exclude: [],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        branches: 85,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
