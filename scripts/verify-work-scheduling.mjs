import {
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  forEachChild,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isDoStatement,
  isElementAccessExpression,
  isForStatement,
  isFunctionDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNumericLiteral,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStringLiteralLike,
  isVariableDeclaration,
  isWhileStatement,
  SyntaxKind,
} from "typescript";

const NATIVE_APIS = new Set([
  "MessageChannel",
  "requestAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "postTask",
  "queueMicrotask",
]);
const TIMER_APIS = new Set(["setTimeout", "setInterval"]);

// Only these boundary modules may initiate a native work handoff. Presentation
// frames and semantic timers use the scheduler's explicit ports elsewhere.
export const NATIVE_WORK_ADAPTERS = new Set([
  "src/obsidian/performance/window-work-scheduler.ts",
  "src/persistence/worker/runtime/worker-work-scheduler.ts",
]);

// A boundary file is not a blanket exemption. Each entry names the owning
// method and the number of native calls required by its injected host port.
const ADAPTER_NATIVE_SITES = new Map([
  ["src/obsidian/performance/window-work-scheduler.ts#openWindowTaskChannel#MessageChannel", 1],
  ["src/obsidian/performance/window-work-scheduler.ts#createWindowWorkScheduler#setTimeout", 1],
  [
    "src/obsidian/performance/window-work-scheduler.ts#createWindowWorkScheduler#requestAnimationFrame",
    1,
  ],
  [
    "src/persistence/worker/runtime/worker-work-scheduler.ts#createWorkerWorkScheduler#setTimeout",
    2,
  ],
  [
    "src/persistence/worker/runtime/worker-work-scheduler.ts#openWorkerTaskChannel#MessageChannel",
    1,
  ],
]);

// Semantic timers own gesture thresholds, animation exits, I/O deadlines, and
// event-turn cleanup. The exact method and call count prevent a new work loop
// from inheriting a whole-file exception.
const SEMANTIC_TIMER_SITES = new Map([
  ["src/obsidian/dialogs/inkbook-motion-modal.ts##animate", 1],
  ["src/obsidian/embeds/active-editor/controller-actions.ts##confirmClipboardAction", 1],
  ["src/obsidian/embeds/active-editor/input/long-press.ts#schedule", 1],
  ["src/obsidian/embeds/active-editor/navigation/navigation-activity.ts#settle", 1],
  ["src/obsidian/embeds/active-editor/input/tool-cursor-controller.ts##schedulePenRelease", 1],
  ["src/obsidian/embeds/active-scene/active-scene-handoff.ts##startUnlockTransition", 1],
  ["src/obsidian/embeds/active-scene/active-scene-timeout.ts#wait", 1],
  ["src/obsidian/embeds/active-scene/canvas-touch-boundary.ts##handlePointerTerminal", 1],
  ["src/obsidian/embeds/active-scene/editor-chrome-loader.ts##startLoad", 1],
  ["src/obsidian/embeds/live-preview/host-zoom-measure-throttle.ts##armTimer", 1],
  ["src/obsidian/embeds/presentation/presentation-operation-feedback.ts#begin", 1],
  ["src/obsidian/embeds/workspace/workspace-runtime-lifecycle.ts##armAutoActivationTimeout", 1],
  ["src/obsidian/embeds/workspace/workspace-runtime-workers.ts#createWorkspaceDocumentRuntimes", 1],
  ["src/obsidian/feedback/feedback-manager.ts##show", 2],
  ["src/obsidian/menus/adaptive-panel-height.ts#animate", 1],
  ["src/obsidian/menus/panels/adaptive-panel.ts#close", 1],
  ["src/obsidian/menus/panels/adaptive-panel.ts#onload", 1],
  ["src/obsidian/menus/owned-menu-factory.ts#close", 1],
  ["src/obsidian/menus/owned-menu-factory.ts#schedule", 1],
  ["src/obsidian/menus/panels/phone-sheet-swipe.ts##settle", 1],
  ["src/obsidian/menus/panels/phone-sheet-swipe.ts##suppressFollowingClick", 1],
  ["src/obsidian/settings/definitions/page-defaults.ts#animateBackgroundLayoutChange", 1],
  ["src/obsidian/settings/settings-panel-motion.ts##listenForCompletion", 1],
  ["src/persistence/saving/autosave/timer.ts#schedule", 1],
  ["src/persistence/worker/runtime/bridge/worker-host.ts#postHostedResult", 1],
  ["src/persistence/worker/runtime/bridge/request-timeout.ts#scheduleRequestTimeout", 1],
]);

