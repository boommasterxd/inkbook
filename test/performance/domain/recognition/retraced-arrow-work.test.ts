import { afterEach, expect, it, vi } from "vitest";
import * as geometry from "../../../../src/domain/geometry/primitives";
import * as headFitting from "../../../../src/domain/recognition/arrow-head-fit";
import { recognizeArrowSteps } from "../../../../src/domain/recognition/arrow-recognition";
import { recognizeLinear } from "../../../../src/domain/recognition/linear-recognition";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { edgeArrowPath } from "../../../unit/domain/recognition/edge-arrow-fixtures";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("bounds a maximum normalized retraced tip with tail hook=%s", (hook) => {
  const vertices = [
    { x: 0, y: 0 },
    { x: -55, y: 35 },
    { x: 12, y: -3 },
    { x: -40, y: -50 },
  ];
  if (hook) vertices.push({ x: -28, y: -52 });
  const points = vertices.flatMap((start, index) => {
    const end = vertices[index + 1];
    if (end === undefined) return [start];
    const count = hook ? (index === 3 ? 63 : 64) : 85;
    return Array.from({ length: count }, (_, step) => ({
      x: start.x + ((end.x - start.x) * step) / count,
      y: start.y + ((end.y - start.y) * step) / count,
    }));
  });
  const distance = vi.spyOn(geometry, "pointSegmentDistance");
  const cancelled = headFitting.fitArrowHeadSteps(points, 1);
  expect(cancelled.next().done).toBe(false);
  expect(distance).not.toHaveBeenCalled();
  cancelled.return(null);
  expect(cancelled.next().done).toBe(true);
  expect(distance).not.toHaveBeenCalled();

  const result = finishGeometrySteps(headFitting.fitArrowHeadSteps(points, 1));
  expect(result).toMatchObject({ node: "arrow", extension: 12, lateral: -3 });
  expect(distance.mock.calls.length).toBeGreaterThan(points.length);
  const templateWork = 9 * points.length - 7;
  // Each two-segment template costs 2(2m-1) forward and 5(m-1) reverse segment visits.
  // The hook needs at most one additional angle-constrained template, within the same residual.
  expect(distance.mock.calls.length).toBeLessThanOrEqual(templateWork * (hook ? 2 : 1));
  if (hook) expect(distance.mock.calls.length).toBeGreaterThan(templateWork);
});

it("bounds translated closed-marker templates on a maximum normalized side-attached loop", () => {
  const points = Array.from({ length: 256 }, (_, index) => {
    const angle = Math.PI / 2 + (index * 2 * Math.PI) / 255;
    return { x: 20 * Math.cos(angle), y: -20 + 20 * Math.sin(angle) };
  });
  const distance = vi.spyOn(geometry, "pointSegmentDistance");
  const result = finishGeometrySteps(headFitting.fitArrowHeadSteps(points, 1));
  expect(result).toMatchObject({ node: "circle", fitOriginalShaft: true });
  expect(result?.extension).toBeCloseTo(20, 1);
  expect(result?.lateral).toBeCloseTo(-20, 1);
  expect(distance.mock.calls.length).toBeGreaterThan(points.length * 32);
  // Triangle and Diamond each have native/uneven templates (13m, 17m); Circle costs 129m.
  expect(distance.mock.calls.length).toBeLessThanOrEqual((2 * 13 + 2 * 17 + 129) * points.length);
});

it("bounds complete-loop discovery and cancels a maximum normalized marker with boundary overdraw", () => {
  const points = Array.from({ length: 256 }, (_, index) => {
    const angle = (index * 2.4 * Math.PI) / 255;
    return { x: 20 * (Math.cos(angle) - 1), y: 20 * Math.sin(angle) };
  });
  const visits = vi.spyOn(geometry, "pointDistance");
  const segments = vi.spyOn(geometry, "pointSegmentDistance");
  const cancelled = headFitting.fitArrowHeadSteps(points, 1);
  expect(cancelled.next().done).toBe(false);
  expect(visits.mock.calls.length).toBeGreaterThan(points.length);
  expect(visits.mock.calls.length).toBeLessThanOrEqual(3 * points.length);
  expect(segments).not.toHaveBeenCalled();
  const admitted = visits.mock.calls.length;
  cancelled.return(null);
  expect(cancelled.next().done).toBe(true);
  expect(visits).toHaveBeenCalledTimes(admitted);

  visits.mockClear();
  const result = finishGeometrySteps(headFitting.fitArrowHeadSteps(points, 1));
  expect(result).toMatchObject({ node: "circle", extension: 0, lateral: 0 });
  // Charge source length, seam discovery and the monotone repeated-boundary walk,
  // including both its segment reads and relative contour comparisons, then 32 circle edges.
  expect(visits.mock.calls.length).toBeLessThanOrEqual(3 * points.length + 32);
  expect(segments.mock.calls.length).toBeLessThanOrEqual(
    (2 * 9 + 2 * 13 + 2 * 17 + 129) * points.length,
  );
});

it("bounds native attachment search and shaft fits for maximum normalized boundary overdraw", () => {
  const path = edgeArrowPath("circle", "diamond", true);
  const vertices = [...path.slice(32, 40), ...path, ...path.slice(-32, -26)];
  const points = Array.from({ length: 256 }, (_, index) => {
    const position = (index * (vertices.length - 1)) / 255;
    const edge = Math.min(vertices.length - 2, Math.floor(position));
    const start = vertices[edge]!;
    const end = vertices[edge + 1]!;
    const t = position - edge;
    return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
  });
  const heads = vi.spyOn(headFitting, "fitArrowHeadSteps");
  const fit = vi.fn(recognizeLinear);
  const result = finishGeometrySteps(recognizeArrowSteps(points, fit));
  expect(result).toMatchObject({ kind: "arrow", startNode: "circle", endNode: "diamond" });
  // Two endpoints, each with four local tangent windows at every eligible cut.
  expect(heads.mock.calls.length).toBeGreaterThan(0);
  expect(heads.mock.calls.length).toBeLessThanOrEqual(2 * (points.length - 4) * 4);
  // Six retained heads per endpoint plus its absent marker, excluding none/none.
  expect(fit.mock.calls.length).toBeGreaterThan(0);
  expect(fit.mock.calls.length).toBeLessThanOrEqual(48);
});
