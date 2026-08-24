export const INKBOOK_FORMAT = "inkbook" as const;
export const INKBOOK_VERSION = 1 as const;
export const PAGE_INNER_WIDTH = 2000 as const;
export const PAGE_MARGIN = 24.3 as const;
export const PAGE_WIDTH = 2048.6 as const;
export const CANONICAL_LOCKED_BUFFER_LINES = 1 as const;

export const MAX_JSON_DEPTH = 16 as const;
export const MAX_ABSOLUTE_COORDINATE = 1_000_000 as const;
export const MAX_DERIVED_HEIGHT = 1_000_000 as const;
export const MAX_STROKE_POINTS = 4096 as const;

export interface SchemaLimits {
  totalInputBytes: number;
  metadataBytes: number;
  elements: number;
  strokes: number;
  strokePoints: number;
  pointsPerStroke: number;
  connectedEndpoints: number;
  connectedEndpointsPerTarget: number;
  spatialIndexOverflowElements: number;
  spatialIndexCellMemberships: number;
  absoluteCoordinate: number;
  maximumDerivedHeight: number | null;
}

export const FILE_SCHEMA_LIMITS: Readonly<SchemaLimits> = Object.freeze({
  totalInputBytes: 64 * 1024 * 1024,
  metadataBytes: 60 * 1024 * 1024,
  elements: 20_000,
  strokes: 15_000,
  strokePoints: 2_000_000,
  pointsPerStroke: MAX_STROKE_POINTS,
  connectedEndpoints: 20_000,
  connectedEndpointsPerTarget: 512,
  spatialIndexOverflowElements: 512,
  spatialIndexCellMemberships: 262_144,
  absoluteCoordinate: MAX_ABSOLUTE_COORDINATE,
  maximumDerivedHeight: MAX_DERIVED_HEIGHT,
});

export const CLIPBOARD_SCHEMA_LIMITS: Readonly<SchemaLimits> = Object.freeze({
  totalInputBytes: 8 * 1024 * 1024,
  metadataBytes: 8 * 1024 * 1024,
  elements: 5000,
  strokes: 4000,
  strokePoints: 500_000,
  pointsPerStroke: MAX_STROKE_POINTS,
  connectedEndpoints: 5000,
  connectedEndpointsPerTarget: 128,
  spatialIndexOverflowElements: 128,
  spatialIndexCellMemberships: 262_144,
  absoluteCoordinate: MAX_ABSOLUTE_COORDINATE,
  maximumDerivedHeight: null,
});

export const PORTABLE_PALETTE_V1 = Object.freeze({
  light: Object.freeze({ page: "#F6F6F6FF", text: "#222222FF", guide: "#ABABAB40" }),
  dark: Object.freeze({ page: "#212121FF", text: "#DADADAFF", guide: "#66666640" }),
});
