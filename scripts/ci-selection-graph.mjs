import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

import { codeFile } from "./ci-selection-git.mjs";

const embeddedEntries = new Map([
  ["src/persistence/worker/runtime/worker-source.ts", "./document-worker-entry"],
  ["src/rendering/ui/editor-chrome-source.ts", "./editor-chrome-entry"],
  ["src/obsidian/plugin-runtime-source.ts", "./plugin-runtime-entry"],
  ["src/obsidian/text/portable-math-source.ts", "./portable-math-entry"],
  ["src/obsidian/settings/import/import-example-source.ts", "./import-example-images"],
]);
const dynamicEntries = new Map([
  ["src/obsidian/plugin-loader.ts", "./plugin-runtime-entry"],
  ["src/obsidian/text/portable-math-loader.ts", "./portable-math-entry"],
  ["src/obsidian/settings/import/import-example-loader.ts", "./import-example-images"],
  [
    "src/obsidian/embeds/active-scene/editor-chrome-loader.ts",
    "../../../rendering/ui/editor-chrome-entry",
  ],
]);
const cacheFixtures = new Map([
  ["test/unit/scripts/cache-lifecycle/io.cjs", ["github.cjs"]],
  ["test/unit/scripts/cache-lifecycle/recovery.cjs", ["recovery.cjs"]],
  [
    "test/unit/scripts/cache-lifecycle/register.cjs",
    ["core.cjs", "github.cjs", "planner.cjs", "run.cjs"],
  ],
]);
const wasmModule = "brotli-dec-wasm/web/bg.wasm";

function isNamedIdentifier(ts, node, name) {
  return node && ts.isIdentifier(node) && node.text === name;
}

function moduleLiteral(ts, node) {
  if (node && ts.isStringLiteralLike(node)) return node.text;
  throw new Error("Nonliteral module dependency");
}

function cacheFixtureDependency(ts, filename, argument) {
  const names = cacheFixtures.get(filename);
  if (!names || !argument || !ts.isCallExpression(argument)) return null;
  const [directory, file] = argument.arguments;
  const method = argument.expression;
  if (
    !ts.isPropertyAccessExpression(method) ||
    !isNamedIdentifier(ts, method.expression, "path") ||
    method.name.text !== "join" ||
    argument.arguments.length !== 2 ||
    !isNamedIdentifier(ts, directory, "directory") ||
    !ts.isStringLiteralLike(file) ||
    !names.includes(file.text)
  )
    return null;
  // The test entry always passes scripts/cache-lifecycle as the fixture directory.
  return path.posix.relative(path.posix.dirname(filename), `scripts/cache-lifecycle/${file.text}`);
}

function mockDependency(ts, method, argument) {
  if (
    ["mock", "doMock"].includes(method) &&
    argument &&
    ts.isCallExpression(argument) &&
    argument.expression.kind === ts.SyntaxKind.ImportKeyword &&
    argument.arguments.length === 1
  )
    return moduleLiteral(ts, argument.arguments[0]);
  return moduleLiteral(ts, argument);
}

function callDependency(ts, node, filename) {
  const expression = node.expression;
  const argument = node.arguments[0];
  const dynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
  const mockCall =
    ts.isPropertyAccessExpression(expression) &&
    ["mock", "doMock", "importActual", "importMock"].includes(expression.name.text) &&
    ts.isIdentifier(expression.expression) &&
    ["vi", "vitest"].includes(expression.expression.text);
  if (dynamicImport && dynamicEntries.has(filename) && isOwnedModuleImport(ts, argument)) {
    return dynamicEntries.get(filename);
  }
  if (dynamicImport) return moduleLiteral(ts, argument);
  if (isNamedIdentifier(ts, expression, "require")) {
    return cacheFixtureDependency(ts, filename, argument) ?? moduleLiteral(ts, argument);
  }
  if (mockCall) return mockDependency(ts, expression.name.text, argument);
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
  if (!node || !ts.isTemplateExpression(node)) return false;
  if (filename === "test/unit/scripts/github-workflows.test.mjs") {
    return node.head.text === "../../../.github/workflows/";
  }
  if (filename === "test/unit/persistence/serialization/text-roundtrip.test.ts") {
    // Font asset changes already select every test through the non-code source rule.
    const parts = [
      ["family", "-"],
      ["weight", "-"],
      ["style", ".woff2"],
    ];
    return (
      node.head.text === "../../../../src/persistence/fonts/assets/" &&
      node.templateSpans.length === parts.length &&
      node.templateSpans.every(({ expression, literal }, index) => {
        const [name, suffix] = parts[index];
        return isNamedIdentifier(ts, expression, name) && literal.text === suffix;
      })
    );
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

function bundledFontAsset(filename, specifier) {
  if (filename !== "src/persistence/fonts/builtin-fonts.ts") return null;
  if (
    !/^\.\/assets\/(?:[a-zA-Z0-9-]+\.(?:woff2|ttf)\?inline|[a-zA-Z0-9-]+-OFL\.txt\?raw)$/.test(
      specifier,
    )
  )
    return null;
  return path.posix.join(path.posix.dirname(filename), specifier.split("?")[0]);
}

function resolveDependency(ts, root, files, filename, specifier) {
  const asset = bundledFontAsset(filename, specifier);
  if (asset) {
    if (files.has(asset)) return asset;
    throw new Error(`Unresolved dependency ${specifier} in ${filename}`);
  }
  if (specifier === `${wasmModule}?url&inline`) {
    try {
      createRequire(path.join(root, filename)).resolve(wasmModule);
    } catch {
      throw new Error(`Unresolved dependency ${specifier} in ${filename}`);
    }
    return null;
  }
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
    if (content === null) continue;
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
