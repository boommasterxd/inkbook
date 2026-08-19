import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./artifact-budget.mjs";
import { stableJson, validateJsonSchema } from "./schema-validation.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PROFILE_SCHEMA_PATH = path.join(
  REPOSITORY_ROOT,
  "config/performance-profile.v1.schema.json",
);
const PROFILE_SCHEMA = JSON.parse(readFileSync(PROFILE_SCHEMA_PATH, "utf8"));

export class PerformanceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PerformanceValidationError";
  }
}

export function fail(message) {
  throw new PerformanceValidationError(message);
}

export const PHASE_ZERO_CELLS = Object.freeze({
  "P0-SAMSUNG-GALAXY-BOOK-5": {
    platform: "desktop",
    budgetClass: "desktopTablet",
  },
  "P0-SAMSUNG-GALAXY-TAB-S6": {
    platform: "android",
    budgetClass: "desktopTablet",
  },
});

export const PHASE_ZERO_CELL_IDS = Object.freeze(Object.keys(PHASE_ZERO_CELLS));

export const PHASE_ZERO_ROW_DEFINITIONS = Object.freeze([
  {
    id: "P0-ARTIFACT-MAIN-RAW",
    kind: "deterministic",
    metric: "artifact.mainJs.rawBytes",
    unit: "bytes",
  },
  {
    id: "P0-ARTIFACT-MAIN-GZIP",
    kind: "deterministic",
    metric: "artifact.mainJs.gzipBytes",
    unit: "bytes",
  },
  {
    id: "P0-ARTIFACT-WORKER-RAW",
    kind: "deterministic",
    metric: "artifact.embeddedWorker.rawBytes",
    unit: "bytes",
  },
  {
    id: "P0-ARTIFACT-STYLES-RAW",
    kind: "deterministic",
    metric: "artifact.stylesCss.rawBytes",
    unit: "bytes",
  },
  {
    id: "P0-ARTIFACT-STYLES-GZIP",
    kind: "deterministic",
    metric: "artifact.stylesCss.gzipBytes",
    unit: "bytes",
  },
  {
    id: "P0-COLD-MODULE-EVAL-P95",
    kind: "runtime",
    metric: "runtime.moduleCssTopLevelEvaluation.p95",
    unit: "ms",
  },
  {
    id: "P0-COLD-ONLOAD-P95",
    kind: "runtime",
    metric: "runtime.preOnloadSettled.p95",
    unit: "ms",
  },
  {
    id: "P0-COLD-PEAK-HEAP",
    kind: "runtime",
    metric: "runtime.peakAdditionalHeap.maximum",
    unit: "MiB",
  },
  {
    id: "P0-WORKER-RESIDENT-OWNERSHIP",
    kind: "assertion",
    metric: "lifecycle.workerResidentOwnership",
    unit: "boolean",
  },
  {
    id: "P0-ZERO-BALANCE-DISPOSAL",
    kind: "assertion",
    metric: "lifecycle.zeroBalanceDisposal",
    unit: "boolean",
  },
]);

const FIXTURE_PAYLOADS = Object.freeze({
  "phase-zero-package-fixture-v1": "inkbook-phase-zero-package-fixture-v1\n",
});

const ROW_BUDGETS = Object.freeze({
  "P0-ARTIFACT-MAIN-RAW": ["limits", "mainRawBytes", "max"],
  "P0-ARTIFACT-MAIN-GZIP": ["limits", "mainGzipBytes", "max"],
  "P0-ARTIFACT-WORKER-RAW": ["limits", "embeddedWorkerRawBytes", "max"],
  "P0-ARTIFACT-STYLES-RAW": ["limits", "stylesRawBytes", "max"],
  "P0-ARTIFACT-STYLES-GZIP": ["limits", "stylesGzipBytes", "max"],
  "P0-COLD-MODULE-EVAL-P95": [
    "runtime",
    "moduleCssTopLevelEvaluationP95Ms",
    "p95Max",
  ],
  "P0-COLD-ONLOAD-P95": ["runtime", "preOnloadSettledP95Ms", "p95Max"],
  "P0-COLD-PEAK-HEAP": ["runtime", "peakAdditionalHeapMiB", "max"],
});

export function artifactBinding(measurement) {
  return {
    mainJsSha256: measurement.mainJsSha256,
    mainJsBytes: measurement.mainJsBytes,
    mainJsGzipBytes: measurement.mainJsGzipBytes,
    embeddedWorkerSha256: measurement.embeddedWorkerSha256,
    embeddedWorkerBytes: measurement.embeddedWorkerBytes,
    stylesCssSha256: measurement.stylesCssSha256,
    stylesCssBytes: measurement.stylesCssBytes,
    stylesCssGzipBytes: measurement.stylesCssGzipBytes,
    packageChecksums: measurement.packageChecksums,
  };
}

function validateSchema(document, schema) {
  try {
    validateJsonSchema(document, schema);
  } catch (error) {
    fail(`Schema validation failed: ${error.message}`);
  }
}

