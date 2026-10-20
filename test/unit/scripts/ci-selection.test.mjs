import { afterEach, describe, expect, it } from "vitest";

import { selectionOutputs } from "../../../scripts/ci-execution-plan.mjs";
import { PERFORMANCE_TEST_MANIFEST } from "../../../scripts/performance-test-manifest.mjs";
import {
  createSelection,
  inspectChanges,
  validateSelection,
} from "../../../scripts/ci-selection.mjs";
import {
  cleanupRepositories,
  commit,
  createRepository,
  git,
  mergeBranch,
  write,
} from "./ci-selection-fixtures.mjs";

const directTest = "test/unit/domain/direct.test.ts";
const transitiveTest = "test/integration/editor/transitive.test.ts";
const unrelatedTest = "test/unit/domain/unrelated.test.ts";
const performanceTest = "test/performance/domain/direct.test.ts";
const scriptTest = "test/unit/scripts/ci-selection.test.mjs";
const workflowTest = "test/unit/scripts/github-workflows.test.mjs";
const initialFiles = {
  "src/domain/value.ts": "export const value = 1;",
  "src/domain/wrapper.ts": 'export { value } from "./value";',
  "src/domain/unrelated.ts": "export const unrelated = 1;",
  [directTest]: 'import { value } from "../../../src/domain/value"; void value;',
  [transitiveTest]: 'import { value } from "../../../src/domain/wrapper"; void value;',
  [unrelatedTest]: 'import { unrelated } from "../../../src/domain/unrelated"; void unrelated;',
  [performanceTest]: 'import { value } from "../../../src/domain/value"; void value;',
  [scriptTest]: 'import { plan } from "../../../scripts/ci-plan.mjs"; void plan;',
  [workflowTest]: 'import { readFileSync } from "node:fs"; void readFileSync;',
  "scripts/ci-plan.mjs": "export const plan = 1;",
};

afterEach(cleanupRepositories);

async function fixture(extra = {}) {
  return createRepository({ ...initialFiles, ...extra });
}

describe("affected CI selection", () => {
  it("selects direct, transitive and performance consumers and scopes coverage", async () => {
    const context = await fixture();
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual([transitiveTest, performanceTest, directTest].sort());
    expect(plan.coverage).toEqual(["src/domain/value.ts", "src/domain/wrapper.ts"]);
    expect(validateSelection(plan)).toBe(plan);
  });

  it("includes shared test-helper consumers without importing unrelated tests", async () => {
    const helper = "test/fixtures/shared.ts";
    const context = await fixture({
      [helper]: 'export { value } from "../../src/domain/value";',
      [directTest]: 'import { value } from "../../fixtures/shared"; void value;',
      [transitiveTest]: 'import { value } from "../../fixtures/shared"; void value;',
    });
    await commit(context.root, {
      [helper]: 'export { value as other } from "../../src/domain/value";',
    });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual([transitiveTest, directTest].sort());
    expect(plan.coverage).toEqual(["src/domain/value.ts"]);
  });

  it("keeps the old import graph when head removes a dependency", async () => {
    const context = await fixture();
    await commit(context.root, { "src/domain/wrapper.ts": "export const value = 2;" });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual([transitiveTest]);
    expect(plan.coverage).toEqual(["src/domain/wrapper.ts"]);
  });

  it("uses the merge-base instead of omitting earlier branch changes", async () => {
    const context = await fixture();
    await git(context.root, "checkout", "--quiet", "-b", "feature");
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });
    const head = await commit(context.root, { "docs/feature.md": "Feature" });
    await git(context.root, "checkout", "--quiet", "main");
    const upstream = await commit(context.root, { "docs/upstream.md": "Upstream" });
    await mergeBranch(context.root, "feature");
    const comparison = await inspectChanges({ root: context.root, base: upstream, head });

    expect(comparison.base).toBe(upstream);
    expect(comparison.mergeBase).toBe(context.base);
    expect(comparison.merge).toBe(await git(context.root, "rev-parse", "HEAD"));
    expect(comparison.changes).toEqual(["docs/feature.md", "src/domain/value.ts"]);
    expect((await createSelection({ ...context, base: upstream, head })).mode).toBe("affected");
  });

  it("selects changed test files and supports mjs and tsx test enumeration", async () => {
    const changed = "test/unit/rendering/chrome.test.tsx";
    const context = await fixture({ [changed]: "export const result = <div />;" });
    await commit(context.root, { [changed]: "export const result = <span />;" });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual([changed]);
    expect(plan.coverage).toEqual([]);
  });

  it.each(["src/obsidian/styles/menu.css", "test/fixtures/example.svg"])(
    "conservatively selects all consumers for filesystem input %s",
    async (filename) => {
      const context = await fixture();
      await commit(context.root, { [filename]: "fixture" });
      const plan = await createSelection(context);

      expect(plan.mode).toBe("affected");
      expect(plan.tests).toEqual(
        Object.keys(initialFiles)
          .filter((file) => file.includes(".test."))
          .sort(),
      );
    },
  );

  it("maps workflow and script changes to filesystem-reading tooling tests", async () => {
    const context = await fixture();
    await commit(context.root, { ".github/workflows/gitleaks.yml": "name: gitleaks" });
    expect((await createSelection(context)).tests).toEqual([workflowTest]);
    await commit(context.root, { "scripts/verify-source-layout.mjs": "export const check = 2;" });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual([scriptTest, workflowTest]);
  });
});

