import { isBuiltin } from "node:module";
import path from "node:path";

import { codeFile } from "./ci-selection-git.mjs";

const embeddedEntries = new Map([
  ["src/persistence/worker/runtime/worker-source.ts", "./document-worker-entry"],
  ["src/rendering/ui/editor-chrome-source.ts", "./editor-chrome-entry"],
  ["src/obsidian/plugin-runtime-source.ts", "./plugin-runtime-entry"],
]);
const dynamicEntries = new Map([
  ["src/obsidian/plugin-loader.ts", "./plugin-runtime-entry"],
  [
    "src/obsidian/embeds/active-scene/editor-chrome-loader.ts",
    "../../../rendering/ui/editor-chrome-entry",
  ],
]);

function moduleLiteral(ts, node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  throw new Error("Nonliteral module dependency");
}

function callDependency(ts, node, filename) {
  const expression = node.expression;
  const dynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
  const requireCall = ts.isIdentifier(expression) && expression.text === "require";
  const mockCall =
    ts.isPropertyAccessExpression(expression) &&
    ["mock", "doMock", "importActual", "importMock"].includes(expression.name.text) &&
    ts.isIdentifier(expression.expression) &&
    ["vi", "vitest"].includes(expression.expression.text);
  if (dynamicImport && dynamicEntries.has(filename) && isOwnedModuleImport(ts, node.arguments[0])) {
    return dynamicEntries.get(filename);
  }
  if (dynamicImport || requireCall || mockCall) return moduleLiteral(ts, node.arguments[0]);
  return null;
}

function isOwnedModuleImport(ts, argument) {
  return (
    argument &&
    ts.isCallExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === "sanitizeOwnedModuleUrl" &&
    argument.arguments.length === 1 &&
    ts.isIdentifier(argument.arguments[0]) &&
    argument.arguments[0].text === "url"
  );
}

function isImportMetaUrl(ts, node) {
  return (
    node &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function mappedFilesystemUrl(ts, filename, node) {
  if (!ts.isTemplateExpression(node)) return false;
  if (filename === "test/unit/scripts/github-workflows.test.mjs") {
    return node.head.text === "../../../.github/workflows/";
  }
  return (
    filename === "test/unit/scripts/ci-plan-cli.test.mjs" &&
    node.head.text === "../../../" &&
    node.templateSpans.length === 1 &&
    ts.isIdentifier(node.templateSpans[0].expression) &&
    node.templateSpans[0].expression.text === "file" &&
    node.templateSpans[0].literal.text === ""
  );
}

function urlDependency(ts, filename, node) {
  if (
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "URL" ||
    !isImportMetaUrl(ts, node.arguments?.[1])
  )
    return null;
  const argument = node.arguments[0];
  if (mappedFilesystemUrl(ts, filename, argument)) return null;
  const specifier = moduleLiteral(ts, argument);
  if (!codeFile.test(specifier)) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
  if (target.startsWith("node_modules/")) return null;
  return specifier;
}

function dependencies(ts, filename, content) {
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${filename}`);
  const specifiers = new Set();
  const errors = [];
  function visit(node) {
    try {
      collect(node);
    } catch (error) {
      errors.push(error.message);
    }
    ts.forEachChild(node, visit);
  }
  function collect(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifiers.add(moduleLiteral(ts, node.moduleSpecifier));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifiers.add(moduleLiteral(ts, node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifiers.add(moduleLiteral(ts, node.argument.literal));
    } else if (ts.isCallExpression(node)) {
      const specifier = callDependency(ts, node, filename);
      if (specifier) specifiers.add(specifier);
    } else if (ts.isNewExpression(node)) {
      const specifier = urlDependency(ts, filename, node);
      if (specifier) specifiers.add(specifier);
    }
  }
  visit(source);
  const entry = embeddedEntries.get(filename);
  if (entry) specifiers.add(entry);
  return { specifiers, errors };
}

function localDependency(files, filename, specifier) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
  const stem = target.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    target,
    ...[".ts", ".tsx", ".mjs", ".js", ".mts", ".cts"].map((extension) => stem + extension),
    ...["ts", "tsx", "mjs", "js"].map((extension) => `${target}/index.${extension}`),
  ];
  const resolved = candidates.find((candidate) => files.has(candidate));
  if (!resolved) throw new Error(`Unresolved dependency ${specifier} in ${filename}`);
  return resolved;
}

function resolveDependency(ts, root, files, filename, specifier) {
  if (specifier.startsWith(".")) return localDependency(files, filename, specifier);
  if (isBuiltin(specifier)) return null;
  if (specifier === "obsidian" && files.has("test/adapters/obsidian/plugin.ts")) {
    return "test/adapters/obsidian/plugin.ts";
  }
  const resolved = ts.resolveModuleName(
    specifier,
    path.join(root, filename),
    {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
    },
    ts.sys,
  ).resolvedModule;
  if (!resolved?.isExternalLibraryImport)
    throw new Error(`Unresolved dependency ${specifier} in ${filename}`);
  return null;
}

export function createGraph(ts, root, files) {
  const edges = new Map();
  for (const [filename, content] of files) {
    const targets = new Set();
    const parsed = dependencies(ts, filename, content);
    if (parsed.errors.length) throw new Error(`${parsed.errors.join("; ")} (${filename})`);
    for (const specifier of parsed.specifiers) {
      const target = resolveDependency(ts, root, files, filename, specifier);
      if (target) targets.add(target);
    }
    edges.set(filename, targets);
  }
  return { edges };
}

export function reachable(edges, seeds) {
  const seen = new Set(seeds);
  for (const filename of seen) {
    for (const target of edges.get(filename) ?? []) seen.add(target);
  }
  return seen;
}

export function affectedFiles(graphs, changes) {
  const reverse = new Map();
  for (const { edges } of graphs) {
    for (const [filename, targets] of edges) {
      for (const target of targets) {
        if (!reverse.has(target)) reverse.set(target, new Set());
        reverse.get(target).add(filename);
      }
    }
  }
  return reachable(reverse, changes);
}
