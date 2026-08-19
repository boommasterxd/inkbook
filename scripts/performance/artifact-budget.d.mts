export class ArtifactBudgetError extends Error {}
export interface ArtifactBudget {
  limits: Record<string, number>;
  runtime?: Record<string, Record<string, number>>;
}
export interface ArtifactMeasurement {
  schema: "ArtifactMeasurementV1";
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
export function loadArtifactBudget(
  configPath?: string,
): Promise<ArtifactBudget>;
export function sha256(value: string | Uint8Array): string;
export function deterministicGzip(value: string | Uint8Array): Uint8Array;
export function extractEmbeddedWorker(mainSource: string): string;
export function measureArtifactPackage(
  packageDirectory?: string,
): Promise<ArtifactMeasurement>;
export function assertArtifactBudget(
  measurement: ArtifactMeasurement,
  budget: ArtifactBudget,
): ArtifactMeasurement;
