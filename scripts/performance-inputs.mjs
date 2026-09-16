import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import ts from "typescript";
import { build } from "esbuild";

const MAXIMUM_INPUTS = 10_000;
// Unknown runner configuration prevents selective skipping, rather than guessing aliases.
const SUPPORTED_CONFIG_SHA256 = "49eff02c0f4da333cb1e8ec222c020596d9ae4478e9621e0f623c42436ba022e";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contained(root, path) {
  const local = relative(root, path);
  return local !== "" && !local.startsWith("../") && local !== ".." && !isAbsolute(local);
}

function opaqueLoading(path, contents) {
  const tree = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
  let opaque = tree.parseDiagnostics.length > 0;
  function visit(node) {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) opaque = true;
    if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text)) opaque = true;
    if (ts.isIdentifier(node) && node.text === "require" && !staticRequire(node)) opaque = true;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) opaque = true;
      if (ts.isIdentifier(callee) && callee.text === "eval") opaque = true;
      if (
        ts.isIdentifier(callee) &&
        callee.text === "require" &&
        (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
      )
        opaque = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return opaque;
}

function staticRequire(node) {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.expression === node &&
    parent.arguments.length === 1 &&
    ts.isStringLiteral(parent.arguments[0])
  );
}

async function readInput(sourceRoot, key, metadata) {
  const path = resolve(sourceRoot, key);
  if (!contained(sourceRoot, path)) return { reason: `External workspace input: ${key}` };
  try {
    if ((await realpath(path)) !== path) return { reason: `Symlinked input: ${key}` };
    const contents = await readFile(path);
    const local = relative(sourceRoot, path).replaceAll("\\", "/");
    return {
      path,
      local,
      hash: digest(contents),
      imports: metadata.imports,
      reason: opaqueLoading(path, contents.toString("utf8"))
        ? `Opaque source loading: ${local}`
        : undefined,
    };
  } catch {
    return { reason: `Unreadable input: ${key}` };
  }
}

function validateFiles(testFiles) {
  if (!Array.isArray(testFiles) || testFiles.length === 0 || testFiles.length > 100)
    throw new Error("Invalid performance file population.");
  if (
    new Set(testFiles).size !== testFiles.length ||
    testFiles.some(
      (file) =>
        typeof file !== "string" ||
        !/^test\/performance\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.ts$/.test(file),
    )
  )
    throw new Error("Invalid or duplicate performance test path.");
}

async function inputGraph(root, testFiles) {
  root = await realpath(root);
  const config = await readFile(resolve(root, "vitest.config.ts"));
  if (digest(config) !== SUPPORTED_CONFIG_SHA256)
    return { reason: "Runner configuration requires renewed input-graph review." };
  let metafile;
  try {
    ({ metafile } = await build({
      absWorkingDir: root,
      entryPoints: testFiles,
      bundle: true,
      write: false,
      outdir: "graph-only",
      metafile: true,
      packages: "external",
      // Keep value-form imports used only as types in this conservative graph.
      // Otherwise esbuild records their erased edges as unresolved externals.
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      platform: "node",
      target: "node26",
      logLevel: "silent",
      alias: { obsidian: resolve(root, "test/adapters/obsidian/plugin.ts") },
    }));
  } catch {
    return { reason: "Test input graph could not be resolved completely." };
  }
  const entries = Object.entries(metafile.inputs);
  if (entries.length === 0 || entries.length > MAXIMUM_INPUTS)
    throw new Error("Invalid comparison input graph size.");
  const nodes = new Map();
  for (const [key, metadata] of entries) {
    if (!metadata || !Array.isArray(metadata.imports)) throw new Error("Missing import edges.");
    nodes.set(key, await readInput(root, key, metadata));
  }
  return { nodes };
}

function fileInputs(graph, file) {
  if (graph.reason) return { hash: null, inputs: [], reason: graph.reason };
  if (!graph.nodes.has(file)) return { hash: null, inputs: [], reason: `Missing entry: ${file}` };
  return traverseInputs(graph.nodes, [file]);
}

/** Select whole original tests; callers must first verify identical harnesses and dependencies. */
export async function planPerformanceInputs({ referenceRoot, candidateRoot, testFiles }) {
  validateFiles(testFiles);
  const referenceGraph = await inputGraph(referenceRoot, testFiles);
  const candidateGraph = await inputGraph(candidateRoot, testFiles);
  const pending = [];
  const identicalInputs = [];
  const inputs = [];
  for (const file of testFiles) {
    const reference = fileInputs(referenceGraph, file);
    const candidate = fileInputs(candidateGraph, file);
    inputs.push({ file, reference, candidate });
    if (reference.hash !== null && reference.hash === candidate.hash)
      identicalInputs.push({ file, inputHash: reference.hash, inputs: reference.inputs });
    else pending.push(file);
  }
  return { pending, identicalInputs, inputs };
}

function importTarget(edge, nodes) {
  if (!edge || typeof edge.path !== "string" || !edge.path) {
    return { reason: "Malformed import edge." };
  }
  if (edge.kind === "dynamic-import") return { reason: `Dynamic import: ${edge.path}` };
  if (!edge.external) {
    return nodes.has(edge.path)
      ? { target: edge.path }
      : { reason: `Unresolved import: ${edge.path}` };
  }
  if (
    ["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(edge.path) ||
    isAbsolute(edge.path) ||
    edge.path.startsWith(".") ||
    edge.path.includes("\\") ||
    edge.path.startsWith("#") ||
    (edge.path.includes(":") && !edge.path.startsWith("node:"))
  ) {
    return { reason: `External source graph unavailable: ${edge.path}` };
  }
  return { external: edge.path };
}

function traverseInputs(nodes, pending) {
  const visited = new Set();
  const records = [];
  while (pending.length > 0) {
    const key = pending.pop();
    if (visited.has(key)) continue;
    visited.add(key);
    const node = nodes.get(key);
    if (node.reason) return { hash: null, inputs: [], reason: node.reason };
    const edges = [];
    for (const edge of node.imports) {
      const result = importTarget(edge, nodes);
      if (result.reason) return { hash: null, inputs: [], reason: result.reason };
      if (result.target) {
        pending.push(result.target);
        edges.push([edge.kind, nodes.get(result.target).local ?? result.target]);
      } else edges.push([edge.kind, result.external]);
    }
    records.push([node.local, node.hash, edges.sort()]);
  }
  records.sort(([left], [right]) => left.localeCompare(right));
  return { hash: digest(JSON.stringify(records)), inputs: records.map(([path]) => path) };
}
