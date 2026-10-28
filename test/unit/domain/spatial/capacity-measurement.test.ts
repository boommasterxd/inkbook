import { describe, expect, it } from "vitest";

import {
  measureSpatialCapacitySteps,
  spatialCellMembershipCount,
} from "../../../../src/domain/spatial/index";
import { assertMeasuredSpatialCapacity } from "../../../../src/domain/spatial/capacity";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";

describe("spatial aggregate capacity measurement", () => {
  it("counts retained cell memberships and oversized elements separately", () => {
    const measurement = finishGeometrySteps(
      measureSpatialCapacitySteps([
        { minX: 0, minY: 0, maxX: 255, maxY: 255 },
        { minX: 256, minY: 0, maxX: 512, maxY: 255 },
        { minX: 0, minY: 0, maxX: 256, maxY: 256 * 128 },
      ]),
    );

    expect(measurement).toEqual({ cellMemberships: 3, overflowElements: 1 });
    expect(Object.isFrozen(measurement)).toBe(true);
  });

  it("admits exactly one bound in input order per cooperative step", () => {
    const visited: number[] = [];
    function* bounds() {
      for (const maxX of [255, 512]) {
        visited.push(maxX);
        yield { minX: 0, minY: 0, maxX, maxY: 255 };
      }
    }
    const steps = measureSpatialCapacitySteps(bounds());
    expect(visited).toEqual([]);
    expect(steps.next()).toEqual({ done: false, value: undefined });
    expect(visited).toEqual([255]);
    expect(steps.next()).toEqual({ done: false, value: undefined });
    expect(visited).toEqual([255, 512]);
    expect(steps.next()).toEqual({
      done: true,
      value: { cellMemberships: 4, overflowElements: 0 },
    });
  });

  it.each([
    [{ minX: 0, minY: 0, maxX: NaN, maxY: 0 }, TypeError],
    [{ minX: 1, minY: 0, maxX: 0, maxY: 0 }, RangeError],
    [{ minX: 1e30, minY: 0, maxX: 1e30, maxY: 0 }, RangeError],
  ])("validates each bound when its measurement step is admitted", (invalid, error) => {
    const steps = measureSpatialCapacitySteps([{ minX: 0, minY: 0, maxX: 0, maxY: 0 }, invalid]);
    expect(steps.next()).toEqual({ done: false, value: undefined });
    expect(() => steps.next()).toThrow(error);
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
