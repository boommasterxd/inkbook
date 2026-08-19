const CSS_SENTINEL = ".inkbook-phase-zero-overlay";
const MAX_STYLE_SHEETS = 256;
const MAX_RULES_PER_SHEET = 4_096;

const MARKS = Object.freeze({
  disposalSettled: "inkbook.lifecycle.disposal-settled",
  moduleEvaluated: "inkbook.lifecycle.module-evaluated",
  onloadEntered: "inkbook.lifecycle.onload-entered",
  onloadSettled: "inkbook.lifecycle.onload-settled",
  onunloadEntered: "inkbook.lifecycle.onunload-entered",
  workerProbeSettled: "inkbook.lifecycle.worker-probe-settled",
});

export class ObsidianRuntimeHostError extends Error {
  constructor(message) {
    super(message);
    this.name = "ObsidianRuntimeHostError";
  }
}

function fail(message) {
  throw new ObsidianRuntimeHostError(message);
}

function literal(value) {
  return JSON.stringify(value);
}

function preflightSource() {
  return `
    if (!manager.enabledPlugins.has(expected.pluginId)) throw new Error("plugin-not-enabled");
    const ready = readReady();
    if (cssOwnerCount() !== 1) throw new Error("css-owner-count-invalid");
    return { action, ready: { ...ready, cssOwnerCount: 1 } };
  `;
}

function disableSource() {
  return `
    if (!manager.enabledPlugins.has(expected.pluginId)) throw new Error("plugin-not-enabled");
    const ready = readReady();
    if (ready.moduleEvaluatedAt !== expected.previousModuleEvaluatedAt) {
      throw new Error("unexpected-current-module-mark");
    }
    await manager.disablePlugin(expected.pluginId);
    const onunloadEnteredAt = await waitForUniqueMark(names.onunloadEntered, ready.onloadSettledAt);
    const disposalEntry = await waitForUniqueEntry(names.disposalSettled, onunloadEnteredAt);
    const disposalSettledAt = disposalEntry.startTime;
    const coordinator = disposalEntry.detail?.resourceCoordinator;
    if (coordinator?.balanced !== true || coordinator?.disposed !== true) {
      throw new Error("resource-coordinator-disposal-invalid");
    }
    if (cssOwnerCount() !== 0) throw new Error("css-not-unloaded");
    return { action, disabled: { cssOwnerCount: 0, disposalSettledAt, onunloadEnteredAt,
      resourceCoordinatorBalanced: true, resourceCoordinatorDisposed: true } };
  `;
}

function environmentProbeSource() {
  return `
    if (!manager.enabledPlugins.has(expected.pluginId)) throw new Error("plugin-not-enabled");
    root.performance.clearMarks(names.workerProbeSettled);
    const commandStartedAt = root.performance.now();
    if (commands.executeCommandById(expected.environmentProbeCommandId) !== true) {
      throw new Error("environment-probe-command-unavailable");
    }
    const entry = await waitForUniqueEntry(names.workerProbeSettled, commandStartedAt);
    const detail = entry.detail;
    if (detail?.workerLaunched !== true || detail?.workerResultPassed !== true ||
        detail?.recoveryPassed !== true || detail?.workerResourcesReleased !== true) {
      throw new Error("environment-probe-assertion-failed");
    }
    return { action, environment: { workerLaunched: true, workerResultPassed: true,
      recoveryPassed: true, workerResourcesReleased: true } };
  `;
}

function enableSource() {
  return `
    if (manager.enabledPlugins.has(expected.pluginId)) throw new Error("plugin-already-enabled");
    const enableStartedAt = root.performance.now();
    await manager.enablePlugin(expected.pluginId);
    await waitForUniqueMark(names.onloadSettled, enableStartedAt);
    const ready = readReady();
    if (ready.moduleEvaluatedAt < enableStartedAt ||
        ready.moduleEvaluatedAt <= expected.previousModuleEvaluatedAt ||
        ready.moduleEvaluatedAt > ready.onloadEnteredAt) {
      throw new Error("module-mark-not-fresh");
    }
    if (cssOwnerCount() !== 1) throw new Error("css-not-reloaded-exactly-once");
    return { action, enableStartedAt, ready: { ...ready, cssOwnerCount: 1 } };
  `;
}

