import { describe, expect, it, vi } from "vitest";
import { mayHaveAnchorInBounds } from "../../../../src/domain/geometry/anchor-query";
import {
  resolveShapeAnchor,
  semanticAnchors,
  visitLocalAnchorPoints,
} from "../../../../src/domain/geometry/anchors";
import {
  anchorFreePoint,
  SNAP_TARGET_FAMILIES,
  snappingTarget,
} from "../../../fixtures/editor/snapping-targets";
import type { Bounds } from "../../../../src/domain/geometry/primitives";

const TARGET_TRANSFORMS = [0, 37, 90, 180, 359.999].flatMap((rotation) =>
  [-999_000, 0, 999_000].map((offset) => ({ rotation, offset })),
);

function contains(bounds: Bounds, point: { readonly x: number; readonly y: number }): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

describe("canonical anchor query parity", () => {
  it.each(SNAP_TARGET_FAMILIES)(
    "matches public %s anchor resolution across rotations and rounding boundaries",
    (family) => {
      for (const { rotation, offset: position } of TARGET_TRANSFORMS) {
        const target = snappingTarget(family, rotation, position);
        const anchors = semanticAnchors(target);
        for (const [order, anchor] of anchors.entries()) {
          expect(anchor.order).toBe(order);
          expect(anchor.point).toEqual(resolveShapeAnchor(target, anchor.anchor));
          for (const offset of [-0.001, -0.00049, 0, 0.00049, 0.001]) {
            const bounds = {
              minX: anchor.point.x + offset,
              maxX: anchor.point.x + offset + 0.0001,
              minY: anchor.point.y - 0.0001,
              maxY: anchor.point.y + 0.0001,
            };
            expect(mayHaveAnchorInBounds(target, bounds)).toBe(
              anchors.some((entry) => contains(bounds, entry.point)),
            );
          }
        }
        const miss = anchorFreePoint(target);
        expect(
          mayHaveAnchorInBounds(target, {
            minX: miss.x - 12,
            maxX: miss.x + 12,
            minY: miss.y - 12,
            maxY: miss.y + 12,
          }),
        ).toBe(false);
      }
    },
  );
});

describe("prepared local anchor geometry", () => {
  it.each(["rectangle", "table", "triangle", "diamond", "parallelogram", "octagon"] as const)(
    "reads %s geometry once when building all positive semantic anchors",
    (family) => {
      const target = snappingTarget(family, 37);
      const expected = semanticAnchors(target);
      let reads = 0;
      const observed = new Proxy(target, {
        get: (value, key, receiver) => {
          if (key === "x") reads += 1;
          return Reflect.get(value, key, receiver) as unknown;
        },
      });
      expect(semanticAnchors(observed)).toEqual(expected);
      // The box map reads its left edge once; each canonical polygon vertex reads it once.
      expect(reads).toBe(family === "rectangle" || family === "table" ? 1 : expected.length / 2);
    },
  );
});

describe("pointwise anchor work", () => {
  it.each(SNAP_TARGET_FAMILIES)(
    "stops at the first canonical %s hit without visiting later anchors",
    (family) => {
      const target = snappingTarget(family, 37);
      const first = semanticAnchors(target)[0]!.point;
      const visit = vi.fn(() => true);
      expect(visitLocalAnchorPoints(target, visit)).toBe(true);
      expect(visit).toHaveBeenCalledOnce();
      const sine = vi.spyOn(Math, "sin");
      try {
        expect(
          mayHaveAnchorInBounds(target, {
            minX: first.x,
            maxX: first.x,
            minY: first.y,
            maxY: first.y,
          }),
        ).toBe(true);
        // One inverse transform and one exact canonical candidate, independent of total anchors.
        expect(sine).toHaveBeenCalledTimes(2);
      } finally {
        sine.mockRestore();
      }
    },
  );
});
