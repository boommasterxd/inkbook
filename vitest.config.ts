import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const exposeGarbageCollector = process.execArgv.includes("--expose-gc");
const serialCapacityTests = [
  "test/integration/rendering/scene/history-contour-reuse.test.ts",
  "test/unit/domain/geometry/table-column-change.test.ts",
  "test/unit/persistence/documents/path-data-validator.test.ts",
  "test/unit/persistence/documents/safe-svg-validator.test.ts",
  "test/unit/persistence/saving/trusted-svg-output.test.ts",
  "test/unit/persistence/serialization/chunked-output-sha256.test.ts",
  "test/unit/persistence/serialization/pressure-stroke-capacity.test.ts",
  "test/unit/persistence/worker/runtime/runtime-input-hash.test.ts",
];

export default defineConfig({
  cacheDir: fileURLToPath(new URL("./.vitest-cache/", import.meta.url)),
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/adapters/obsidian/plugin.ts", import.meta.url)),
    },
  },
  test: {
    // Use both CPUs on small runners; performance batches explicitly override this to one.
    maxWorkers: "100%",
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
    projects: [
      {
        test: {
          name: "standard",
          include: [
            "test/unit/**/*.test.{ts,tsx,mjs}",
            "test/integration/**/*.test.{ts,tsx,mjs}",
            "test/performance/**/*.test.{ts,tsx}",
          ],
          exclude: [...configDefaults.exclude, ...serialCapacityTests],
        },
      },
      {
        test: {
          name: "serial-capacity",
          include: serialCapacityTests,
          // Exhaustive inputs retain their existing deadlines without CPU contention.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
    passWithNoTests: false,
    reporters: process.env["INKBOOK_PERFORMANCE_REFRESH_RATE"]
      ? [["json", { stdout: true }]]
      : ["default"],
    root: projectRoot,
  },
});