function ensureEnabledSource() {
  return `
    if (!manager.enabledPlugins.has(expected.pluginId)) {
      await manager.enablePlugin(expected.pluginId);
    }
    await waitForUniqueMark(names.onloadSettled, 0);
    const ready = readReady();
    if (cssOwnerCount() !== 1) throw new Error("cleanup-css-owner-count-invalid");
    return { action, ready: { ...ready, cssOwnerCount: 1 } };
  `;
}

function actionSource(action) {
  if (action === "preflight") return preflightSource();
  if (action === "run-environment-probe") return environmentProbeSource();
  if (action === "disable-current") return disableSource();
  if (action === "enable-next") return enableSource();
  return ensureEnabledSource();
}

export function buildObsidianHostExpression(action, expected) {
  return `(async () => {
    "use strict";
    const action = ${literal(action)};
    const expected = ${literal({
      ...expected,
      previousModuleEvaluatedAt: expected.previousModuleEvaluatedAt ?? null,
    })};
    const names = ${literal(MARKS)};
    const root = globalThis;
    const manager = root.app?.plugins;
    const commands = root.app?.commands;
    if (!manager || typeof manager.disablePlugin !== "function" ||
        typeof manager.enablePlugin !== "function" ||
        !(manager.enabledPlugins instanceof Set) || !commands ||
        typeof commands.executeCommandById !== "function" || !root.performance ||
        typeof root.PerformanceObserver !== "function") {
      throw new Error("unsupported-private-host-or-performance-api");
    }
    const readUniqueMark = (name) => {
      const entries = root.performance.getEntriesByName(name, "mark");
      if (entries.length !== 1 || !Number.isFinite(entries[0].startTime)) {
        throw new Error("missing-or-ambiguous-performance-mark");
      }
      return entries[0].startTime;
    };
    const waitForUniqueEntry = async (name, lowerBound) => {
      const current = root.performance.getEntriesByName(name, "mark");
      if (current.length === 1) {
        if (current[0].startTime < lowerBound) throw new Error("stale-performance-mark");
        return current[0];
      }
      if (current.length > 1) throw new Error("ambiguous-performance-mark");
      return new Promise((resolve, reject) => {
        const observer = new root.PerformanceObserver(() => {
          const entries = root.performance.getEntriesByName(name, "mark");
          if (entries.length !== 1 || entries[0].startTime < lowerBound) return;
          root.clearTimeout(timeout);
          observer.disconnect();
          resolve(entries[0]);
        });
        const timeout = root.setTimeout(() => {
          observer.disconnect();
          reject(new Error("performance-mark-timeout"));
        }, expected.markTimeoutMs);
        observer.observe({ entryTypes: ["mark"] });
      });
    };
    const waitForUniqueMark = async (name, lowerBound) =>
      (await waitForUniqueEntry(name, lowerBound)).startTime;
    const cssOwnerCount = () => {
      if (root.document.styleSheets.length > ${String(MAX_STYLE_SHEETS)}) {
        throw new Error("stylesheet-limit-exceeded");
      }
      let owners = 0;
      for (const sheet of root.document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        if (rules.length > ${String(MAX_RULES_PER_SHEET)}) throw new Error("css-rule-limit-exceeded");
        for (const rule of rules) {
          if (typeof rule.selectorText === "string" && rule.selectorText.includes(${literal(CSS_SENTINEL)})) {
            owners += 1;
            break;
          }
        }
      }
      return owners;
    };
    const readReady = () => {
      const moduleEvaluatedAt = readUniqueMark(names.moduleEvaluated);
      const onloadEnteredAt = readUniqueMark(names.onloadEntered);
      const onloadSettledAt = readUniqueMark(names.onloadSettled);
      if (moduleEvaluatedAt > onloadEnteredAt || onloadEnteredAt > onloadSettledAt) {
        throw new Error("startup-mark-order-invalid");
      }
      return { moduleEvaluatedAt, onloadEnteredAt, onloadSettledAt };
    };
    ${actionSource(action)}
  })()`;
}

