import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/bounds";
import { buildElementPathParts, nodeSize } from "../../../../src/domain/geometry/element-path";
import type { ArrowElementV1, BoxShapeElementV1 } from "../../../../src/domain/schema/types";
import { coordinateSystem, outlineStyle, rectangle, table } from "./fixtures";

const origin = { x: 10, y: 20 };
const arrow: ArrowElementV1 = {
  id: "tiny-arrow",
  createdAt: 0,
  kind: "arrow",
  start: origin,
  end: origin,
  bend: null,
  pivot: origin,
  rotation: 0,
  startNode: "circle",
  endNode: "arrow",
  startConnection: null,
  endConnection: null,
  style: outlineStyle,
};

describe("tiny element geometry", () => {
  it("keeps coincident arrows and axes within the outline-sized point bounds", () => {
    const system = coordinateSystem();
    system.origin = origin;
    system.axes = [origin, origin];
    const collapsedTable = table({ x: 10, y: 20, columnWidth: 0, height: 0, headerHeight: 0 });
    for (const element of [arrow, system, collapsedTable]) {
      const parts = buildElementPathParts(element);
      expect(parts).toHaveLength(1);
      expect(parts[0]?.d.replaceAll("M10 20L10 20", "")).toBe("");
      expect(calculateElementBounds(element)).toEqual({ minX: 9, minY: 19, maxX: 11, maxY: 21 });
    }
  });

  it("renders every collapsed closed shape as an open zero-length segment", () => {
    const kinds: BoxShapeElementV1["kind"][] = [
      "rectangle",
      "ellipse",
      "triangle",
      "diamond",
      "octagon",
      "parallelogram",
    ];
    for (const kind of kinds) {
      const element = rectangle({ kind, x: 10, y: 20, width: 0, height: 0, pivot: origin });
      expect(buildElementPathParts(element)).toEqual([
        { d: "M10 20L10 20", paint: "fill-and-stroke" },
      ]);
      expect(calculateElementBounds(element)).toEqual({ minX: 9, minY: 19, maxX: 11, maxY: 21 });
    }
  });

  it("caps every arrow decoration by the available chord length", () => {
    expect(nodeSize(8, origin, { x: 10.003, y: 20.004 })).toBeCloseTo(0.005);
    for (const endNode of ["arrow", "triangle", "diamond", "circle"] as const) {
      const element = { ...arrow, end: { x: 10.1, y: 20 }, endNode };
      const bounds = calculateElementBounds(element);
      expect(bounds.minX).toBeGreaterThanOrEqual(9);
      expect(bounds.maxX).toBeCloseTo(11.1);
      expect(bounds.minY).toBeGreaterThanOrEqual(18.95);
      expect(bounds.maxY).toBeLessThanOrEqual(21.05);
      expect(buildElementPathParts(element).every((part) => !/NaN|Infinity/.test(part.d))).toBe(
        true,
      );
    }
  });
});
