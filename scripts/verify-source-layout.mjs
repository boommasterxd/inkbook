import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  forEachChild,
  isBlock,
  isCallExpression,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLike,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isPropertyAccessExpression,
  isStringLiteralLike,
  isSwitchStatement,
  isTaggedTemplateExpression,
  isVariableDeclaration,
} from "typescript";
import { validateWorkScheduling } from "./verify-work-scheduling.mjs";

const SOURCE_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:ts|tsx)$/;
const TEST_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.test\.(?:mjs|ts|tsx)$/;
const TEST_APIS = new Set(["bench", "describe", "it", "suite", "test"]);
const TEST_MODULES = new Set(["node:test", "vitest"]);
const MAXIMUM_CSS_LINES = 500;

export function validateSourceLayout(files) {
  const violations = [];
  for (const file of files) {
    const normalizedPath = file.path.split(path.sep).join("/");
    const name = path.posix.basename(normalizedPath);
    if (normalizedPath.startsWith("src/") && /\.tsx?$/u.test(name)) {
      if (!SOURCE_FILE_PATTERN.test(name)) {
        violations.push(`${normalizedPath}: TypeScript source files must use kebab-case.`);
      }
      if (normalizedPath.startsWith("src/rendering/scene/") && name.endsWith(".tsx")) {
        violations.push(`${normalizedPath}: the imperative scene must not contain TSX files.`);
      }
    }
    if (
      normalizedPath.startsWith("test/") &&
      (containsExecutableTest(file.content, normalizedPath) ||
        /\.spec\.(?:mjs|ts|tsx)$/u.test(name))
    ) {
      if (!TEST_FILE_PATTERN.test(name)) {
        violations.push(`${normalizedPath}: executable tests must use the *.test.* suffix.`);
      }
    }
    if (normalizedPath.startsWith("src/") && name.endsWith(".css")) {
      const lines = physicalLineCount(file.content);
      if (lines > MAXIMUM_CSS_LINES) {
        violations.push(`${normalizedPath}: CSS files must not exceed 500 lines (found ${lines}).`);
      }
    }
  }
  violations.push(...validateWorkScheduling(files));
  return violations;
}

export async function verifyRepositoryLayout(rootDirectory) {
  const files = await collectFiles(rootDirectory, ["src", "test"]);
  return validateSourceLayout(files);
}

async function collectFiles(rootDirectory, directories) {
  const files = [];
  for (const directory of directories) {
    await visit(path.join(rootDirectory, directory), rootDirectory, files);
  }
  return files;
}

async function visit(directory, rootDirectory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(absolutePath, rootDirectory, files);
    } else if (/\.(?:css|mjs|ts|tsx)$/u.test(entry.name)) {
      files.push({
        content: await readFile(absolutePath, "utf8"),
        path: path.relative(rootDirectory, absolutePath),
      });
    }
  }
}

function physicalLineCount(content) {
  if (content.length === 0) return 0;
  const lineBreaks = content.match(/\n/gu)?.length ?? 0;
  return lineBreaks + (content.endsWith("\n") ? 0 : 1);
}

function containsExecutableTest(content, filePath) {
  const sourceFile = createSourceFile(
    filePath,
    content,
    ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  );
  const analysis = collectScopedCalls(sourceFile);
  return (
    analysis.hasTestModule &&
    analysis.calls.some(({ expression, scope }) => isTestCall(expression, scope))
  );
}

function collectScopedCalls(sourceFile) {
  const rootScope = createScope();
  const calls = [];
  let hasTestModule = false;

  const visit = (node, scope) => {
    if (isImportDeclaration(node)) {
      const importsTestModule = registerImportBindings(node, scope);
      hasTestModule ||= importsTestModule;
      return;
    }

    if (isFunctionDeclaration(node) && node.name !== undefined) {
      addBindingName(node.name, scope, "local");
    } else if (isClassDeclaration(node) && node.name !== undefined) {
      addBindingName(node.name, scope, "local");
    }

    let activeScope = scope;
    if (createsLexicalScope(node)) {
      activeScope = createScope(scope);
    }

    if ((isFunctionExpression(node) || isClassExpression(node)) && node.name !== undefined) {
      addBindingName(node.name, activeScope, "local");
    }
    if (isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        addBindingName(parameter.name, activeScope, "local");
      }
    }
    if (isVariableDeclaration(node)) {
      addBindingName(node.name, activeScope, "local");
    }
    if (isCallExpression(node)) {
      calls.push({ expression: node.expression, scope: activeScope });
    }

    forEachChild(node, (child) => visit(child, activeScope));
  };

  forEachChild(sourceFile, (node) => visit(node, rootScope));
  return { calls, hasTestModule };
}

function createScope(parent) {
  return { bindings: new Map(), parent };
}

function createsLexicalScope(node) {
  return (
    isFunctionLike(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node) ||
    isBlock(node) ||
    isCatchClause(node) ||
    isForStatement(node) ||
    isForInStatement(node) ||
    isForOfStatement(node) ||
    isSwitchStatement(node)
  );
}

function registerImportBindings(node, scope) {
  if (!isStringLiteralLike(node.moduleSpecifier)) return false;
  const isTestModule = TEST_MODULES.has(node.moduleSpecifier.text);
  const clause = node.importClause;
  if (clause?.name !== undefined) {
    const kind =
      isTestModule && node.moduleSpecifier.text === "node:test"
        ? "direct-test"
        : isTestModule
          ? "namespace-test"
          : "local";
    addBindingName(clause.name, scope, kind);
  }
  if (clause?.namedBindings === undefined) return isTestModule;
  if (isNamespaceImport(clause.namedBindings)) {
    addBindingName(clause.namedBindings.name, scope, isTestModule ? "namespace-test" : "local");
  } else if (isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      addBindingName(
        element.name,
        scope,
        isTestModule && TEST_APIS.has(importedName) ? "direct-test" : "local",
      );
    }
  }
  return isTestModule;
}

function addBindingName(name, scope, kind) {
  if (isIdentifier(name)) {
    scope.bindings.set(name.text, kind);
    return;
  }
  for (const element of name.elements) {
    if (element.name !== undefined) addBindingName(element.name, scope, kind);
  }
}

function isTestCall(expression, scope) {
  const names = expressionNames(expression);
  const root = names[0];
  if (root === undefined) return false;
  const binding = resolveBinding(scope, root);
  if (binding === "direct-test") return true;
  if (binding === "namespace-test") return names.some((name) => TEST_APIS.has(name));
  return binding === undefined && TEST_APIS.has(root);
}

function resolveBinding(scope, name) {
  for (let current = scope; current !== undefined; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

function expressionNames(expression) {
  if (isIdentifier(expression)) return [expression.text];
  if (isPropertyAccessExpression(expression)) {
    const receiver = expressionNames(expression.expression);
    return receiver.length ? [...receiver, expression.name.text] : [];
  }
  if (isElementAccessExpression(expression) && isStringLiteralLike(expression.argumentExpression)) {
    const receiver = expressionNames(expression.expression);
    return receiver.length ? [...receiver, expression.argumentExpression.text] : [];
  }
  if (isCallExpression(expression)) return expressionNames(expression.expression);
  if (isTaggedTemplateExpression(expression)) return expressionNames(expression.tag);
  return [];
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const rootDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const violations = await verifyRepositoryLayout(rootDirectory);
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
}