describe("base graph deletion and renaming", () => {
  it("tracks both rename paths and still selects surviving base consumers", async () => {
    const context = await fixture();
    await git(context.root, "mv", "src/domain/value.ts", "src/domain/renamed.ts");
    await write(context.root, {
      [directTest]: 'import { value } from "../../../src/domain/renamed"; void value;',
      [performanceTest]: 'import { value } from "../../../src/domain/renamed"; void value;',
      "src/domain/wrapper.ts": 'export { value } from "./renamed";',
    });
    await commit(context.root);
    const plan = await createSelection(context);

    expect(plan.mode).toBe("affected");
    expect(plan.changes).toContain("src/domain/value.ts");
    expect(plan.changes).toContain("src/domain/renamed.ts");
    expect(plan.tests).toContain(transitiveTest);
    expect(plan.coverage).not.toContain("src/domain/value.ts");
  });

  it("handles a removed runtime module through its old consumers", async () => {
    const context = await fixture();
    await git(context.root, "rm", "src/domain/value.ts");
    await commit(context.root, {
      [directTest]: "export {};",
      [performanceTest]: "export {};",
      "src/domain/wrapper.ts": "export const value = 2;",
    });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain(directTest);
    expect(plan.coverage).toEqual(["src/domain/wrapper.ts"]);
  });
});

describe("CI infrastructure changes", () => {
  it("retains every classified performance contract when the manifest changes", async () => {
    const classified = Object.values(PERFORMANCE_TEST_MANIFEST).flat().sort();
    const context = await fixture(
      Object.fromEntries(classified.map((file) => [file, "export {};"])),
    );
    await commit(context.root, {
      "scripts/performance-test-manifest.mjs": "export const changed = true;",
    });
    const plan = await createSelection(context);

    expect(plan.tests.filter((file) => file.startsWith("test/performance/"))).toEqual(
      [...classified, performanceTest].sort(),
    );
    expect(selectionOutputs(plan)).toMatchObject({ mode: "full", shared: "true", cadence: "true" });
  });

  it.each([
    "scripts/ci-selection.mjs",
    "scripts/ci-selection-graph.mjs",
    "scripts/ci-selection-git.mjs",
    "scripts/ci-execution-plan.mjs",
    "scripts/ci-plan.mjs",
    "scripts/ci-runner-output.mjs",
    "scripts/check-command-plan.mjs",
    "scripts/check-execution.mjs",
    "scripts/run-checks.mjs",
    "scripts/run-ci.mjs",
    "scripts/run-validated-tests.mjs",
    "scripts/performance-test-manifest.mjs",
    "scripts/performance-test-runner.mjs",
    "scripts/performance-batch.mjs",
    "scripts/performance-gate.mjs",
    "scripts/run-performance-tests.mjs",
  ])("selects complete tests and both shards for execution infrastructure %s", async (filename) => {
    const invariant = PERFORMANCE_TEST_MANIFEST.invariant[0];
    const cadence = PERFORMANCE_TEST_MANIFEST.cadenceSensitive[0];
    const files = { [invariant]: "export {};", [cadence]: "export {};" };
    const context = await fixture(files);
    await commit(context.root, { [filename]: "export const changed = true;" });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("full");
    expect(plan.tests).toEqual(
      Object.keys({ ...initialFiles, ...files })
        .filter((file) => file.includes(".test."))
        .sort(),
    );
    expect(plan.coverage).toContain("src/domain/unrelated.ts");
    expect(selectionOutputs(plan)).toEqual({
      mode: "full",
      shared: "true",
      cadence: "true",
      build: "false",
    });
  });
});

