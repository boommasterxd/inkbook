import type { StrokeSampleExtrema } from "./stroke-sample-extrema";
import type { InkSnapshotV1 } from "./types";
import type { SpatialBounds } from "../spatial/index";

export type ValidationErrorCode =
  | "invalid-json-value"
  | "maximum-depth-exceeded"
  | "json-node-limit-exceeded"
  | "input-byte-limit-exceeded"
  | "metadata-byte-limit-exceeded"
  | "unknown-property"
  | "missing-property"
  | "invalid-literal"
  | "invalid-type"
  | "invalid-number"
  | "invalid-range"
  | "invalid-uuid"
  | "invalid-color"
  | "invalid-stroke-samples"
  | "element-limit-exceeded"
  | "stroke-limit-exceeded"
  | "stroke-point-limit-exceeded"
  | "connection-limit-exceeded"
  | "spatial-index-limit-exceeded"
  | "duplicate-id"
  | "invalid-render-band-order"
  | "invalid-connection-target"
  | "invalid-anchor"
  | "connection-position-mismatch";

export interface ValidationError {
  code: ValidationErrorCode;
  path: string;
  message: string;
}

export interface ValidationStatistics {
  elements: number;
  strokes: number;
  strokePoints: number;
  connectedEndpoints: number;
  spatialIndexCellMemberships: number;
  spatialIndexOverflowElements: number;
  maximumDepth: number;
}

export type ValidationResult<T> =
  { ok: true; value: T; statistics: ValidationStatistics } | { ok: false; error: ValidationError };

export interface ValidationByteLengths {
  totalInputBytes?: number;
  metadataBytes?: number;
}

export interface ElementValidationDerivation {
  readonly strokeLocalBounds?: Readonly<SpatialBounds>;
  readonly strokeSampleExtrema?: StrokeSampleExtrema;
  readonly bounds: Readonly<SpatialBounds>;
  readonly elementId: string;
  readonly spatialMemberships: number;
  readonly spatialOverflow: boolean;
}

export interface SnapshotValidationDerivations {
  readonly elements: readonly ElementValidationDerivation[];
  readonly maximumBottom: number | null;
}

export type SnapshotValidationResult =
  | {
      readonly derivations: SnapshotValidationDerivations;
      readonly ok: true;
      readonly statistics: ValidationStatistics;
      readonly value: InkSnapshotV1;
    }
  | { readonly error: ValidationError; readonly ok: false };
