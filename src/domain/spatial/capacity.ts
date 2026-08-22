export const MAX_OVERFLOW_ELEMENTS = 512;
export const MAX_SPATIAL_MEMBERSHIPS = 262_144;

export interface SpatialCapacityMeasurement {
  readonly cellMemberships: number;
  readonly overflowElements: number;
}

export function assertMeasuredSpatialCapacity(
  measurement: SpatialCapacityMeasurement,
  limits: Readonly<SpatialCapacityMeasurement>,
): void {
  if (measurement.cellMemberships > limits.cellMemberships) {
    throw new RangeError(`Spatial index membership is limited to ${limits.cellMemberships} cells.`);
  }
  if (measurement.overflowElements > limits.overflowElements) {
    throw new RangeError(
      `Spatial index overflow is limited to ${limits.overflowElements} elements.`,
    );
  }
}

export function assertSpatialAggregateCapacity(
  memberships: number,
  overflow: number,
  currentVersion: number,
  replacementCount: number,
): void {
  assertMeasuredSpatialCapacity(
    { cellMemberships: memberships, overflowElements: overflow },
    {
      cellMemberships: MAX_SPATIAL_MEMBERSHIPS,
      overflowElements: MAX_OVERFLOW_ELEMENTS,
    },
  );
  if (replacementCount > Number.MAX_SAFE_INTEGER - currentVersion) {
    throw new RangeError("Spatial record version capacity is exhausted.");
  }
}