// Refresh detection samples raw browser frames, outside the cooperative work queue.
const RAW_FRAME_SITES = new Map([["src/obsidian/performance/window-refresh-rate.ts##start", 1]]);

// Microtasks here settle host lifecycle or notification ordering. They do not
// resume incremental computation; that continuation belongs to WorkScheduler.
const HOST_MICROTASK_SITES = new Map([
  ["src/obsidian/embeds/active-editor/document-history.ts##armMarkdownMarkerSuppression", 1],
  ["src/obsidian/embeds/preview/document-recognition.ts#markLayoutReady", 1],
  ["src/obsidian/embeds/live-preview/live-preview-loading-widget.ts#toDOM", 1],
  ["src/obsidian/embeds/live-preview/live-preview.ts#subscribeRecognitions", 1],
  ["src/obsidian/menus/editor-toolbar-menu.ts##navigate", 1],
  ["src/obsidian/menus/editor-toolbar-menu.ts#afterMenuHandoff", 1],
]);

export function validateWorkScheduling(files, nativeAdapters = NATIVE_WORK_ADAPTERS) {
  const violations = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    if (!/^src\/.*\.tsx?$/u.test(path)) continue;
    const source = createSourceFile(
      path,
      file.content,
      ScriptTarget.Latest,
      true,
      scriptKind(path),
    );
    const aliases = collectNativeAliases(source);
    const allowedSites = new Map();
    forEachChild(source, function visit(node) {
      const native = nativeCall(node, aliases);
      const localBudget = privateBudget(node);
      if (
        (native !== undefined &&
          !allowedNativeSite(path, node, native, allowedSites, nativeAdapters)) ||
        localBudget
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(
          `${path}:${String(line + 1)}: ${native === undefined ? "local work deadline" : `native ${native}`} scheduling must use the shared work scheduler.`,
        );
      }
      forEachChild(node, visit);
    });
  }
  return violations;
}

function privateBudget(node) {
  if (isVariableDeclaration(node) && isIdentifier(node.name)) {
    return (
      (node.initializer !== undefined &&
        isPrivateBudgetName(node.name.text) &&
        containsNowCall(node.initializer)) ||
      (node.initializer !== undefined && containsNumericClockLimit(node.initializer))
    );
  }
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    const left = unwrap(node.left);
    const name = isIdentifier(left)
      ? left.text
      : isPropertyAccessExpression(left)
        ? left.name.text
        : undefined;
    return (
      (name !== undefined && isPrivateBudgetName(name) && containsNowCall(node.right)) ||
      containsNumericClockLimit(node.right)
    );
  }
  if (isWhileStatement(node) || isDoStatement(node) || isForStatement(node)) {
    return node.expression !== undefined && containsNumericClockLimit(node.expression);
  }
  return false;
}

function isPrivateBudgetName(name) {
  return /(?:deadline|cutoff|sliceStarted|workEnd|budgetEnd|workUntil)$/iu.test(name);
}

function containsNumericClockLimit(node) {
  if (isBinaryExpression(node)) {
    const arithmetic =
      node.operatorToken.kind === SyntaxKind.PlusToken ||
      node.operatorToken.kind === SyntaxKind.MinusToken;
    const comparison = [
      SyntaxKind.LessThanToken,
      SyntaxKind.LessThanEqualsToken,
      SyntaxKind.GreaterThanToken,
      SyntaxKind.GreaterThanEqualsToken,
    ].includes(node.operatorToken.kind);
    if (
      (arithmetic || comparison) &&
      ((containsNowCall(node.left) && isNumericLiteral(unwrap(node.right))) ||
        (containsNowCall(node.right) && isNumericLiteral(unwrap(node.left))))
    )
      return true;
  }
  let found = false;
  forEachChild(node, (child) => {
    if (!found && containsNumericClockLimit(child)) found = true;
  });
  return found;
}

