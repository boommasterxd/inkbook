import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createExecutionSelection,
  qualityCommands,
  selectedPerformancePlan,
  selectionOutputs,
  validateExpectedOutputs,
} from "../../../scripts/ci-execution-plan.mjs";
import { PERFORMANCE_TEST_MANIFEST } from "../../../scripts/performance-test-manifest.mjs";
import { selectPerformanceRuns } from "../../../scripts/performance-test-runner.mjs";
import {
  cleanupRepositories,
  commit,
  createRepository,
  git,
  mergeBranch,
} from "./ci-selection-fixtures.mjs";

const unitTest = "test/unit/domain/value.test.ts";
const integrationTest = "test/integration/editor/value.test.ts";
const invariant = PERFORMANCE_TEST_MANIFEST.invariant[0];
const cadence = PERFORMANCE_TEST_MANIFEST.cadenceSensitive[0];
const root = process.cwd();
const npmEntry = "/npm-cli.js";

function plan(overrides = {}) {
  return {
    version: 2,
    base: "a".repeat(40),
    head: "b".repeat(40),
    merge: "c".repeat(40),
    mergeBase: "a".repeat(40),
    changes: ["src/domain/value.ts"],
    mode: "affected",
    reason: "Fixture selection",
    tests: [integrationTest, unitTest],
    coverage: ["src/domain/value.ts"],
    ...overrides,
  };
}

it("omits the repeated audit only when the caller supplies verified selection evidence", async () => {
  const commands = await qualityCommands(plan(), root, npmEntry, false, true);
  expect(commands.some(({ label }) => label === "audit")).toBe(false);
  expect(commands.some(({ label }) => label.startsWith("test:coverage"))).toBe(true);
});

describe("selected CI execution", () => {
  it("retains all static gates and production builds while narrowing test and coverage inputs", async () => {
    const commands = await qualityCommands(plan(), root, npmEntry);
    const test = commands.find(({ label }) => label.startsWith("test:coverage"));
    expect(commands.map(({ label }) => label)).toEqual([
      "docs:check",
      "format:check",
      "lint",
      "lint:styles",
      "lint:layout",
      "architecture",
      "typecheck:runtime",
      "typecheck:test",
      "typecheck:worker",
      "test:coverage (partial)",
      "duplication",
      "dead-code",
      "audit",
      "build",
      "package:verify",
    ]);
    expect(test.args).toContain(integrationTest);
    expect(test.args).toContain(unitTest);
    expect(test.args).toContain("--coverage.include=src/domain/value.ts");
    expect(test.args[0]).toBe(resolve(root, "scripts/run-validated-tests.mjs"));
    expect(test.args.slice(1, 4)).toEqual([integrationTest, unitTest, "--"]);
    expect(test.args).not.toContain("test/unit");
    expect(test.args.some((arg) => arg.startsWith("--coverage.thresholds"))).toBe(false);
  });

  it.each([
    "test/unit/domain/value.test.ts",
    "test/fixtures/document.svg",
    "docs/core-model.md",
    ".github/workflows/ci.yml",
    ".gitignore",
    "scripts/run-ci.mjs",
    "vitest.config.ts",
  ])("avoids build and package work for known nonproduction input %s", async (file) => {
    const selected = plan({ changes: [file] });
    expect(selectionOutputs(selected).build).toBe("false");
    const labels = (await qualityCommands(selected, root, npmEntry)).map(({ label }) => label);
    expect(labels).not.toContain("build");
    expect(labels).not.toContain("package:verify");
    expect(labels).toContain("audit");
  });

  it.each([
    "package.json",
    "package-lock.json",
    "scripts/build.mjs",
    "manifest.json",
    "unknown",
    "src/menu.css",
  ])("retains builds for production, dependency and unknown input %s", (file) => {
    expect(selectionOutputs(plan({ changes: [file] })).build).toBe("true");
  });

  it("retains full coverage for global test configuration without an irrelevant build", async () => {
    const selected = plan({ mode: "full", changes: ["vitest.config.ts"] });
    const commands = await qualityCommands(selected, root, npmEntry);
    expect(commands.find(({ label }) => label === "test:coverage (full)").args).toContain(
      "--coverage.include=src/**/*.{ts,tsx}",
    );
    expect(commands.some(({ label }) => label === "build")).toBe(false);
    expect(selectionOutputs(plan({ mode: "full", changes: [] })).build).toBe("true");
    expect(selectionOutputs(selected, true).build).toBe("true");
    expect(
      (await qualityCommands(selected, root, npmEntry, true)).some(
        ({ label }) => label === "build",
      ),
    ).toBe(true);
  });

  it("distinguishes tooling-only and performance-only selections from unexpected empty plans", async () => {
    const tooling = plan({ coverage: [], changes: ["scripts/run-ci.mjs"] });
    const commands = await qualityCommands(tooling, root, npmEntry);
    expect(commands.find(({ label }) => label.startsWith("test:coverage")).args).not.toContain(
      "--coverage",
    );
    const performance = await qualityCommands(
      plan({ tests: [cadence], coverage: [] }),
      root,
      npmEntry,
    );
    expect(performance.some(({ label }) => label.startsWith("test:coverage"))).toBe(false);
    await expect(qualityCommands(plan({ tests: [] }), root, npmEntry)).rejects.toThrow(
      "Unexpected empty",
    );
    await expect(qualityCommands(plan({ tests: [cadence] }), root, npmEntry)).rejects.toThrow(
      "Unexpected empty",
    );
    await expect(
      qualityCommands(plan({ mode: "full", tests: [cadence] }), root, npmEntry),
    ).rejects.toThrow("Unexpected empty");
    await expect(
      qualityCommands(plan({ mode: "docs", tests: [] }), root, npmEntry),
    ).rejects.toThrow("Documentation plans");
  });
});

