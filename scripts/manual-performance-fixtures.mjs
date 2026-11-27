import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { createDenseFixture } from "./manual-performance-dense.mjs";
import {
  createStandardFixture,
  createStressFixture,
  verifyStressLimits,
} from "./manual-performance-standard.mjs";

const FIXTURE_VERSION = 1;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TITLES = {
  standard: "Standard geometry",
  dense: "Dense viewport",
  stress: "Stress limit",
};

function fixtureId(number) {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

async function outputDirectory(args) {
  const [mode] = args;
  if (args.length > 1 || (mode !== undefined && mode !== "--stress"))
    throw new Error("Usage: node scripts/manual-performance-fixtures.mjs [--stress]");
  const temporary = await realpath(tmpdir());
  const fromRoot = relative(await realpath(ROOT), temporary);
  if (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
    throw new Error("The system temporary directory must be outside the checkout.");
  const directory = await mkdtemp(join(temporary, "inkbook-performance-"));
  return { directory, stress: mode === "--stress" };
}

async function productionCodec() {
  const { outputFiles } = await build({
    stdin: {
      contents: [
        'export { serializeInkbookDocument } from "./src/persistence/serialization/document-codec.ts";',
        'export { FILE_SCHEMA_LIMITS, PAGE_MARGIN, PAGE_WIDTH } from "./src/domain/schema/constants.ts";',
        'export { validateInkSnapshotV1 } from "./src/domain/schema/snapshot-validation.ts";',
        'export { elementSnapshotVersion } from "./src/domain/schema/snapshot-version.ts";',
        'export { BUILT_IN_COLORS } from "./src/domain/settings/color-palette.ts";',
      ].join("\n"),
      resolveDir: ROOT,
      sourcefile: "manual-performance-codec.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const url = `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`;
  // Resolve one fixed internal import to the bundle just built from repository sources.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "inkbook:manual-performance-codec" && context.parentURL === import.meta.url)
        return { url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  try {
    return await import("inkbook:manual-performance-codec");
  } finally {
    hook.deregister();
  }
}

function encodeFixture(codec, elements) {
  const snapshot = {
    format: "inkbook",
    version: codec.elementSnapshotVersion(elements),
    revision: 1,
    page: {
      innerWidth: Math.round(codec.PAGE_WIDTH - 2 * codec.PAGE_MARGIN),
      margin: codec.PAGE_MARGIN,
      activeBufferLines: 3,
      lockedBufferLines: 1,
      background: { type: "none" },
    },
    elements,
  };
  const result = codec.serializeInkbookDocument(snapshot);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function writeOutput(directory, name, value) {
  return writeFile(join(directory, name), value, { flag: "wx", mode: 0o600 });
}

function writeJson(directory, name, value) {
  return writeOutput(directory, name, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeDrawing(directory, name, encoded) {
  await writeOutput(directory, `${name}.svg`, encoded.svg);
  await writeOutput(directory, `${name}.md`, `# ${TITLES[name]}\n\n![[${name}.svg]]\n`);
  return {
    svg: `${name}.svg`,
    note: `${name}.md`,
    sha256: encoded.hash,
    lockedHeight: encoded.lockedHeight,
    svgBytes: encoded.totalBytes,
    metadataBytes: encoded.metadataBytes,
  };
}

async function writeReferenceFixtures(directory, codec) {
  const standard = createStandardFixture(fixtureId, codec.BUILT_IN_COLORS);
  const dense = createDenseFixture(fixtureId);
  const encoded = encodeFixture(codec, standard.elements);
  if (encoded.lockedHeight < standard.expected.minimumLockedHeight)
    throw new Error("The standard fixture does not reach the required page height.");
  const standardFiles = await writeDrawing(directory, "standard", encoded);
  const denseFiles = await writeDrawing(directory, "dense", encodeFixture(codec, dense.elements));
  await writeJson(directory, "dense-expectations.json", {
    fixtureVersion: FIXTURE_VERSION,
    ...dense.expectations,
  });
  return {
    standard: { ...standardFiles, expected: standard.expected },
    dense: { ...denseFiles, expectations: "dense-expectations.json" },
  };
}

async function writeStressFixture(directory, codec) {
  const fixedBlack = codec.BUILT_IN_COLORS[1];
  const fixture = createStressFixture(fixtureId, fixedBlack, codec.FILE_SCHEMA_LIMITS);
  const encoded = encodeFixture(codec, fixture.elements);
  const rejection = verifyStressLimits(encoded.snapshot, codec.validateInkSnapshotV1, fixtureId);
  const files = await writeDrawing(directory, "stress", encoded);
  return { stress: { ...files, expected: { ...fixture.expected, rejection } } };
}

try {
  const { directory, stress } = await outputDirectory(process.argv.slice(2));
  const codec = await productionCodec();
  const fixtures = stress
    ? await writeStressFixture(directory, codec)
    : await writeReferenceFixtures(directory, codec);
  await writeJson(directory, "manifest.json", { fixtureVersion: FIXTURE_VERSION, fixtures });
  process.stdout.write(`Generated manual performance fixtures in ${directory}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