function validateIdentity(profile, expectedCommit) {
  if (
    profile.schema !== "PerformanceProfileV1" ||
    profile.version !== 1 ||
    profile.phase !== "P0"
  ) {
    fail("Profile identity is not PerformanceProfileV1/P0");
  }
  if (!["draft", "final"].includes(profile.status))
    fail("Profile status must be draft or final");
  if (profile.artifactBudget !== "ARTIFACT_BUDGET_V1")
    fail("Profile is not bound to ARTIFACT_BUDGET_V1");
  if (expectedCommit && profile.commit !== expectedCommit) {
    fail(`Profile commit ${profile.commit} does not match ${expectedCommit}`);
  }
  if (profile.procedure.warmups < 5 || profile.procedure.samples < 100) {
    fail("Profile procedure must use at least five warmups and 100 samples");
  }
}

function validateFixtures(profile) {
  if (profile.fixtures.length !== Object.keys(FIXTURE_PAYLOADS).length)
    fail("Profile fixture set is incomplete");
  for (const fixture of profile.fixtures) {
    const payload = FIXTURE_PAYLOADS[fixture.generator];
    if (!payload) fail(`Unknown fixture generator ${fixture.generator}`);
    if (fixture.digest !== sha256(Buffer.from(payload, "utf8"))) {
      fail(`Fixture ${fixture.id} digest is stale or mutated`);
    }
  }
}

function validateCells(profile) {
  const actualIds = profile.cells.map((cell) => cell.id).sort();
  if (stableJson(actualIds) !== stableJson([...PHASE_ZERO_CELL_IDS].sort())) {
    fail("Profile must define exactly the two known Phase-0 device cells");
  }
  const seen = new Set();
  for (const cell of profile.cells) {
    if (seen.has(cell.id)) fail(`Duplicate profile cell ${cell.id}`);
    seen.add(cell.id);
    const expected = PHASE_ZERO_CELLS[cell.id];
    if (
      cell.platform !== expected.platform ||
      cell.budgetClass !== expected.budgetClass
    ) {
      fail(
        `Profile cell ${cell.id} has an unexpected platform or budget class`,
      );
    }
  }
}

function exactKeys(actual, expected, label) {
  if (
    stableJson(Object.keys(actual).sort()) !== stableJson([...expected].sort())
  ) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function budgetValue(budget, rowId, cellId) {
  const rowBudget = ROW_BUDGETS[rowId];
  if (!rowBudget) return true;
  const [group, key] = rowBudget;
  const configured = budget[group][key];
  return group === "limits"
    ? configured
    : configured[PHASE_ZERO_CELLS[cellId].budgetClass];
}

function validateRows(profile, budget) {
  const expectedIds = PHASE_ZERO_ROW_DEFINITIONS.map((row) => row.id);
  exactKeys(
    Object.fromEntries(profile.rows.map((row) => [row.id, true])),
    expectedIds,
    "Profile rows",
  );
  const rows = new Map(profile.rows.map((row) => [row.id, row]));
  for (const definition of PHASE_ZERO_ROW_DEFINITIONS) {
    const row = rows.get(definition.id);
    if (
      row.kind !== definition.kind ||
      row.metric !== definition.metric ||
      row.unit !== definition.unit
    ) {
      fail(`Profile row ${definition.id} has an unexpected definition`);
    }
    const expectedWarmups = row.kind === "runtime" ? 5 : 0;
    const expectedSamples = row.kind === "runtime" ? 100 : 1;
    if (row.warmups !== expectedWarmups || row.samples !== expectedSamples) {
      fail(`Profile row ${definition.id} has unstable warmup/sample settings`);
    }
    exactKeys(
      row.thresholds,
      PHASE_ZERO_CELL_IDS,
      `${definition.id} thresholds`,
    );
    for (const cellId of PHASE_ZERO_CELL_IDS) {
      const thresholdKey = ROW_BUDGETS[definition.id]?.[2] ?? "required";
      const threshold = row.thresholds[cellId];
      if (
        Object.keys(threshold).length !== 1 ||
        threshold[thresholdKey] !== budgetValue(budget, definition.id, cellId)
      ) {
        fail(
          `Profile row ${definition.id} threshold is not frozen from ARTIFACT_BUDGET_V1`,
        );
      }
    }
  }
}

export function validateProfileDocument(profile, schema = PROFILE_SCHEMA) {
  validateSchema(profile, schema);
  validateIdentity(profile);
  validateFixtures(profile);
  validateCells(profile);
  return profile;
}

export function validateProfileDraft(profile, budget, schema = PROFILE_SCHEMA) {
  validateSchema(profile, schema);
  validateIdentity(profile);
  if (profile.status !== "draft")
    fail("Draft validation requires status=draft");
  validateFixtures(profile);
  validateCells(profile);
  validateRows(profile, budget);
  return profile;
}

export function validateProfile(
  profile,
  { artifact, budget, expectedCommit, schema = PROFILE_SCHEMA } = {},
) {
  if (!budget || !artifact) {
    fail(
      "Profile validation requires the current budget and package measurement",
    );
  }
  validateSchema(profile, schema);
  validateIdentity(profile, expectedCommit);
  validateFixtures(profile);
  validateCells(profile);
  validateRows(profile, budget);
  if (stableJson(profile.artifact) !== stableJson(artifactBinding(artifact))) {
    fail("Profile artifact binding is stale, mutated, or from another bundle");
  }
  return profile;
}
