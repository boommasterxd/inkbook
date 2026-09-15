import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import ts from "typescript";

const MAXIMUM_INPUTS = 10_000;
const MAXIMUM_MODULES = 500;

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

function moduleKey(path) {
  return path.replace(/\.(?:tsx?|[cm]?js|jsx)$/, "");
}

async function readInput(sourceRoot, key, metadata) {
  const path = resolve(sourceRoot, key);
  const sourceDirectory = resolve(sourceRoot, "src");
  if (!contained(sourceDirectory, path)) return { reason: `Non-source input: ${key}` };
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

/** Reuse one complete esbuild input graph; callers must first verify identical dependencies. */
export async function createKernelInputGraph({ sourceRoot, metafile }) {
  sourceRoot = await realpath(sourceRoot);
  const entries = Object.entries(metafile?.inputs ?? {});
  if (entries.length === 0 || entries.length > MAXIMUM_INPUTS) {
    throw new Error("Invalid comparison input graph size.");
  }
  const nodes = new Map();
  const modules = new Map();
  for (const [key, metadata] of entries) {
    if (!metadata || !Array.isArray(metadata.imports)) throw new Error("Missing import edges.");
    const node = await readInput(sourceRoot, key, metadata);
    nodes.set(key, node);
    if (node.local) {
      const identifier = moduleKey(node.local.slice("src/".length));
      if (modules.has(identifier)) modules.set(identifier, null);
      else modules.set(identifier, key);
    }
  }
  return {
    hashScenarioInputs: (identifiers) => hashInputs({ nodes, modules }, identifiers),
  };
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

function hashInputs(graph, identifiers) {
  if (
    !Array.isArray(identifiers) ||
    identifiers.length === 0 ||
    identifiers.length > MAXIMUM_MODULES
  ) {
    throw new Error("Invalid comparison module population.");
  }
  const pending = [];
  for (const identifier of [...new Set(identifiers)].sort()) {
    const entry = graph.modules.get(identifier);
    if (!entry) return { hash: null, inputs: [], reason: `Unresolved module: ${identifier}` };
    pending.push(entry);
  }
  return traverseInputs(graph.nodes, pending);
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
