import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { build } from "esbuild";

export function createComparisonEntry(modules, sourceRoot) {
  if (!Array.isArray(modules) || modules.length === 0 || modules.length > 500) {
    throw new Error("Comparison bundles require between 1 and 500 source modules.");
  }
  const identifiers = [...new Set(modules)].sort();
  for (const identifier of identifiers) {
    if (typeof identifier !== "string" || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(identifier)) {
      throw new Error(`Unsafe comparison source module: ${identifier}.`);
    }
  }
  const imports = identifiers.map(
    (identifier, index) =>
      `import * as module${index} from ${JSON.stringify(join(resolve(sourceRoot), "src", identifier))};`,
  );
  const entries = identifiers.map(
    (identifier, index) => `${JSON.stringify(identifier)}: module${index}`,
  );
  return `${imports.join("\n")}\nexport const modules = {${entries.join(",")}};\n`;
}

export function createComparisonImplementation(modules) {
  if (!modules || typeof modules !== "object")
    throw new Error("Missing comparison module exports.");
  return {
    get(identifier) {
      if (!Object.hasOwn(modules, identifier))
        throw new Error(`Comparison module was not bundled: ${identifier}.`);
      return modules[identifier];
    },
  };
}

export function createComparisonBoundaryPlugin({ sourceRoot, harnessRoot }) {
  const chromeImporter = join(resolve(sourceRoot), "src/rendering/ui/mount-editor-chrome.tsx");
  return {
    name: "comparison-owned-boundaries",
    setup(plugin) {
      plugin.onResolve({ filter: /^obsidian$/ }, () => ({
        path: join(resolve(harnessRoot), "test/adapters/obsidian/plugin.ts"),
        external: true,
      }));
      plugin.onResolve({ filter: /^react-dom\/client$/ }, ({ importer }) => {
        if (resolve(importer) !== chromeImporter) return undefined;
        return {
          path: join(resolve(harnessRoot), "test/performance/comparison/react-root-probe.ts"),
          external: true,
        };
      });
    },
  };
}

export async function bundleComparisonVariant({ sourceRoot, harnessRoot, modules, outputPath }) {
  sourceRoot = await realpath(sourceRoot);
  harnessRoot = await realpath(harnessRoot);
  const contents = createComparisonEntry(modules, sourceRoot);
  const result = await build({
    absWorkingDir: sourceRoot,
    metafile: true,
    stdin: { contents, resolveDir: sourceRoot, sourcefile: "comparison-entry.mjs", loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node26",
    packages: "external",
    logLevel: "silent",
    plugins: [createComparisonBoundaryPlugin({ sourceRoot, harnessRoot })],
  });
  if (result.outputFiles.length !== 1)
    throw new Error("Expected exactly one comparison bundle per variant.");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.outputFiles[0].contents);
  return {
    outputPath,
    moduleIds: [...new Set(modules)].sort(),
    metafile: result.metafile,
    bundleSha256: createHash("sha256").update(result.outputFiles[0].contents).digest("hex"),
  };
}

export function planKernelComparisons({
  scenarios,
  referenceGraph,
  candidateGraph,
  refreshRate,
  forceComparison = false,
}) {
  if (forceComparison && process.env.CI === "true")
    throw new Error("Forced comparisons are a local diagnostic only.");
  const pending = [];
  const identicalInputs = [];
  const scenarioInputs = [];
  const ids = new Set();
  for (const scenario of scenarios) {
    if (!scenario.id || ids.has(scenario.id))
      throw new Error("Duplicate or missing comparison scenario identity.");
    ids.add(scenario.id);
    const reference = referenceGraph.hashScenarioInputs(scenario.modules);
    const candidate = candidateGraph.hashScenarioInputs(scenario.modules);
    for (const input of [reference, candidate]) {
      if (
        !input ||
        (input.hash !== null && !/^[a-f0-9]{64}$/.test(input.hash ?? "")) ||
        !Array.isArray(input.inputs)
      )
        throw new Error("Invalid scenario input evidence.");
    }
    scenarioInputs.push({ id: scenario.id, reference, candidate });
    if (!forceComparison && reference.hash !== null && reference.hash === candidate.hash) {
      identicalInputs.push({
        id: scenario.id,
        refreshRate,
        inputHash: reference.hash,
        inputs: reference.inputs,
      });
    } else pending.push(scenario);
  }
  return { pending, identicalInputs, scenarioInputs };
}

export function validateKernelAccounting({
  scenarios,
  measurements,
  identicalInputs,
  refreshRate,
}) {
  if (!Array.isArray(measurements) || !Array.isArray(identicalInputs))
    throw new Error("Missing comparison evidence arrays.");
  const remaining = new Set(scenarios.map(({ id }) => id));
  if (remaining.size !== scenarios.length)
    throw new Error("Duplicate comparison scenario identity.");
  for (const record of [...measurements, ...identicalInputs]) {
    if (!record || record.refreshRate !== refreshRate || !remaining.delete(record.id)) {
      throw new Error("Unexpected, duplicate, or wrong-profile comparison evidence.");
    }
  }
  if (remaining.size > 0)
    throw new Error(`Missing comparison evidence: ${[...remaining].join(", ")}.`);
}