describe("selected performance execution", () => {
  it("partitions selected contracts without dropping cadence profiles or changing fixtures", () => {
    const manifest = {
      invariant: PERFORMANCE_TEST_MANIFEST.invariant.map((file) => resolve(root, file)),
      cadenceSensitive: PERFORMANCE_TEST_MANIFEST.cadenceSensitive.map((file) =>
        resolve(root, file),
      ),
    };
    const selected = plan({ tests: [invariant, cadence].sort() });
    const filtered = selectedPerformancePlan(selected, manifest, root);
    expect(filtered.invariant).toEqual([resolve(root, invariant)]);
    expect(filtered.cadenceSensitive).toEqual([resolve(root, cadence)]);
    expect(selectPerformanceRuns(filtered, "shared")).toEqual([
      { label: "refresh-rate-invariant", refreshRate: 120, testFiles: filtered.invariant },
    ]);
    expect(
      selectPerformanceRuns(filtered, "cadence").map(({ refreshRate }) => refreshRate),
    ).toEqual([60, 90, 120, 144, 240]);
    expect(selectionOutputs(selected)).toMatchObject({ shared: "true", cadence: "true" });
    expect(selectionOutputs(plan())).toMatchObject({ shared: "false", cadence: "false" });
    expect(() =>
      selectedPerformancePlan(
        plan({ tests: ["test/performance/unknown.test.tsx"] }),
        manifest,
        root,
      ),
    ).toThrow("not classified");
  });
});

describe("selection integrity", () => {
  it("rejects failed or incomplete upstream audit evidence before executing checks", async () => {
    for (const status of ["failure", "cancelled", "skipped", "", "unknown"]) {
      await expect(createExecutionSelection({ root }, { EXPECTED_AUDIT: status })).rejects.toThrow(
        "audit did not complete",
      );
    }
    await expect(createExecutionSelection({ root }, { EXPECTED_AUDIT: "success" })).rejects.toThrow(
      "complete expected selection outputs",
    );
  });

  it("rejects a plan after the base tip and simulated merge advance with the same PR head", async () => {
    const context = await createRepository({
      "src/domain/value.ts": "export const value = 1;",
      [unitTest]: 'import { value } from "../../../src/domain/value"; void value;',
    });
    try {
      await git(context.root, "checkout", "--quiet", "-b", "feature");
      const head = await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });
      const original = await createExecutionSelection({ ...context, head }, {});
      await git(context.root, "checkout", "--quiet", "main");
      const base = await commit(context.root, { "docs/upstream.md": "Upstream" });
      await expect(createExecutionSelection({ ...context, base, head }, {})).rejects.toThrow(
        "does not contain",
      );
      await mergeBranch(context.root, "feature");
      const expected = Object.fromEntries(
        Object.entries(selectionOutputs(original)).map(([name, value]) => [
          `EXPECTED_${name.toUpperCase()}`,
          value,
        ]),
      );
      const current = await createExecutionSelection(
        { ...context, base, head },
        {
          ...expected,
          EXPECTED_AUDIT: "success",
        },
      );
      expect(current.tests).toEqual(original.tests);
      expect(current.mergeBase).toBe(original.mergeBase);
      expect(current.head).toBe(original.head);
      expect(current.base).toBe(base);
      expect(current.merge).not.toBe(original.merge);
      await expect(
        createExecutionSelection({ ...context, base, head, merge: original.merge }, expected),
      ).rejects.toThrow("expected merge revision");
      await expect(
        createExecutionSelection(
          { ...context, base, head },
          {
            ...expected,
            EXPECTED_MODE: "invalid",
          },
        ),
      ).rejects.toThrow("Selection output mode changed");
    } finally {
      await cleanupRepositories();
    }
  });

  it("rejects divergent detector outputs before running checks", () => {
    const outputs = selectionOutputs(plan());
    const environment = Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [`EXPECTED_${key.toUpperCase()}`, value]),
    );
    expect(() => validateExpectedOutputs(outputs, environment)).not.toThrow();
    for (const name of ["MODE", "BUILD", "SHARED", "CADENCE"])
      expect(() =>
        validateExpectedOutputs(outputs, { ...environment, [`EXPECTED_${name}`]: "invalid" }),
      ).toThrow("Selection output");
  });
});
