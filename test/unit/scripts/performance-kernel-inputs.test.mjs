import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";

import { createKernelInputGraph } from "../../../scripts/performance-kernel-inputs.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(files, configuration = {}) {
  const sourceRoot = await mkdtemp(join(tmpdir(), "inkbook-input-graph-"));
  directories.push(sourceRoot);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(sourceRoot, "src", path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  const result = await build({
    absWorkingDir: sourceRoot,
    entryPoints: Object.keys(files)
      .filter((path) => path.startsWith("entry"))
      .map((path) => `src/${path}`),
    bundle: true,
    write: false,
    outdir: "output",
    platform: "node",
    packages: "external",
    metafile: true,
    logLevel: "silent",
    ...configuration,
  });
  return { sourceRoot, metafile: result.metafile };
}

const sources = {
  "entry.ts": 'export { value } from "./transitive";',
  "transitive.ts": 'export { value } from "./leaf";',
  "leaf.ts": "export const value = 1;",
  "entry-other.ts": "export const other = 2;",
};

it("hashes real transitive inputs independently of variant paths and unrelated modules", async () => {
  const first = await fixture(sources);
  const second = await fixture({ ...sources, "entry-other.ts": "export const other = 99;" });
  const a = await createKernelInputGraph(first);
  const b = await createKernelInputGraph(second);
  expect(a.hashScenarioInputs(["entry"])).toEqual(b.hashScenarioInputs(["entry"]));
  expect(a.hashScenarioInputs(["entry"]).inputs).toEqual([
    "src/entry.ts",
    "src/leaf.ts",
    "src/transitive.ts",
  ]);
  expect(a.hashScenarioInputs(["entry-other"]).hash).not.toBe(
    b.hashScenarioInputs(["entry-other"]).hash,
  );
});

it("changes the hash for an indirectly imported implementation and respects module sets", async () => {
  const first = await createKernelInputGraph(await fixture(sources));
  const second = await createKernelInputGraph(
    await fixture({
      ...sources,
      "leaf.ts": "export const value = 2;",
    }),
  );
  expect(first.hashScenarioInputs(["entry"]).hash).not.toBe(
    second.hashScenarioInputs(["entry"]).hash,
  );
  expect(first.hashScenarioInputs(["entry", "entry-other"])).toEqual(
    first.hashScenarioInputs(["entry-other", "entry", "entry"]),
  );
});

it.each([
  'export const value = () => import("./leaf");',
  "export const value = (path: string) => import(path);",
  "export const value = (path: string) => require(path);",
  "export const value = (source: string) => eval(source);",
  "const load = require; export const value = (path: string) => load(path);",
  'export const value = new URL("./leaf.ts", import.meta.url);',
])("conservatively rejects opaque module loading: %s", async (entry) => {
  const graph = await createKernelInputGraph(await fixture({ ...sources, "entry.ts": entry }));
  expect(graph.hashScenarioInputs(["entry"]).hash).toBeNull();
});

it("does not mistake comments and ordinary strings for dynamic imports", async () => {
  const graph = await createKernelInputGraph(
    await fixture({
      "entry.ts": '/* import(path) */ export const value = "require(unknown)";',
    }),
  );
  expect(graph.hashScenarioInputs(["entry"]).hash).toMatch(/^[a-f0-9]{64}$/);
});

it("permits verified external packages but rejects externally loaded source files", async () => {
  const packaged = await createKernelInputGraph(
    await fixture({
      "entry.ts": 'export { join } from "node:path";',
    }),
  );
  expect(packaged.hashScenarioInputs(["entry"]).hash).toMatch(/^[a-f0-9]{64}$/);
  const external = await createKernelInputGraph(await fixture(sources, { external: ["./leaf"] }));
  expect(external.hashScenarioInputs(["entry"]).hash).toBeNull();
});

it("rejects missing module roots, missing edges, and unreadable source inputs", async () => {
  const configuration = await fixture(sources);
  delete configuration.metafile.inputs["src/leaf.ts"];
  const incomplete = await createKernelInputGraph(configuration);
  expect(incomplete.hashScenarioInputs(["entry"]).hash).toBeNull();
  expect(incomplete.hashScenarioInputs(["unknown"]).hash).toBeNull();
  const unreadable = await fixture(sources);
  await rm(join(unreadable.sourceRoot, "src/leaf.ts"));
  expect((await createKernelInputGraph(unreadable)).hashScenarioInputs(["entry"]).hash).toBeNull();
});

it("bounds invalid populations", async () => {
  const configuration = await fixture(sources);
  await expect(createKernelInputGraph({ ...configuration, metafile: {} })).rejects.toThrow();
  const graph = await createKernelInputGraph(configuration);
  expect(() => graph.hashScenarioInputs([])).toThrow();
  expect(() => graph.hashScenarioInputs(Array(501).fill("entry"))).toThrow();
});
