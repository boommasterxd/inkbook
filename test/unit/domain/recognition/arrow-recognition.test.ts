import { afterEach, describe, expect, it, vi } from "vitest";
import { recognizeArrowSteps } from "../../../../src/domain/recognition/arrow-recognition";
import {
  fitArrowHeadSteps,
  type ArrowHeadPreparation,
} from "../../../../src/domain/recognition/arrow-head-fit";
import * as geometry from "../../../../src/domain/geometry/primitives";
import type { RecognizedLinear } from "../../../../src/domain/recognition/recognition-types";
import type { PointV1 } from "../../../../src/domain/schema/types";
import { ARROW_ENDPOINT_PAIRS, arrowPath, endpointMotif } from "./arrow-fixtures";

afterEach(() => vi.restoreAllMocks());

function recognizeHead(points: readonly PointV1[], preparation?: ArrowHeadPreparation) {
  const steps = fitArrowHeadSteps(points, 1, preparation);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function prepareHeadBounds(points: readonly PointV1[]): ArrowHeadPreparation {
  return Object.freeze({ points, bounds: Object.freeze(geometry.boundsFromPoints(points)) });
}

function comparePreparedBounds(
  points: readonly PointV1[],
  preparation: ArrowHeadPreparation,
): number {
  const expected = recognizeHead(points);
  expect(expected).not.toBeNull();
  const visits = vi.spyOn(geometry, "includeBoundsPoint");
  expect(recognizeHead(points, preparation)).toEqual(expected);
  return visits.mock.calls.length;
}

function recognizeArrow(
  points: readonly PointV1[],
  fitLinear: (points: readonly PointV1[]) => RecognizedLinear | null,
): RecognizedLinear | null {
  const steps = recognizeArrowSteps(points, fitLinear);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function straightShaft(points: readonly PointV1[]): RecognizedLinear | null {
  const start = points[0];
  const end = points[points.length - 1];
  if (start === undefined || end === undefined || end.x - start.x < 60) return null;
  if (
    points.some(
      (point, index) => Math.abs(point.y) > 0.01 || point.x < (points[index - 1]?.x ?? -Infinity),
    )
  )
    return null;
  return {
    kind: "line",
    start,
    end,
    bend: null,
    startNode: "none",
    endNode: "none",
    rotation: 0,
    pivot: { x: (start.x + end.x) / 2, y: 0 },
  };
}

describe("single-path arrow recognition", () => {
  it.each(ARROW_ENDPOINT_PAIRS)("preserves independent %s and %s endpoint motifs", (start, end) => {
    expect(recognizeArrow(arrowPath(start, end), straightShaft)).toMatchObject({
      kind: "arrow",
      start: { x: 0, y: 0 },
      end: { x: 120, y: 0 },
      startNode: start,
      endNode: end,
    });
  });

  it("retains the quadratic shaft supplied by the conservative fitter", () => {
    const shaft = [
      { x: 0, y: 0 },
      { x: 30, y: -15 },
      { x: 60, y: -20 },
      { x: 90, y: -15 },
    ];
    const points = [...shaft, ...endpointMotif("triangle")];
    // The local endpoint tangent rotates the head along the curve.
    const tangent = Math.atan2(15, 30);
    for (let index = shaft.length; index < points.length; index += 1) {
      const point = points[index];
      if (point === undefined) continue;
      const dx = point.x - 120;
      points[index] = {
        x: 120 + dx * Math.cos(tangent) - point.y * Math.sin(tangent),
        y: dx * Math.sin(tangent) + point.y * Math.cos(tangent),
      };
    }
    const bend = { x: 60, y: -40 };
    const fit = (candidate: readonly PointV1[]): RecognizedLinear | null => {
      if (
        candidate.length !== 5 ||
        candidate[0]?.x !== 0 ||
        candidate[candidate.length - 1]?.x !== 120
      )
        return null;
      return {
        kind: "line",
        start: { x: 0, y: 0 },
        end: { x: 120, y: 0 },
        bend,
        rotation: 0,
        pivot: { x: 60, y: -20 },
        startNode: "none",
        endNode: "none",
      };
    };
    expect(recognizeArrow(points, fit)).toMatchObject({ bend, endNode: "triangle" });
  });

  it("rejects an unadorned line and asymmetric or incomplete endpoint scribbles", () => {
    expect(recognizeArrow(arrowPath("none", "none"), straightShaft)).toBeNull();
    const shaft = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 120, y: 0 },
    ];
    expect(recognizeArrow([...shaft, { x: 100, y: 10 }], straightShaft)).toBeNull();
    expect(
      recognizeArrow(
        [...shaft, { x: 100, y: 10 }, { x: 120, y: 0 }, { x: 100, y: -35 }],
        straightShaft,
      ),
    ).toBeNull();
  });

  it("does not accept endpoint motifs when the remaining shaft is rejected", () => {
    expect(recognizeArrow(arrowPath("diamond", "arrow"), () => null)).toBeNull();
  });
});

