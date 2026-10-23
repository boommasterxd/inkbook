import { describe, expect, it } from "vitest";
import {
  buildPressureCapsule,
  pressureArcPoint,
  type PressureBoundaryArc,
  type PressureCenter,
} from "../../../../../src/domain/geometry/pressure/pressure-joins";
import { buildPressureOutline } from "../../../../../src/domain/geometry/pressure/pressure-outline";
import { pointSegmentDistance } from "../../../../../src/domain/geometry/primitives";
import { simplifyStrokeCenters } from "../../../../../src/domain/geometry/stroke-simplification";
import type { PointV1 } from "../../../../../src/domain/schema/types";
import { polygonWinding, sampleSvgPathContours } from "../../../../fixtures/domain/svg-path-fill";

function sampleArc(arc: PressureBoundaryArc): PointV1[] {
  return Array.from({ length: 129 }, (_, index) => pressureArcPoint(arc, index / 128));
}

function idealCapsules(centers: readonly PressureCenter[], width: number): PointV1[][] {
  const selected = simplifyStrokeCenters(centers, width, true);
  return selected.slice(1).map((end, index) => {
    const piece = buildPressureCapsule(selected[index]!, end, width);
    if (piece.kind === "dot") {
      const point = { x: piece.center.x + piece.radius, y: piece.center.y };
      return sampleArc({ ...piece, kind: "arc", start: point, end: point, sweep: -2 * Math.PI });
    }
    return [
      piece.left.start,
      piece.left.end,
      ...sampleArc(piece.endCap),
      piece.right.start,
      ...sampleArc(piece.startCap),
    ];
  });
}

function boundaryDistance(point: PointV1, contour: readonly PointV1[]): number {
  let distance = Infinity;
  for (let index = 0; index < contour.length; index += 1) {
    distance = Math.min(
      distance,
      pointSegmentDistance(point, contour[index]!, contour[(index + 1) % contour.length]!),
    );
  }
  return distance;
}

describe("serialized pressure contour fill", () => {
  it("keeps the former short thick turn hole filled in the actual SVG commands", () => {
    const centers = [
      { x: 0, y: 0, pressure: 1 },
      { x: 0.5, y: -1, pressure: 1 },
      { x: 3, y: -1, pressure: 1 },
    ];
    const contours = sampleSvgPathContours(buildPressureOutline(centers, 22)[0]!.d);
    for (const point of [
      { x: 7.5, y: 8.5 },
      { x: 7, y: 8.5 },
      { x: 8, y: 8 },
    ]) {
      expect(
        contours.reduce((sum, contour) => sum + polygonWinding(contour, point), 0),
      ).toBeLessThan(0);
    }
  });

  it.each([2, 8, 22])(
    "preserves covered regions and limits outward error in emitted width-%s paths",
    (width) => {
      const centers = [
        { x: -8, y: -7, pressure: 0.15 },
        { x: 9, y: 8, pressure: 0.9 },
        { x: -9, y: 8, pressure: 0.4 },
        { x: 8, y: -8, pressure: 1 },
        { x: 8.5, y: -7, pressure: 0.2 },
      ];
      const ideal = idealCapsules(centers, width);
      const actual = sampleSvgPathContours(buildPressureOutline(centers, width)[0]!.d);
      // Exclude only the 0.01-unit band covering independent arc tessellation and SVG quantization.
      for (let x = -18.17; x <= 18; x += 1.13) {
        for (let y = -18.31; y <= 18; y += 1.17) {
          const point = { x, y };
          if (
            !ideal.some(
              (contour) =>
                polygonWinding(contour, point) !== 0 && boundaryDistance(point, contour) > 0.01,
            )
          )
            continue;
          expect(
            actual.reduce((sum, contour) => sum + polygonWinding(contour, point), 0),
          ).toBeLessThan(0);
        }
      }
      const limit = Math.min(0.5, width / 32) + 0.01;
      for (const contour of actual) {
        for (const point of contour) {
          if (ideal.some((reference) => polygonWinding(reference, point) !== 0)) continue;
          expect(
            Math.min(...ideal.map((reference) => boundaryDistance(point, reference))),
          ).toBeLessThanOrEqual(limit);
        }
      }
    },
  );

  it("interprets implicit relative line coordinates sequentially", () => {
    expect(sampleSvgPathContours("M0 0l10 0-2 3-4 5Z")).toEqual([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 8, y: 3 },
        { x: 4, y: 8 },
      ],
    ]);
    expect(() => sampleSvgPathContours("M0 0C1 1 2 2 3 3Z")).toThrow("Unsupported SVG command");
  });
});
