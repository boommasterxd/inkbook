import type { PerformanceProfile } from "./performance-profile.mjs";

export class RuntimeMeasurementError extends Error {}

export interface RuntimeDiagnosticSnapshot {
  moduleEvaluatedAt: number;
  onloadEnteredAt: number;
  onloadSettledAt: number;
  cssOwnerCount: 1;
}

export interface RuntimeDisposalSnapshot {
  onunloadEnteredAt: number;
  disposalSettledAt: number;
  cssOwnerCount: 0;
  resourceCoordinatorBalanced: true;
  resourceCoordinatorDisposed: true;
}

export interface RuntimeEnvironmentSnapshot {
  workerLaunched: true;
  workerResultPassed: true;
  recoveryPassed: true;
  workerResourcesReleased: true;
}

export interface RuntimeHostDriver {
  initialize(): Promise<RuntimeDiagnosticSnapshot>;
  runEnvironmentProbe(): Promise<RuntimeEnvironmentSnapshot>;
  disableCurrent(moduleEvaluatedAt: number): Promise<RuntimeDisposalSnapshot>;
  collectGarbage(): Promise<void>;
  enableNext(moduleEvaluatedAt: number): Promise<{
    enableStartedAt: number;
    ready: RuntimeDiagnosticSnapshot;
  }>;
  heapUsage(): Promise<{ totalSize: number; usedSize: number }>;
  ensureEnabled(): Promise<RuntimeDiagnosticSnapshot>;
}

export interface MeasurementStatistics {
  p50: number;
  p95: number;
  p99: number;
  maximum: number;
  variance: number;
}

export interface RuntimeMeasurementOutput {
  schema: "InkbookRuntimeMeasurementV1";
  version: 1;
  profileId: string;
  profileVersion: 1;
  procedureVersion: string;
  artifact: { mainJsSha256: string; stylesCssSha256: string };
  cell: Record<string, unknown>;
  rows: readonly Record<string, unknown>[];
}

export function summarizeMeasurements(
  values: readonly number[],
): MeasurementStatistics;
export function measureRuntimeCell(options: {
  driver: RuntimeHostDriver;
  profile: PerformanceProfile;
  cellId: string;
}): Promise<RuntimeMeasurementOutput>;
export function main(
  args?: readonly string[],
): Promise<RuntimeMeasurementOutput>;
