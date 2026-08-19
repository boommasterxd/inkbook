import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  loadArtifactBudget,
  type ArtifactBudget,
  type ArtifactMeasurement,
} from "../../scripts/performance/artifact-budget.mjs";
import {
  validateProfile,
  validateProfileDocument,
  type PerformanceProfile,
  type ProfileCell,
  type ProfileRow,
  type ProfileThreshold,
} from "../../scripts/performance/performance-profile.mjs";
import {
  validateEvidence,
  type EvidenceCell,
  type EvidenceResult,
  type PerformanceEvidence,
} from "../../scripts/performance/performance-evidence.mjs";

const SHA256_LENGTH = 64;

function readJson<T>(filePath: string): T {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return parsed as T;
}

const profile = readJson<PerformanceProfile>(
  "config/performance-profile.v1.json",
);
const profileSchema = readJson<unknown>(
  "config/performance-profile.v1.schema.json",
);
const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

function clone<T>(value: T): T {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed as T;
}

async function validatedContext(): Promise<{
  budget: ArtifactBudget;
  artifact: ArtifactMeasurement;
}> {
  const budget = await loadArtifactBudget();
  const artifact: ArtifactMeasurement = {
    schema: "ArtifactMeasurementV1",
    ...profile.artifact,
  };
  validateProfile(profile, {
    artifact,
    budget,
    expectedCommit: profile.commit,
  });
  return { budget, artifact };
}

function artifactValue(rowId: string, artifact: ArtifactMeasurement): number {
  switch (rowId) {
    case "P0-ARTIFACT-MAIN-RAW":
      return artifact.mainJsBytes;
    case "P0-ARTIFACT-MAIN-GZIP":
      return artifact.mainJsGzipBytes;
    case "P0-ARTIFACT-WORKER-RAW":
      return artifact.embeddedWorkerBytes;
    case "P0-ARTIFACT-STYLES-RAW":
      return artifact.stylesCssBytes;
    case "P0-ARTIFACT-STYLES-GZIP":
      return artifact.stylesCssGzipBytes;
    default:
      return 1;
  }
}

function thresholdCopy(
  threshold: ProfileThreshold,
): Record<string, number | boolean> {
  return { ...threshold };
}

function buildResult(
  row: ProfileRow,
  cell: ProfileCell,
  artifact: ArtifactMeasurement,
): EvidenceResult {
  const value = row.id.startsWith("P0-ARTIFACT-")
    ? artifactValue(row.id, artifact)
    : 1;
  const threshold = row.thresholds[cell.id];
  if (!threshold) throw new Error(`Missing threshold for ${row.id}/${cell.id}`);
  return {
    rowId: row.id,
    warmups: row.warmups,
    samples: row.samples,
    thresholds: thresholdCopy(threshold),
    p50: value,
    p95: value,
    p99: value,
    maximum: value,
    variance: 0,
    pass: true,
  };
}

function buildCell(
  cell: ProfileCell,
  currentProfile: PerformanceProfile,
  artifact: ArtifactMeasurement,
): EvidenceCell {
  return {
    id: cell.id,
    host: cell.host,
    os: cell.os,
    device: cell.device,
    refreshRateHz: cell.refreshRateHz,
    budgetClass: cell.budgetClass,
    results: currentProfile.rows.map((row) => buildResult(row, cell, artifact)),
  };
}

function buildEvidence(
  currentProfile: PerformanceProfile,
  artifact: ArtifactMeasurement,
): PerformanceEvidence {
  return {
    $schema: "./performance-evidence.v1.schema.json",
    schema: "PerformanceEvidenceV1",
    version: 1,
    profileId: currentProfile.profileId,
    profileVersion: currentProfile.version,
    commit,
    tag: "v0.1.0",
    artifact: clone(currentProfile.artifact),
    fixtures: clone(currentProfile.fixtures),
    cells: currentProfile.cells.map((cell) =>
      buildCell(cell, currentProfile, artifact),
    ),
    manualReviewer: {
      name: "Automated test reviewer",
      reviewedAt: "2026-08-19T00:00:00Z",
      attestation: "Test-only in-memory evidence; not a release record.",
    },
  };
}

describe("PerformanceProfileV1 validation", () => {
  it("validates the frozen profile schema and current package binding", async () => {
    const { budget, artifact } = await validatedContext();
    expect(validateProfileDocument(profile, profileSchema)).toBe(profile);
    expect(
      validateProfile(profile, {
        artifact,
        budget,
        expectedCommit: profile.commit,
      }),
    ).toBe(profile);
    expect(
      profile.rows
        .filter((row) => row.kind === "assertion")
        .map((row) => [row.id, row.warmups, row.samples]),
    ).toEqual([
      ["P0-WORKER-RESIDENT-OWNERSHIP", 0, 1],
      ["P0-ZERO-BALANCE-DISPOSAL", 0, 1],
    ]);
  });

  it("rejects stale profile artifacts and mutated fixture digests", async () => {
    const { budget, artifact } = await validatedContext();
    const stale = clone(profile);
    stale.artifact.mainJsSha256 = "0".repeat(SHA256_LENGTH);
    expect(() =>
      validateProfile(stale, {
        artifact,
        budget,
        expectedCommit: profile.commit,
      }),
    ).toThrow(/artifact binding/);

    const mutatedFixture = clone(profile);
    const fixture = mutatedFixture.fixtures[0];
    if (!fixture) throw new Error("Expected one fixture");
    fixture.digest = "0".repeat(SHA256_LENGTH);
    expect(() =>
      validateProfile(mutatedFixture, {
        artifact,
        budget,
        expectedCommit: profile.commit,
      }),
    ).toThrow(/Fixture/);
  });

  it("requires a final profile and rejects mutated evidence artifacts", async () => {
    const { artifact } = await validatedContext();
    const finalProfile = clone(profile);
    finalProfile.status = "final";
    const evidence = buildEvidence(finalProfile, artifact);
    expect(
      validateEvidence(evidence, {
        profile: finalProfile,
        artifact: finalProfile.artifact,
        expectedCommit: commit,
        expectedTag: "v0.1.0",
      }),
    ).toBe(evidence);

    const mutatedEvidence = clone(evidence);
    mutatedEvidence.artifact.mainJsSha256 = "0".repeat(SHA256_LENGTH);
    expect(() =>
      validateEvidence(mutatedEvidence, {
        profile: finalProfile,
        artifact: finalProfile.artifact,
        expectedCommit: commit,
        expectedTag: "v0.1.0",
      }),
    ).toThrow(/artifact binding/);

    const missingVariance = buildEvidence(finalProfile, artifact);
    const firstResult = missingVariance.cells[0]?.results[0];
    if (!firstResult) throw new Error("Expected one evidence result");
    Reflect.deleteProperty(firstResult, "variance");
    expect(() =>
      validateEvidence(missingVariance, {
        profile: finalProfile,
        artifact: finalProfile.artifact,
      }),
    ).toThrow(/Schema validation/);

    const draftProfile = clone(profile);
    draftProfile.status = "draft";
    const draftEvidence = buildEvidence(draftProfile, artifact);
    expect(() =>
      validateEvidence(draftEvidence, {
        profile: draftProfile,
        artifact: draftProfile.artifact,
        expectedCommit: commit,
        expectedTag: "v0.1.0",
      }),
    ).toThrow(/final/);
  });
});
