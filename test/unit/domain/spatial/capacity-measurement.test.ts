import { describe, expect, it } from "vitest";

import {
  measureSpatialCapacity,
  spatialCellMembershipCount,
} from "../../../../src/domain/spatial/index";
import { assertMeasuredSpatialCapacity } from "../../../../src/domain/spatial/capacity";

describe("spatial aggregate capacity measurement", () => {
  it("counts retained cell memberships and oversized elements separately", () => {
    const measurement = measureSpatialCapacity([
      { minX: 0, minY: 0, maxX: 255, maxY: 255 },
      { minX: 256, minY: 0, maxX: 512, maxY: 255 },
      { minX: 0, minY: 0, maxX: 256, maxY: 256 * 128 },
    ]);

    expect(measurement).toEqual({ cellMemberships: 3, overflowElements: 1 });
  });

  it("uses inclusive boundary-cell membership identical to the uniform grid", () => {
    expect(spatialCellMembershipCount({ minX: 0, minY: 0, maxX: 255.999, maxY: 255.999 })).toBe(1);
    expect(spatialCellMembershipCount({ minX: 0, minY: 0, maxX: 256, maxY: 256 })).toBe(4);
  });

  it("enforces caller-specific membership and overflow limits", () => {
    expect(() =>
      assertMeasuredSpatialCapacity(
        { cellMemberships: 3, overflowElements: 1 },
        { cellMemberships: 2, overflowElements: 1 },
      ),
    ).toThrow("Spatial index membership is limited to 2 cells.");
    expect(() =>
      assertMeasuredSpatialCapacity(
        { cellMemberships: 2, overflowElements: 2 },
        { cellMemberships: 2, overflowElements: 1 },
      ),
    ).toThrow("Spatial index overflow is limited to 1 elements.");
  });
});
