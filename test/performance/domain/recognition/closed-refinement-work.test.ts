import { afterEach, expect, it, vi } from "vitest";
import * as creation from "../../../../src/domain/geometry/creation";
import { refinePolygonBoundsSteps } from "../../../../src/domain/recognition/closed-contour-fit";
import { closedContourCorners } from "../../../../src/domain/recognition/closed-contour-corners";
import { fitClosedSides } from "../../../../src/domain/recognition/closed-side-fit";
import * as geometry from "../../../../src/domain/geometry/primitives";
import { observeSchemaArray } from "../../../fixtures/domain/schema-array-work";
import * as corners from "../../../../src/domain/recognition/closed-contour-corners";
import { recognizePentagram } from "../../../../src/domain/recognition/pentagram-recognition";

afterEach(() => vi.restoreAllMocks());

it("avoids an identical fine and coarse RDP search for a small supported contour", () => {
  const points = normalizedContour("octagon").map((point) => ({ x: point.x / 8, y: point.y / 8 }));
  const simplify = vi.spyOn(corners, "closedContourCorners");
  expect(recognizePentagram(points, 1)).toBeNull();
  expect(simplify).toHaveBeenCalledTimes(1);
});

function normalizedContour(kind: "star" | "octagon" | "parallelogram") {
  const vertices = creation.shapeVertices({ kind, x: 10, y: 20, width: 180, height: 150 });
  return Array.from({ length: 256 }, (_, index) => {
    const position = (index / 255) * vertices.length;
    const edge = Math.min(vertices.length - 1, Math.floor(position));
    const t = position - edge;
    const start = vertices[edge]!;
    const end = vertices[(edge + 1) % vertices.length]!;
    return {
      x: start.x + (end.x - start.x) * t + Math.sin(index) * 0.25,
      y: start.y + (end.y - start.y) * t + Math.cos(index) * 0.25,
    };
  });
}

it.each([false, true])("bounds native polygon refinement and cancellation=%s", (cancel) => {
  const points = normalizedContour("star");
  const bounds = geometry.boundsFromPoints(points);
  const source = observeSchemaArray(points);
  const edgeReads: { edges: number; reads: () => number }[] = [];
  const original = creation.shapeVertices;
  vi.spyOn(creation, "shapeVertices").mockImplementation((shape) => {
    const native = original(shape);
    const probe = observeSchemaArray(native);
    edgeReads.push({ edges: native.length, reads: () => probe.work.indexedReads });
    return probe.observed;
  });
  const steps = refinePolygonBoundsSteps(source.observed, bounds, "star");
  expect(steps.next().done).toBe(false);
  expect(source.work.indexedReads).toBe(points.length);
  if (cancel) steps.return(bounds);
  else {
    expect(steps.next().done).toBe(false);
    expect(steps.next()).toMatchObject({ done: true });
  }
  const passes = cancel ? 1 : 2;
  expect(edgeReads).toHaveLength(passes);
  expect(source.work.indexedReads).toBe(points.length * passes);
  // Every source point visits each native edge once, plus the initial closest-point seed.
  expect(edgeReads.every((probe) => probe.reads() <= (2 * probe.edges + 2) * points.length)).toBe(
    true,
  );
  expect(steps.next().done).toBe(true);
  expect(source.work.indexedReads).toBe(points.length * passes);
});

it.each([0, 16])("bounds the eight-corner search with a contour seam at sample %s", (start) => {
  const ring = normalizedContour("octagon").slice(0, -1);
  const points = [...ring.slice(start), ...ring.slice(0, start), ring[start]!];
  const distance = vi.spyOn(geometry, "pointSegmentDistance");
  expect(closedContourCorners(points, 5)).toHaveLength(8);
  expect(distance.mock.calls.length).toBeGreaterThan(points.length);
  // Eight real corners plus a side start and duplicate end may transiently require ten indices.
  expect(distance.mock.calls.length).toBeLessThanOrEqual(points.length * 10 + 9);
  expect(points).toHaveLength(256);
});

it.each([0, 100_000])("fits four side interiors with bounded work at page offset %s", (offset) => {
  const points = normalizedContour("parallelogram").map((point) => ({
    x: point.x + offset,
    y: point.y + offset,
  }));
  const corners = creation.shapeVertices({
    kind: "parallelogram",
    x: 10 + offset,
    y: 20 + offset,
    width: 180,
    height: 150,
  });
  const source = observeSchemaArray(points);
  const clamp = vi.spyOn(Math, "min");
  const distance = vi.spyOn(Math, "hypot");
  const fitted = fitClosedSides(source.observed, corners);
  const clamps = clamp.mock.calls.length;
  const distances = distance.mock.calls.length;
  expect(fitted).not.toBeNull();
  expect(fitted!.corners).toHaveLength(4);
  expect(fitted!.uncertainty).toBeLessThan(1);
  for (const [index, point] of fitted!.corners.entries())
    expect(geometry.pointDistance(point, corners[index]!)).toBeLessThan(2);
  expect(source.work.indexedReads).toBe(points.length * 2);
  // Four production segment-projection clamps and one next-sample clamp per input point.
  expect(clamps).toBe(points.length * 5);
  expect(distances).toBeLessThanOrEqual(points.length + 4);
});