function assertReady(value) {
  if (
    !value ||
    !Number.isFinite(value.moduleEvaluatedAt) ||
    !Number.isFinite(value.onloadEnteredAt) ||
    !Number.isFinite(value.onloadSettledAt) ||
    value.moduleEvaluatedAt < 0 ||
    value.moduleEvaluatedAt > value.onloadEnteredAt ||
    value.onloadEnteredAt > value.onloadSettledAt ||
    value.cssOwnerCount !== 1
  ) {
    fail("Obsidian returned malformed startup marks or CSS ownership");
  }
  return value;
}

function assertDisabled(value) {
  if (
    !value ||
    !Number.isFinite(value.onunloadEnteredAt) ||
    !Number.isFinite(value.disposalSettledAt) ||
    value.onunloadEnteredAt < 0 ||
    value.disposalSettledAt < value.onunloadEnteredAt ||
    value.cssOwnerCount !== 0 ||
    value.resourceCoordinatorBalanced !== true ||
    value.resourceCoordinatorDisposed !== true
  ) {
    fail("Obsidian returned malformed disposal marks or retained CSS");
  }
  return value;
}

function assertEnvironment(value) {
  if (
    !value ||
    value.workerLaunched !== true ||
    value.workerResultPassed !== true ||
    value.recoveryPassed !== true ||
    value.workerResourcesReleased !== true
  ) {
    fail("Obsidian returned failed worker or recovery probe evidence");
  }
  return value;
}

function valueFromEvaluation(response) {
  if (response?.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description;
    fail(
      `Obsidian host expression failed: ${description ?? "unknown exception"}`,
    );
  }
  if (response?.result?.type !== "object" || !("value" in response.result)) {
    fail("Obsidian host expression returned no bounded value");
  }
  return response.result.value;
}

function validateHeapUsage(response) {
  for (const key of ["usedSize", "totalSize"]) {
    if (!Number.isFinite(response?.[key]) || response[key] < 0) {
      fail(`Runtime.getHeapUsage returned invalid ${key}`);
    }
  }
  return { totalSize: response.totalSize, usedSize: response.usedSize };
}

export class ObsidianRuntimeHost {
  #session;
  #expected;

  constructor(session, expected) {
    if (
      expected.pluginId !== "inkbook" ||
      expected.environmentProbeCommandId !==
        "inkbook:phase-zero-run-environment-probe" ||
      !Number.isInteger(expected.markTimeoutMs) ||
      expected.markTimeoutMs < 1_000 ||
      expected.markTimeoutMs > 30_000
    ) {
      fail("Runtime host requires the bounded Inkbook measurement contract");
    }
    this.#session = session;
    this.#expected = Object.freeze({ ...expected });
  }

  async initialize() {
    await this.#session.send("Runtime.enable");
    return assertReady((await this.#evaluate("preflight")).ready);
  }

  async runEnvironmentProbe() {
    return assertEnvironment(
      (await this.#evaluate("run-environment-probe")).environment,
    );
  }

  async disableCurrent(previousModuleEvaluatedAt) {
    const result = await this.#evaluate(
      "disable-current",
      previousModuleEvaluatedAt,
    );
    return assertDisabled(result.disabled);
  }

  async enableNext(previousModuleEvaluatedAt) {
    const result = await this.#evaluate(
      "enable-next",
      previousModuleEvaluatedAt,
    );
    const ready = assertReady(result.ready);
    if (
      !Number.isFinite(result.enableStartedAt) ||
      result.enableStartedAt < 0
    ) {
      fail("Obsidian returned an invalid enable-start mark");
    }
    return { enableStartedAt: result.enableStartedAt, ready };
  }

  async heapUsage() {
    return validateHeapUsage(await this.#session.send("Runtime.getHeapUsage"));
  }

  async collectGarbage() {
    await this.#session.send("HeapProfiler.collectGarbage");
  }

  async ensureEnabled() {
    return assertReady((await this.#evaluate("ensure-enabled")).ready);
  }

  async #evaluate(action, previousModuleEvaluatedAt) {
    const expression = buildObsidianHostExpression(action, {
      ...this.#expected,
      previousModuleEvaluatedAt,
    });
    const response = await this.#session.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
      silent: true,
      userGesture: false,
    });
    return valueFromEvaluation(response);
  }
}
