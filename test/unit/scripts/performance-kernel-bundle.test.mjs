import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bundleComparisonVariant,
  createComparisonBoundaryPlugin,
  createComparisonEntry,
  createComparisonImplementation,
  planKernelComparisons,
  validateKernelAccounting,
} from "../../../scripts/performance-kernel-bundle.mjs";

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("comparison variant bundles", () => {
  it("retains one shared module identity inside each independent source graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkbook-kernel-bundle-test-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/shared.ts"), "export const state = { value: 1 };\n");
    await writeFile(join(root, "src/first.ts"), "export { state } from './shared';\n");
    await writeFile(join(root, "src/second.ts"), "export { state } from './shared';\n");
    const implementations = [];
    for (const side of ["base", "candidate"]) {
      const outputPath = join(root, `${side}.mjs`);
      const result = await bundleComparisonVariant({
        sourceRoot: root,
        harnessRoot: root,
        modules: ["first", "second"],
        outputPath,
      });
      expect(result.moduleIds).toEqual(["first", "second"]);
      expect(result.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
      // eslint-disable-next-line no-unsanitized/method -- Import only this test's generated bundle in its owned temporary directory.
      const bundled = await import(pathToFileURL(outputPath).href);
      implementations.push(createComparisonImplementation(bundled.modules));
    }
    expect(implementations[0].get("first").state).toBe(implementations[0].get("second").state);
    expect(implementations[0].get("first").state).not.toBe(implementations[1].get("first").state);
    expect(() => implementations[0].get("missing")).toThrow("not bundled");
  });

  it.each([[], ["../secret"], ["/absolute"], ["a;injection"], Array(501).fill("module")])(
    "rejects unsafe or excessive module selections",
    (modules) => {
      expect(() => createComparisonEntry(modules, "/workspace")).toThrow();
    },
  );

  it("shares host boundaries while redirecting only the chrome root importer", () => {
    const callbacks = [];
    createComparisonBoundaryPlugin({ sourceRoot: "/source", harnessRoot: "/harness" }).setup({
      onResolve: (options, callback) => callbacks.push({ ...options, callback }),
    });
    const obsidian = callbacks.find(({ filter }) => filter.test("obsidian")).callback;
    expect(obsidian()).toEqual({
      path: "/harness/test/adapters/obsidian/plugin.ts",
      external: true,
    });
    const react = callbacks.find(({ filter }) => filter.test("react-dom/client")).callback;
    expect(react({ importer: "/source/src/rendering/ui/mount-editor-chrome.tsx" })).toEqual({
      path: "/harness/test/performance/comparison/react-root-probe.ts",
      external: true,
    });
    expect(react({ importer: "/source/src/obsidian/settings.ts" })).toBeUndefined();
    expect(() => createComparisonImplementation(null)).toThrow("Missing");
  });
});

describe("complete comparison accounting", () => {
  const scenarios = [
    { id: "first", modules: ["first"] },
    { id: "second", modules: ["second"] },
  ];
  const graph = (hash) => ({ hashScenarioInputs: () => ({ hash, inputs: ["src/first.ts"] }) });
  const options = {
    scenarios,
    referenceGraph: graph("a".repeat(64)),
    candidateGraph: graph("a".repeat(64)),
    refreshRate: 240,
  };

  it("skips only equal non-null transitive hashes and retains provenance", () => {
    const result = planKernelComparisons(options);
    expect(result.pending).toEqual([]);
    expect(result.identicalInputs).toHaveLength(2);
    expect(result.scenarioInputs).toHaveLength(2);
    expect(result.identicalInputs[0]).toEqual({
      id: "first",
      refreshRate: 240,
      inputHash: "a".repeat(64),
      inputs: ["src/first.ts"],
    });
    expect(
      planKernelComparisons({
        ...options,
        referenceGraph: graph(null),
        candidateGraph: graph(null),
      }).pending,
    ).toEqual(scenarios);
    expect(
      planKernelComparisons({ ...options, candidateGraph: graph("b".repeat(64)) }).pending,
    ).toEqual(scenarios);
    expect(() => planKernelComparisons({ ...options, candidateGraph: graph(undefined) })).toThrow(
      "Invalid",
    );
  });

  it("permits a forced local diagnostic but forbids it in CI", () => {
    vi.stubEnv("CI", "false");
    expect(planKernelComparisons({ ...options, forceComparison: true }).pending).toEqual(scenarios);
    vi.stubEnv("CI", "true");
    expect(() => planKernelComparisons({ ...options, forceComparison: true })).toThrow(
      "local diagnostic",
    );
  });

  it("requires exactly one result or identity proof for every scenario", () => {
    const evidence = {
      scenarios,
      refreshRate: 240,
      measurements: [{ id: "first", refreshRate: 240 }],
      identicalInputs: [{ id: "second", refreshRate: 240 }],
    };
    expect(() => validateKernelAccounting(evidence)).not.toThrow();
    expect(() => validateKernelAccounting({ ...evidence, identicalInputs: [] })).toThrow("Missing");
    expect(() =>
      validateKernelAccounting({ ...evidence, identicalInputs: evidence.measurements }),
    ).toThrow("duplicate");
    expect(() =>
      validateKernelAccounting({ ...evidence, measurements: [{ id: "first", refreshRate: 120 }] }),
    ).toThrow("wrong-profile");
    expect(() => validateKernelAccounting({ ...evidence, measurements: undefined })).toThrow(
      "arrays",
    );
    expect(() =>
      planKernelComparisons({ ...options, scenarios: [scenarios[0], scenarios[0]] }),
    ).toThrow("identity");
  });
});
