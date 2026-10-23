import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createSelection } from "../../../scripts/ci-selection.mjs";
import { cleanupRepositories, commit, createRepository, write } from "./ci-selection-fixtures.mjs";

const execute = promisify(execFile);
const selectedTest = "test/unit/domain/value.test.ts";
const unrelatedTest = "test/unit/domain/unrelated.test.ts";
const vitestCli = fileURLToPath(
  new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
);

afterEach(cleanupRepositories);

async function fixture(files = {}) {
  return createRepository({
    "src/domain/value.ts": "export const value = 1;",
    [selectedTest]: 'import { value } from "../../../src/domain/value"; void value;',
    ...files,
  });
}

describe("syntax-aware affected dependencies", () => {
  it("tracks every supported TypeScript-parsed dependency form independently", async () => {
    const sources = [
      'import type { value } from "../../../src/domain/value"; type Value = typeof value;',
      'type Value = typeof import("../../../src/domain/value").value;',
      'const value = require("../../../src/domain/value");',
      'const value = await import("../../../src/domain/value");',
      'export { value } from "../../../src/domain/value";',
    ];
    const tests = sources.map((_source, index) => `test/unit/domain/syntax-${index}.test.ts`);
    const context = await fixture({
      [selectedTest]: "export {};",
      ...Object.fromEntries(sources.map((source, index) => [tests[index], source])),
    });
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });

    expect(await createSelection(context)).toMatchObject({
      mode: "affected",
      tests: tests.sort(),
    });
  });

  it("includes affected runtime modules even when no selected test imports them", async () => {
    const context = await fixture({ "src/domain/untested.ts": 'export { value } from "./value";' });
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });

    expect((await createSelection(context)).coverage).toEqual([
      "src/domain/untested.ts",
      "src/domain/value.ts",
    ]);
  });

  it("does not treat import text in comments or strings as a dependency", async () => {
    const context = await fixture({
      [unrelatedTest]:
        'const text = \'import("../../../src/domain/value")\'; // import("./missing")\nvoid text;',
    });
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });

    expect((await createSelection(context)).tests).toEqual([selectedTest]);
  });

  it("falls back globally for unknown dynamic modules outside the apparent affected closure", async () => {
    const context = await fixture({
      "src/domain/dynamic.ts": "export const load = (name: string) => import(name);",
    });
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });

    expect(await createSelection(context)).toMatchObject({
      mode: "full",
      reason: expect.stringContaining("Nonliteral"),
    });
  });

  it("retains coverage when production sources have only performance consumers", async () => {
    const context = await fixture({
      [selectedTest]: "export {};",
      "test/performance/value.test.ts":
        'import { value } from "../../src/domain/value"; void value;',
    });
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });

    expect(await createSelection(context)).toMatchObject({
      mode: "full",
      reason: expect.stringContaining("no Unit or Integration coverage"),
    });
  });
});

describe("isolated runner URL dependencies", () => {
  it.each(["test/performance/isolated-runner.ts", "src/domain/value.ts"])(
    "selects the spawning contract for changes to %s",
    async (changed) => {
      const contract = "test/performance/memory.test.ts";
      const context = await fixture({
        "test/performance/isolated-runner.ts": 'export { value } from "../../src/domain/value";',
        [contract]: 'const runner = new URL("./isolated-runner.ts", import.meta.url); void runner;',
      });
      await commit(context.root, {
        [changed]: changed.startsWith("src/")
          ? "export const value = 2;"
          : 'export { value } from "../../src/domain/value"; // changed',
      });

      const plan = await createSelection(context);
      expect(plan.mode).toBe("affected");
      expect(plan.tests).toContain(contract);
    },
  );

  it("fails closed for unknown computed local URL resources", async () => {
    const context = await fixture({
      "test/fixtures/runner.ts": "const runner = new URL(filename, import.meta.url); void runner;",
    });
    await commit(context.root, { "src/domain/value.ts": "export const value = 2;" });

    expect(await createSelection(context)).toMatchObject({
      mode: "full",
      reason: expect.stringContaining("Nonliteral"),
    });
  });
});

describe("embedded module build mappings", () => {
  it.each([
    [
      "src/persistence/worker/runtime/worker-source.ts",
      "src/persistence/worker/runtime/document-worker-entry.ts",
    ],
    ["src/rendering/ui/editor-chrome-source.ts", "src/rendering/ui/editor-chrome-entry.ts"],
    ["src/obsidian/plugin-runtime-source.ts", "src/obsidian/plugin-runtime-entry.ts"],
  ])("connects encoded source %s to its actual build entry", async (source, entry) => {
    const context = await fixture({
      [source]: "export const encoded = 'placeholder';",
      [entry]: "export const runtime = 1;",
      [selectedTest]: `import { encoded } from "../../../${source}"; void encoded;`,
    });
    await commit(context.root, { [entry]: "export const runtime = 2;" });

    expect(await createSelection(context)).toMatchObject({
      mode: "affected",
      tests: [selectedTest],
      coverage: [entry, source].sort(),
    });
  });

  it.each([
    ["src/obsidian/plugin-loader.ts", "src/obsidian/plugin-runtime-entry.ts"],
    [
      "src/obsidian/embeds/active-scene/editor-chrome-loader.ts",
      "src/rendering/ui/editor-chrome-entry.ts",
    ],
  ])("maps the known owned dynamic loader %s", async (loader, entry) => {
    const context = await fixture({
      [loader]:
        "const sanitizeOwnedModuleUrl = (url: string) => url; export const load = (url: string) => import(sanitizeOwnedModuleUrl(url));",
      [entry]: "export const runtime = 1;",
      [selectedTest]: `import { load } from "../../../${loader}"; void load;`,
    });
    await commit(context.root, { [entry]: "export const runtime = 2;" });

    expect(await createSelection(context)).toMatchObject({
      mode: "affected",
      tests: [selectedTest],
      coverage: [entry, loader].sort(),
    });
  });
});

it("executes the selected Vitest files and propagates a real relevant failure", async () => {
  const context = await fixture({
    [selectedTest]:
      'import { value } from "../../../src/domain/value"; it("value", () => { expect(value).toBe(1); });',
    [unrelatedTest]: 'it("unrelated failure", () => { throw new Error("unrelated failure"); });',
    "vitest.config.mjs":
      'export default { test: { globals: true, maxWorkers: 1, environment: "node" } };',
  });
  await commit(context.root, { "src/domain/value.ts": "export const value = 1; // changed" });
  const plan = await createSelection(context);
  expect(plan.mode).toBe("affected");
  expect(plan.tests).toEqual([selectedTest]);
  const args = [
    vitestCli,
    "run",
    "--root",
    context.root,
    "--config",
    path.join(context.root, "vitest.config.mjs"),
    ...plan.tests,
  ];
  const passed = await execute(process.execPath, args, {
    cwd: context.root,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(passed.stdout).toContain("1 passed");
  await write(context.root, { "src/domain/value.ts": "export const value = 2;" });

  await expect(
    execute(process.execPath, args, { cwd: context.root, encoding: "utf8", timeout: 20_000 }),
  ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("1 failed") });
});
