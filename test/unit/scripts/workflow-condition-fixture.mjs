import ts from "typescript";

function property(object, key) {
  if (
    object === null ||
    typeof object !== "object" ||
    typeof key !== "string" ||
    ["__proto__", "constructor", "prototype"].includes(key) ||
    !Object.hasOwn(object, key)
  ) {
    throw new Error("Unsupported workflow context property.");
  }
  return object[key];
}

function binary(node, context, depth) {
  const left = evaluate(node.left, context, depth + 1);
  const right = evaluate(node.right, context, depth + 1);
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.EqualsEqualsToken) {
    if (!["string", "boolean"].includes(typeof left) || typeof left !== typeof right) {
      throw new Error("Workflow comparisons require matching string or boolean operands.");
    }
    return left === right;
  }
  if (typeof left !== "boolean" || typeof right !== "boolean") {
    throw new Error("Workflow logical operands must be boolean.");
  }
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return left && right;
  if (operator === ts.SyntaxKind.BarBarToken) return left || right;
  throw new Error("Unsupported workflow condition operator.");
}

function evaluate(node, context, depth = 0) {
  if (depth > 32) throw new Error("Workflow condition nesting exceeds the fixture limit.");
  if (ts.isStringLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node)) return property(context, node.text);
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, context, depth + 1);
  if (ts.isBinaryExpression(node)) return binary(node, context, depth);
  if (ts.isPropertyAccessExpression(node)) {
    return property(evaluate(node.expression, context, depth + 1), node.name.text);
  }
  if (ts.isElementAccessExpression(node)) {
    return property(
      evaluate(node.expression, context, depth + 1),
      evaluate(node.argumentExpression, context, depth + 1),
    );
  }
  throw new Error("Unsupported workflow condition syntax.");
}

// This fixture interprets only the boolean/string subset used by the tested policies.
export function workflowCondition(expression, context) {
  if (typeof expression !== "string" || expression.length > 4096) {
    throw new Error("Invalid workflow condition size.");
  }
  const source = ts.createSourceFile(
    "workflow-condition.js",
    expression,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const statement = source.statements[0];
  if (
    source.parseDiagnostics.length ||
    source.statements.length !== 1 ||
    !ts.isExpressionStatement(statement)
  ) {
    throw new Error("Expected one workflow condition expression.");
  }
  const result = evaluate(statement.expression, context);
  if (typeof result !== "boolean") throw new Error("Workflow condition must return a boolean.");
  return result;
}