describe("arrow shaft fitting ownership", () => {
  it("preserves an observed tip displaced only laterally after validating the original shaft", () => {
    const head = [
      { x: 0, y: 0 },
      { x: -55, y: 35 },
      { x: 0, y: 10 },
      { x: -40, y: -50 },
    ];
    expect(recognizeHead(head)).toMatchObject({
      node: "arrow",
      extension: 0,
      lateral: 10,
      fitOriginalShaft: true,
    });
    const points = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      ...head.map((point) => ({ x: point.x + 120, y: point.y })),
    ];
    expect(recognizeArrow(points, straightShaft)).toMatchObject({
      kind: "arrow",
      end: { x: 120, y: 10 },
      pivot: { x: 60, y: 5 },
      endNode: "arrow",
    });
  });

  it("allows its owner to cancel recognition before shaft fitting", () => {
    let fits = 0;
    const steps = recognizeArrowSteps(arrowPath("circle", "circle"), () => {
      fits += 1;
      return null;
    });
    expect(steps.next().done).toBe(false);
    expect(fits).toBe(0);
    steps.return(null);
    expect(steps.next().done).toBe(true);
    expect(fits).toBe(0);
  });
});

describe("arrow contour fit termination", () => {
  it("retains the complete exact score of an accepted head", () => {
    const points = endpointMotif("arrow").map((point) => ({ x: point.x - 120, y: point.y }));
    expect(recognizeHead(points)).toEqual({ node: "arrow", error: 0, extension: 0, lateral: 0 });
  });

  it("stops bidirectional template work once the observed contour error already rejects the fit", () => {
    const vertices = [
      { x: 0, y: 0 },
      { x: -10, y: 10 },
      { x: -20, y: 10 },
      { x: 0, y: 0 },
      { x: -20, y: -10 },
    ];
    const points = vertices.flatMap((start, index) => {
      const end = vertices[index + 1];
      if (end === undefined) return [start];
      return Array.from({ length: 30 }, (_, step) => ({
        x: start.x + ((end.x - start.x) * step) / 30,
        y: start.y + ((end.y - start.y) * step) / 30,
      }));
    });
    const distance = vi.spyOn(geometry, "pointSegmentDistance");
    expect(recognizeHead(points)).toBeNull();
    // One complete two-edge comparison charges both contour and template midpoint scans.
    // Rejecting both the native and uneven templates must consume less than even one full fit.
    const oneCompleteFit = (2 * points.length - 1) * 2 + 5 * (points.length - 1);
    expect(distance.mock.calls.length).toBeGreaterThan(0);
    expect(distance.mock.calls.length).toBeLessThan(oneCompleteFit);
  });
});

describe("closed arrow marker boundary overdraw", () => {
  it.each(["circle", "diamond"] as const)(
    "recognizes a complete native %s followed by a short repeated boundary",
    (node) => {
      const loop = endpointMotif(node).map((point) => ({ x: point.x - 120, y: point.y }));
      const boundary = node === "circle" ? loop.slice(1, 6) : [loop[1]!];
      expect(recognizeHead([...loop, ...boundary])).toMatchObject({
        node,
        extension: 0,
        lateral: 0,
      });
    },
  );

  it("retains the full contour residual when an otherwise complete loop ends inside the marker", () => {
    const loop = endpointMotif("circle").map((point) => ({ x: point.x - 120, y: point.y }));
    expect(recognizeHead([...loop, { x: -10, y: 0 }])).toBeNull();
    expect(recognizeHead(loop.slice(0, -7))).toBeNull();
  });
});

describe("arrow contour bounds ownership", () => {
  it("measures an unprepared contour only once across tip and edge attachment attempts", () => {
    const points = Array.from({ length: 25 }, (_, index) => {
      const angle = (index * Math.PI) / 12;
      return { x: 10 * (1 - Math.cos(angle)), y: 10 * Math.sin(angle) };
    });
    const visits = vi.spyOn(geometry, "includeBoundsPoint");
    expect(recognizeHead(points)).toMatchObject({ node: "circle", extension: 20 });
    expect(visits).toHaveBeenCalledTimes(points.length);
  });

  it.each(["arrow", "triangle", "diamond", "circle"] as const)(
    "reuses prepared %s bounds without changing the complete fit",
    (node) => {
      const points = endpointMotif(node).map((point) => ({ x: point.x - 120, y: point.y }));
      expect(comparePreparedBounds(points, prepareHeadBounds(points))).toBe(0);
    },
  );

  it("measures a newly aligned contour instead of reusing bounds from the old coordinate frame", () => {
    const points = [
      { x: 0, y: 0 },
      { x: -20, y: 10 },
      { x: 0, y: 0 },
      { x: -20, y: -4 },
    ];
    expect(comparePreparedBounds(points, prepareHeadBounds(points))).toBe(points.length);
  });

  it("ignores prepared bounds owned by a different contour", () => {
    const points = endpointMotif("arrow").map((point) => ({ x: point.x - 120, y: point.y }));
    const other = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(comparePreparedBounds(points, prepareHeadBounds(other))).toBe(points.length);
  });
});
