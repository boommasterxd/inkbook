import type {
  ArtifactBudget,
  ArtifactMeasurement,
} from "./artifact-budget.mjs";

export class PerformanceValidationError extends Error {}
export const PHASE_ZERO_CELLS: Readonly<
  Record<string, { platform: string; budgetClass: string }>
>;
export const PHASE_ZERO_CELL_IDS: readonly string[];
export const PHASE_ZERO_ROW_DEFINITIONS: readonly Record<string, string>[];
export interface Fixture {
  id: string;
  generator: string;
  digest: string;
}
export interface ProfileThreshold {
  max?: number;
  p95Max?: number;
  required?: boolean;
}
export interface ProfileRow {
  id: string;
  kind: "assertion" | "deterministic" | "runtime";
  metric: string;
  unit: string;
  warmups: number;
  samples: number;
  thresholds: Record<string, ProfileThreshold>;
}
export interface ProfileCell {
  id: string;
  platform: string;
  host: string;
  os: string;
  device: string;
  refreshRateHz: number | null;
  budgetClass: "desktopTablet" | "androidPhone";
}
export interface ArtifactBinding {
  mainJsSha256: string;
  mainJsBytes: number;
  mainJsGzipBytes: number;
  embeddedWorkerSha256: string;
  embeddedWorkerBytes: number;
  stylesCssSha256: string;
  stylesCssBytes: number;
  stylesCssGzipBytes: number;
  packageChecksums: Record<string, string>;
}
export interface PerformanceProfile {
  $schema: string;
  schema: "PerformanceProfileV1";
  version: 1;
  profileId: string;
  phase: "P0";
  status: "draft" | "final";
  commit: string;
  artifactBudget: "ARTIFACT_BUDGET_V1";
  artifact: ArtifactBinding;
  fixtures: Fixture[];
  cells: ProfileCell[];
  procedure: {
    version: string;
    warmups: number;
    samples: number;
    percentile: string;
    steps: string[];
  };
  rows: ProfileRow[];
}
export function validateProfileDocument(
  profile: PerformanceProfile,
  schema?: unknown,
): PerformanceProfile;
export function validateProfileDraft(
  profile: PerformanceProfile,
  budget: ArtifactBudget,
  schema?: unknown,
): PerformanceProfile;
export function validateProfile(
  profile: PerformanceProfile,
  options?: {
    artifact?: ArtifactBinding | ArtifactMeasurement;
    budget?: ArtifactBudget;
    expectedCommit?: string;
    schema?: unknown;
  },
): PerformanceProfile;
export function artifactBinding(
  measurement: ArtifactMeasurement,
): ArtifactBinding;