describe("CI selection conservative fallback", () => {
  it.each([
    "test/setup.ts",
    "package-lock.json",
    "tsconfig.json",
    "unknown/file.txt",
    "scripts/build.mjs",
    "scripts/verify-package.mjs",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "docs/fixture.svg",
  ])("runs the complete suite for shared configuration %s", async (filename) => {
    const context = await fixture();
    await commit(context.root, { [filename]: "export {};" });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("full");
    expect(plan.reason).toContain(filename);
    expect(plan.coverage).toContain("src/domain/unrelated.ts");
  });

  it.each([
    ["src/domain/value.ts", 'export { value } from "./missing";', "Unresolved dependency"],
    ["src/domain/value.ts", "export const value = ;", "Cannot parse"],
    ["src/domain/value.ts", "export const value = import(variable);", "Nonliteral module"],
    ["src/domain/new.ts", "export const uncovered = 1;", "Unmatched runtime source"],
  ])("falls back when a dependency cannot be proven: %s", async (filename, source, reason) => {
    const context = await fixture();
    await commit(context.root, { [filename]: source });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("full");
    expect(plan.reason).toContain(reason);
  });

  it("falls back for missing history, empty comparisons and explicit full runs", async () => {
    const context = await fixture();
    const empty = await createSelection(context);
    const missing = await createSelection({ ...context, base: "absent-history" });
    await commit(context.root, { "docs/only.md": "Only documentation" });
    const forced = await createSelection({ ...context, forceFull: true });

    expect(empty.mode).toBe("full");
    expect(empty.reason).toContain("Empty");
    expect(missing.mode).toBe("full");
    expect(missing.base).toBeNull();
    expect(missing.reason).toContain("history");
    expect(forced.mode).toBe("full");
  });

  it("falls back if a deleted test has no surviving consumer", async () => {
    const context = await fixture();
    await git(context.root, "rm", unrelatedTest);
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });
    const plan = await createSelection(context);

    expect(plan.mode).toBe("full");
    expect(plan.reason).toContain("No surviving test");
    expect(plan.tests).not.toContain(unrelatedTest);
  });

  it("uses the docs shortcut only for nonempty changes entirely under root docs", async () => {
    const context = await fixture();
    await commit(context.root, { "docs/only.md": "Only documentation" });
    expect(await createSelection(context)).toMatchObject({ mode: "docs", tests: [], coverage: [] });
    await commit(context.root, { "README.md": "Root documentation" });
    expect((await createSelection(context)).mode).toBe("full");
  });
});

describe("CI selection validation", () => {
  const valid = {
    version: 2,
    mode: "affected",
    reason: "Dependency selection",
    base: "a".repeat(40),
    head: "b".repeat(40),
    merge: "c".repeat(40),
    mergeBase: "a".repeat(40),
    changes: ["src/domain/value.ts"],
    tests: [directTest],
    coverage: ["src/domain/value.ts"],
  };

  it.each([
    null,
    [],
    {},
    { ...valid, version: 1 },
    { ...valid, merge: null },
    { ...valid, mergeBase: null },
    { ...valid, extra: true },
    { ...valid, tests: [] },
    { ...valid, tests: [directTest, directTest] },
    { ...valid, tests: ["test/unit/../escape.test.ts"] },
    { ...valid, coverage: ["test/unit/example.ts"] },
    { ...valid, base: null },
    { ...valid, changes: [] },
    { ...valid, changes: ["../outside"] },
    { ...valid, reason: " " },
    { ...valid, mode: "docs" },
    { ...valid, mode: "unknown" },
  ])("rejects malformed or incomplete serialized plans %#", (plan) => {
    expect(() => validateSelection(plan)).toThrow();
  });

  it("preserves a complete strictly validated plan", () => {
    expect(validateSelection(valid)).toBe(valid);
  });
});
