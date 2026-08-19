import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactBinding,
  fail,
  PHASE_ZERO_CELL_IDS,
  PHASE_ZERO_ROW_DEFINITIONS,
} from "./performance-profile.mjs";
import { stableJson, validateJsonSchema } from "./schema-validation.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const EVIDENCE_SCHEMA_PATH = path.join(
  REPOSITORY_ROOT,
  "config/performance-evidence.v1.schema.json",
);
const EVIDENCE_SCHEMA = JSON.parse(readFileSync(EVIDENCE_SCHEMA_PATH, "utf8"));

const ARTIFACT_ROW_MEASUREMENTS = Object.freeze({
  "P0-ARTIFACT-MAIN-RAW": "mainJsBytes",
  "P0-ARTIFACT-MAIN-GZIP": "mainJsGzipBytes",
  "P0-ARTIFACT-WORKER-RAW": "embeddedWorkerBytes",
  "P0-ARTIFACT-STYLES-RAW": "stylesCssBytes",
  "P0-ARTIFACT-STYLES-GZIP": "stylesCssGzipBytes",
});

function validateSchema(document, schema) {
  try {
    validateJsonSchema(document, schema);
  } catch (error) {
    fail(`Schema validation failed: ${error.message}`);
  }
}

function validateIdentity(evidence, profile, expectedCommit, expectedTag) {
  if (evidence.schema !== "PerformanceEvidenceV1" || evidence.version !== 1) {
    fail("Evidence identity is not PerformanceEvidenceV1");
  }
  if (
    evidence.profileId !== profile.profileId ||
    evidence.profileVersion !== profile.version
  ) {
    fail("Evidence references another performance profile");
  }
  if (profile.status !== "final")
    fail("Release evidence requires a final PerformanceProfileV1, not a draft");
  if (expectedCommit && evidence.commit !== expectedCommit) {
    fail(`Evidence commit ${evidence.commit} does not match ${expectedCommit}`);
  }
  if (expectedTag && evidence.tag !== expectedTag) {
    fail(`Evidence tag ${evidence.tag} does not match ${expectedTag}`);
  }
}

function validateFixtures(evidence, profile) {
  if (stableJson(evidence.fixtures) !== stableJson(profile.fixtures)) {
    fail(
      "Evidence fixture generators or digests do not match the frozen profile",
    );
  }
}

function validateArtifactResult(result, row, cellId, artifact) {
  const measurementKey = ARTIFACT_ROW_MEASUREMENTS[row.id];
  if (!measurementKey) return false;
  const expected = artifact[measurementKey];
  if (
    !["p50", "p95", "p99", "maximum"].every((key) => result[key] === expected)
  ) {
    fail(
      `Evidence artifact result ${row.id}/${cellId} does not match the current bundle`,
    );
  }
  return true;
}

function validateLifecycleResult(result, row, cellId) {
  if (
    !["P0-WORKER-RESIDENT-OWNERSHIP", "P0-ZERO-BALANCE-DISPOSAL"].includes(
      row.id,
    )
  )
    return false;
  if (!["p50", "p95", "p99", "maximum"].every((key) => result[key] === 1)) {
    fail(
      `Evidence lifecycle result ${row.id}/${cellId} did not prove its required assertion`,
    );
  }
  return true;
}

function validateRuntimeResult(result, row, cellId) {
  if (!(
    result.p50 <= result.p95 &&
    result.p95 <= result.p99 &&
    result.p99 <= result.maximum
  )) {
    fail(
      `Evidence runtime result ${row.id}/${cellId} has invalid percentile ordering`,
    );
  }
  const threshold = row.thresholds[cellId];
  const selectedThreshold = threshold.p95Max ?? threshold.max;
  const selectedValue =
    threshold.p95Max === undefined ? result.maximum : result.p95;
  if (selectedValue > selectedThreshold) {
    fail(
      `Evidence runtime result ${row.id}/${cellId} exceeds its frozen threshold`,
    );
  }
}

function validateResult(result, row, cellId, artifact) {
  if (validateArtifactResult(result, row, cellId, artifact)) return;
  if (validateLifecycleResult(result, row, cellId)) return;
  validateRuntimeResult(result, row, cellId);
}

function validateCell(cell, profileCells, rowMap, artifact) {
  const expectedCell = profileCells.get(cell.id);
  if (!expectedCell)
    fail(`Evidence cell ${cell.id} is missing from the profile`);
  for (const key of ["host", "os", "device", "refreshRateHz", "budgetClass"]) {
    if (cell[key] !== expectedCell[key])
      fail(
        `Evidence cell ${cell.id} metadata does not match the frozen profile`,
      );
  }
  const seenRows = new Set();
  for (const result of cell.results) {
    const row = rowMap.get(result.rowId);
    if (!row || seenRows.has(result.rowId))
      fail(
        `Evidence row ${result.rowId} is missing or duplicated in ${cell.id}`,
      );
    seenRows.add(result.rowId);
    if (result.warmups !== row.warmups || result.samples !== row.samples) {
      fail(
        `Evidence row ${result.rowId}/${cell.id} changed warmups or samples`,
      );
    }
    if (stableJson(result.thresholds) !== stableJson(row.thresholds[cell.id])) {
      fail(
        `Evidence row ${result.rowId}/${cell.id} changed its selected threshold`,
      );
    }
    if (result.pass !== true)
      fail(`Evidence row ${result.rowId}/${cell.id} is not passing`);
    validateResult(result, row, cell.id, artifact);
  }
  const expectedRows = PHASE_ZERO_ROW_DEFINITIONS.map((row) => row.id);
  if (stableJson([...seenRows].sort()) !== stableJson(expectedRows.sort())) {
    fail(`${cell.id} evidence rows are incomplete`);
  }
}

function validateCells(evidence, profile, artifact) {
  const profileCells = new Map(profile.cells.map((cell) => [cell.id, cell]));
  const rowMap = new Map(profile.rows.map((row) => [row.id, row]));
  const seenCells = new Set();
  for (const cell of evidence.cells) {
    if (seenCells.has(cell.id)) fail(`Evidence cell ${cell.id} is duplicated`);
    seenCells.add(cell.id);
    validateCell(cell, profileCells, rowMap, artifact);
  }
  if (
    stableJson([...seenCells].sort()) !==
    stableJson([...PHASE_ZERO_CELL_IDS].sort())
  ) {
    fail("Evidence is missing a required Phase-0 device cell");
  }
}

export function validateEvidence(
  evidence,
  {
    profile,
    artifact,
    expectedCommit,
    expectedTag,
    schema = EVIDENCE_SCHEMA,
  } = {},
) {
  if (!profile || !artifact) {
    fail(
      "Evidence validation requires the profile and current package measurement",
    );
  }
  validateSchema(evidence, schema);
  validateIdentity(evidence, profile, expectedCommit, expectedTag);
  if (stableJson(evidence.artifact) !== stableJson(artifactBinding(artifact))) {
    fail("Evidence artifact binding is stale, mutated, or from another bundle");
  }
  validateFixtures(evidence, profile);
  validateCells(evidence, profile, artifact);
  return evidence;
}
