import ts from "typescript";

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
  const encoded = [];
  function visit(node) {
    // This prefix encodes the fixed gzip header used by the native build.
    if (ts.isStringLiteral(node) && node.text.startsWith("<Ah!!!!!")) encoded.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(parseModule(source));
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

export async function verifyPortableMathPayload(outputMain) {
  const runtimes = (await readEmbeddedModules(outputMain)).filter((module) =>
    hasExport(module.ast, "activateInkbookPlugin"),
  );
  if (runtimes.length !== 1)
    throw new Error("Package must contain exactly one embedded plugin runtime.");
  const engines = (await readEmbeddedModules(runtimes[0].source)).filter((module) =>
    hasExport(module.ast, "createPortableMathRenderer"),
  );
  if (engines.length !== 1)
    throw new Error("Package must contain exactly one embedded portable math engine.");
  if (
    engines[0].ast.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) ||
        (ts.isExportDeclaration(statement) && statement.moduleSpecifier),
    )
  ) {
    throw new Error("The embedded portable math engine must bundle its offline dependencies.");
  }
}
