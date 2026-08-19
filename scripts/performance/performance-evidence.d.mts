import type {
  ArtifactBinding,
  PerformanceProfile,
} from "./performance-profile.mjs";

export interface EvidenceResult {
  rowId: string;
  warmups: number;
  samples: number;
  thresholds: Record<string, number | boolean>;
  p50: number;
  p95: number;
  p99: number;
  maximum: number;
  variance: number;
  pass: true;
}
export interface EvidenceCell {
  id: string;
  host: string;
  os: string;
  device: string;
  refreshRateHz: number | null;
  budgetClass: "desktopTablet" | "androidPhone";
  results: EvidenceResult[];
}
export interface PerformanceEvidence {
  $schema: string;
  schema: "PerformanceEvidenceV1";
  version: 1;
  profileId: string;
  profileVersion: 1;
  commit: string;
  tag: string;
  artifact: ArtifactBinding;
  fixtures: PerformanceProfile["fixtures"];
  cells: EvidenceCell[];
  manualReviewer: { name: string; reviewedAt: string; attestation: string };
}
export function validateEvidence(
  evidence: PerformanceEvidence,
  options: {
    profile: PerformanceProfile;
    artifact: ArtifactBinding;
    expectedCommit?: string;
    expectedTag?: string;
    schema?: unknown;
  },
): PerformanceEvidence;