function containsNowCall(node) {
  if (isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (isIdentifier(callee) && callee.text === "now") return true;
    if (isPropertyAccessExpression(callee) && callee.name.text === "now") return true;
  }
  let found = false;
  forEachChild(node, (child) => {
    if (!found && containsNowCall(child)) found = true;
  });
  return found;
}

function allowedNativeSite(path, node, api, seen, nativeAdapters) {
  const adapter = nativeAdapters.has(path);
  const sites = adapter
    ? ADAPTER_NATIVE_SITES
    : api === "setTimeout"
      ? SEMANTIC_TIMER_SITES
      : api === "requestAnimationFrame"
        ? RAW_FRAME_SITES
        : api === "queueMicrotask"
          ? HOST_MICROTASK_SITES
          : undefined;
  if (sites === undefined) return false;
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (
      !isMethodDeclaration(parent) &&
      !isPropertyDeclaration(parent) &&
      !isFunctionDeclaration(parent)
    )
      continue;
    if (parent.name === undefined) continue;
    const site = `${path}#${parent.name.getText()}${adapter ? `#${api}` : ""}`;
    const limit = sites.get(site);
    if (limit === undefined) return false;
    const count = (seen.get(site) ?? 0) + 1;
    seen.set(site, count);
    return count <= limit;
  }
  return false;
}

function scriptKind(path) {
  return path.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS;
}

function collectNativeAliases(source) {
  const aliases = new Map();
  forEachChild(source, function visit(node) {
    if (isVariableDeclaration(node)) collectVariableAlias(node, aliases);
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      const target = unwrap(node.left);
      if (isIdentifier(target)) {
        const api = nativeReference(node.right, aliases);
        if (api !== undefined) aliases.set(target.text, api);
      }
    }
    forEachChild(node, visit);
  });
  return aliases;
}

function collectVariableAlias(node, aliases) {
  if (node.initializer === undefined) return;
  if (isIdentifier(node.name)) {
    const api = nativeReference(node.initializer, aliases);
    if (api !== undefined) aliases.set(node.name.text, api);
    return;
  }
  if (!isObjectBindingPattern(node.name)) return;
  for (const element of node.name.elements) {
    if (!isBindingElement(element) || !isIdentifier(element.name)) continue;
    const key = element.propertyName ?? element.name;
    const api = propertyName(key);
    if (api !== undefined && (NATIVE_APIS.has(api) || TIMER_APIS.has(api))) {
      aliases.set(element.name.text, api);
    }
  }
}

function nativeCall(node, aliases) {
  if (!isCallExpression(node) && !isNewExpression(node)) return undefined;
  const expression = unwrap(node.expression);
  const forwarded = node.arguments
    ?.map((argument) => nativeReference(argument, aliases))
    .find(Boolean);
  const bindsNative = isPropertyAccessExpression(expression) && expression.name.text === "bind";
  const api = forwarded ?? (bindsNative ? undefined : nativeReference(expression, aliases));
  if (api === undefined) return undefined;
  if (NATIVE_APIS.has(api)) return api;
  if (TIMER_APIS.has(api)) return api;
  return undefined;
}

function nativeReference(expression, aliases) {
  const value = unwrap(expression);
  if (isIdentifier(value)) {
    if (NATIVE_APIS.has(value.text) || TIMER_APIS.has(value.text)) return value.text;
    return aliases.get(value.text);
  }
  if (isPropertyAccessExpression(value)) {
    if (["bind", "call", "apply"].includes(value.name.text)) {
      return nativeReference(value.expression, aliases);
    }
    const name = value.name.text;
    return NATIVE_APIS.has(name) || TIMER_APIS.has(name) ? name : undefined;
  }
  if (isElementAccessExpression(value)) {
    const name = propertyName(value.argumentExpression);
    return name !== undefined && (NATIVE_APIS.has(name) || TIMER_APIS.has(name)) ? name : undefined;
  }
  if (isCallExpression(value) && isPropertyAccessExpression(value.expression)) {
    if (value.expression.name.text === "bind") {
      return nativeReference(value.expression.expression, aliases);
    }
  }
  return undefined;
}

function propertyName(node) {
  if (isIdentifier(node) || isStringLiteralLike(node)) return node.text;
  return undefined;
}

function unwrap(expression) {
  let value = expression;
  while (isParenthesizedExpression(value)) value = value.expression;
  return value;
}
