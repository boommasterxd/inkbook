import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import ts from "typescript";

import { IMPORT_EXAMPLE_IMAGES } from "../src/obsidian/settings/import/import-example-images.ts";
import { decodeEmbeddedSource } from "../src/persistence/worker/runtime/embedded-source.ts";

function parseModule(source) {
  const parsed = ts.createSourceFile(
    "embedded.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (parsed.parseDiagnostics.length) throw new Error("Embedded package JavaScript is malformed.");
  return parsed;
}

/** Reads actual encoded payloads without executing them or maintaining a second decoder. */
export async function readEmbeddedModules(source) {
  return readEmbeddedModulesIn(parseModule(source));
}

async function readEmbeddedModulesIn(ast) {
  // This prefix encodes the fixed gzip header used by the native build.
  const encoded = matchingStrings(ast, (value) => value.startsWith("<Ah!!!!!"));
  const modules = await Promise.all(
    encoded.map((value) => decodeEmbeddedSource(value, globalThis)),
  );
  return modules.map((source) => ({ source, ast: parseModule(source) }));
}

function hasExport(ast, name) {
  return ast.statements.some((statement) => {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      return statement.exportClause.elements.some((element) => element.name.text === name);
    }
    return (
      statement.name?.text === name &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    );
  });
}

function standaloneModule(modules, exportName) {
  const [embedded, ...duplicates] = modules.filter(({ ast }) => hasExport(ast, exportName));
  if (embedded === undefined || duplicates.length > 0) {
    throw new Error(`Package must contain exactly one embedded module exporting ${exportName}.`);
  }
  if (
    embedded.ast.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) ||
        (ts.isExportDeclaration(statement) && statement.moduleSpecifier),
    )
  ) {
    throw new Error(
      `The embedded module exporting ${exportName} must bundle its offline dependencies.`,
    );
  }
  return embedded;
}

function matchingStrings(ast, matches) {
  const strings = [];
  function visit(node) {
    if (ts.isStringLiteral(node) && matches(node.text)) strings.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return strings;
}

function pngUrls(ast) {
  return matchingStrings(ast, (value) => value.startsWith("data:image/png;base64,")).sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyPackagedFontBinaries(ast) {
  const directory = "src/persistence/fonts/assets";
  const files = (await readdir(directory)).filter((name) => /\.(?:woff2|ttf)$/.test(name));
  const sources = await Promise.all([
    ...files.map((name) => readFile(`${directory}/${name}`)),
    readFile(new URL(import.meta.resolve("brotli-dec-wasm/web/bg.wasm"))),
  ]);
  const raw = new Set(sources.map((bytes) => bytes.toString("base64")));
  const expected = new Set(sources.map(sha256));
  const maximumBytes = Math.max(...sources.map((bytes) => bytes.length));
  const payloads = matchingStrings(ast, (value) => {
    if (
      raw.has(value) ||
      (value.startsWith("data:") && raw.has(value.slice(value.indexOf(",") + 1)))
    ) {
      throw new Error("The plugin runtime must defer raw font and Brotli WASM data.");
    }
    return value.startsWith("data:application/gzip;length=");
  });
  for (const payload of payloads) {
    const parsed = /^data:application\/gzip;length=([1-9]\d*);base64,(.*)$/.exec(payload);
    if (parsed === null) throw new Error("The packaged font binary has an invalid header.");
    const bytes = gunzipSync(Buffer.from(parsed[2], "base64"), { maxOutputLength: maximumBytes });
    if (bytes.length !== Number(parsed[1]) || !expected.delete(sha256(bytes))) {
      throw new Error("The packaged font binaries must preserve exact source bytes once each.");
    }
  }
  if (expected.size !== 0)
    throw new Error("The package is missing a compressed font or Brotli WASM binary.");
}

export async function verifyEmbeddedPackageModules(outputMain) {
  const runtimes = (await readEmbeddedModules(outputMain)).filter((module) =>
    hasExport(module.ast, "activateInkbookPlugin"),
  );
  if (runtimes.length !== 1)
    throw new Error("Package must contain exactly one embedded plugin runtime.");
  const [runtime] = runtimes;
  const modules = await readEmbeddedModulesIn(runtime.ast);
  standaloneModule(modules, "mountEditorChrome");
  standaloneModule(modules, "createPortableMathRenderer");
  const examples = standaloneModule(modules, "IMPORT_EXAMPLE_IMAGES");
  const expectedUrls = IMPORT_EXAMPLE_IMAGES.flatMap(({ before, after }) => [
    before.src,
    after.src,
  ]).sort();
  const actualUrls = pngUrls(examples.ast);
  if (
    actualUrls.length !== expectedUrls.length ||
    actualUrls.some((url, index) => url !== expectedUrls[index])
  ) {
    throw new Error("The embedded import examples must preserve all source PNG bytes.");
  }
  const eagerUrls = new Set(pngUrls(runtime.ast));
  if (expectedUrls.some((url) => eagerUrls.has(url))) {
    throw new Error("The plugin runtime must defer the import example PNG data.");
  }
  await verifyPackagedFontBinaries(runtime.ast);
}
