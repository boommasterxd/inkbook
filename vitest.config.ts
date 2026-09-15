import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const exposeGarbageCollector = process.execArgv.includes("--expose-gc");

export default defineConfig({
  cacheDir: fileURLToPath(new URL("./.vitest-cache/", import.meta.url)),
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/adapters/obsidian/plugin.ts", import.meta.url)),
    },
  },
  test: {
    execArgv: ["--max-old-space-size=384", ...(exposeGarbageCollector ? ["--expose-gc"] : [])],
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        branches: 80,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    environment: "node",
    setupFiles:
      process.env["INKBOOK_PERFORMANCE_REPORT"] === "1"
        ? ["./test/performance/timing-assertions.ts"]
        : [],
    include: [
      "test/unit/**/*.test.{ts,tsx,mjs}",
      "test/integration/**/*.test.{ts,tsx,mjs}",
      "test/performance/**/*.test.{ts,tsx}",
    ],
    passWithNoTests: false,
    reporters: process.env["INKBOOK_PERFORMANCE_REFRESH_RATE"]
      ? [["json", { stdout: true }]]
      : ["default"],
    root: projectRoot,
  },
});
