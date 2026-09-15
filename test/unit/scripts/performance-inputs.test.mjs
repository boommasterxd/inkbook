import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { planPerformanceInputs } from "../../../scripts/performance-inputs.mjs";

const directories = [];
const testFiles = ["test/performance/example.test.ts", "test/performance/other.test.ts"];
const sources = {
  "test/performance/example.test.ts":
    'import { value } from "../../src/entry"; console.log(value);',
  "test/performance/other.test.ts": 'import { other } from "../../src/other"; console.log(other);',
  "src/entry.ts": 'export { value } from "./leaf";',
  "src/leaf.ts": "export const value = 1;",
  "src/other.ts": "export const other = 2;",
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(changes = {}) {
  const root = await mkdtemp(join(tmpdir(), "inkbook-direct-inputs-"));
  directories.push(root);
  await copyFile(
    new URL("../../../vitest.config.ts", import.meta.url),
    join(root, "vitest.config.ts"),
  );
  for (const [path, contents] of Object.entries({ ...sources, ...changes })) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

async function compare(changes) {
  const referenceRoot = await fixture();
  const candidateRoot = await fixture(changes);
  return planPerformanceInputs({ referenceRoot, candidateRoot, testFiles });
}

it("skips only identical full input graphs and measures a changed transitive leaf", async () => {
  const unchanged = await compare({});
  expect(unchanged.pending).toEqual([]);
  expect(unchanged.identicalInputs.map(({ file }) => file)).toEqual(testFiles);
  const changed = await compare({ "src/leaf.ts": "export const value = 3;" });
  expect(changed.pending).toEqual([testFiles[0]]);
  expect(changed.identicalInputs[0].file).toBe(testFiles[1]);
  expect(changed.inputs[0].candidate.inputs).toEqual(["src/entry.ts", "src/leaf.ts", testFiles[0]]);
});

it.each([
  'export const value = () => import("./leaf");',
  "export const value = (path: string) => import(path);",
  "export const value = (path: string) => require(path);",
  "export const value = (source: string) => eval(source);",
  "const load = require; export const value = (path: string) => load(path);",
  'export const value = new URL("./leaf.ts", import.meta.url);',
  'import { readFileSync } from "node:fs"; export const value = () => readFileSync("data");',
])("measures opaque loading instead of assuming identical inputs: %s", async (entry) => {
  const referenceRoot = await fixture({ "src/entry.ts": entry });
  const candidateRoot = await fixture({ "src/entry.ts": entry });
  const plan = await planPerformanceInputs({ referenceRoot, candidateRoot, testFiles });
  expect(plan.pending).toContain(testFiles[0]);
  expect(plan.inputs[0].reference.hash).toBeNull();
});

it("measures every selected file when runner configuration or resolution is unknown", async () => {
  for (const changes of [
    { "vitest.config.ts": "export default {};" },
    { "src/entry.ts": 'export { value } from "./missing";' },
  ]) {
    const plan = await compare(changes);
    expect(plan.pending).toEqual(testFiles);
    expect(plan.identicalInputs).toEqual([]);
  }
});

it("does not prove identity through a workspace symlink", async () => {
  const referenceRoot = await fixture();
  const candidateRoot = await fixture();
  await rm(join(candidateRoot, "src/leaf.ts"));
  await symlink(join(referenceRoot, "src/leaf.ts"), join(candidateRoot, "src/leaf.ts"));
  const plan = await planPerformanceInputs({ referenceRoot, candidateRoot, testFiles });
  expect(plan.pending).toContain(testFiles[0]);
});

it.each([[], ["../outside.test.ts"], [testFiles[0], testFiles[0]], ["src/example.ts"]])(
  "rejects invalid file selections %j",
  async (files) => {
    await expect(planPerformanceInputs({ testFiles: files })).rejects.toThrow();
  },
);
