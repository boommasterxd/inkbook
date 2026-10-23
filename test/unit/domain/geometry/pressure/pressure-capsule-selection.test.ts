import { describe, expect, it } from "vitest";

import {
  pressureCapsuleContainsPoint,
  pressureCapsuleSegmentMargin,
} from "../../../../../src/domain/geometry/pressure/pressure-capsule-selection";

const capsule = {
  start: { center: { x: 0, y: 0 }, radius: 1 },
  end: { center: { x: 10, y: 0 }, radius: 2 },
};

describe("analytic pressure capsule distances", () => {
  it.each([
    [{ x: -1, y: 0 }, true],
    [{ x: -1.001, y: 0 }, false],
    [{ x: 12, y: 0 }, true],
    [{ x: 12.001, y: 0 }, false],
    [{ x: 5, y: 1.507 }, true],
    [{ x: 5, y: 1.508 }, false],
  ] as const)("classifies a tapered capsule at %j", (point, expected) => {
    expect(pressureCapsuleContainsPoint(capsule, point)).toBe(expected);
  });

  it("partitions nearest-segment projection across both endpoints", () => {
    expect(pressureCapsuleSegmentMargin(capsule, { x: 3, y: 0 }, { x: 6, y: 0 })).toBeLessThan(0);
    expect(pressureCapsuleSegmentMargin(capsule, { x: 6, y: 0 }, { x: 3, y: 0 })).toBeLessThan(0);
    expect(pressureCapsuleSegmentMargin(capsule, { x: -5, y: 3 }, { x: 15, y: 3 })).toBeCloseTo(5);
    expect(pressureCapsuleSegmentMargin(capsule, { x: -1, y: -1 }, { x: -1, y: 1 })).toBe(0);
    expect(pressureCapsuleSegmentMargin(capsule, { x: 12, y: -1 }, { x: 12, y: 1 })).toBe(0);
  });

  it("includes tolerance and either containing endpoint disk", () => {
    expect(pressureCapsuleContainsPoint(capsule, { x: -1.1, y: 0 }, 0.2)).toBe(true);
    const containing = { ...capsule, end: { center: { x: 1, y: 0 }, radius: 5 } };
    expect(pressureCapsuleContainsPoint(containing, { x: 5.5, y: 0 })).toBe(true);
    expect(
      pressureCapsuleContainsPoint(
        { start: containing.end, end: containing.start },
        { x: 5.5, y: 0 },
      ),
    ).toBe(true);
  });
});
