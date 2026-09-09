import { describe, expect, it } from "vitest";

import {
  boundsFromPoints,
  calculateElementBounds,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import { expandBounds } from "../../../../src/domain/geometry/primitives";
import type { BoxShapeElementV1, TableElementV1 } from "../../../../src/domain/schema/public";
import { rectangle, table } from "./fixtures";
import { outlineStyle, shapeStyle } from "../schema/fixtures";

const ROTATIONS = [-450, -180, -90, -37, -0.001, 0, 0.001, 37, 89.999, 90, 180, 270, 360];
const GEOMETRIES = [
  { x: 0, y: 0, columnWidth: 50, columns: 2, height: 50, pivot: { x: 50, y: 25 }, outlineWidth: 2 },
  {
    x: -123.456,
    y: 17.125,
    columnWidth: 40.333,
    columns: 7,
    height: 80.001,
    pivot: { x: 999.875, y: -321.234 },
    outlineWidth: 4,
  },
  {
    x: 1024.001,
    y: -2048.999,
    columnWidth: 127.125,
    columns: 1,
    height: 333.333,
    pivot: { x: 1000, y: -2000 },
    outlineWidth: 22,
  },
] as const;

describe("conservative rotated box bounds", () => {
  it.for(["rectangle", "ellipse", "table"] as const)(
    "matches the four rotated corner envelope exactly for %s",
    (kind) => {
      for (const rotation of ROTATIONS) {
        for (const geometry of GEOMETRIES) {
          const { columns, columnWidth, outlineWidth, ...position } = geometry;
          const dimensions = { ...position, rotation };
          const element =
            kind === "table"
              ? table({
                  ...dimensions,
                  columns,
                  columnWidth,
                  style: { ...outlineStyle, outlineWidth },
                })
              : rectangle({
                  ...dimensions,
                  kind,
                  width: columns * columnWidth,
                  style: { ...shapeStyle, outlineWidth },
                });
          expect(calculateElementBounds(element), `${kind}, ${rotation}, x=${geometry.x}`).toEqual(
            cornerEnvelope(element),
          );
        }
      }
    },
  );
});

/** Geometric oracle: rotate each corner, take its axis-aligned envelope, then add paint. */
function cornerEnvelope(element: BoxShapeElementV1 | TableElementV1) {
  const width = element.kind === "table" ? element.columns * element.columnWidth : element.width;
  const corners = [
    { x: element.x, y: element.y },
    { x: element.x + width, y: element.y },
    { x: element.x + width, y: element.y + element.height },
    { x: element.x, y: element.y + element.height },
  ];
  const rotated = corners.map((point) =>
    rotatePointClockwise(point, element.pivot, element.rotation),
  );
  return expandBounds(boundsFromPoints(rotated), element.style.outlineWidth / 2);
}
