import { afterEach, expect, it, vi } from "vitest";
import * as geometry from "../../../../src/domain/geometry/primitives";
import {
  fitClosedShape,
  prepareClosedPath,
} from "../../../../src/domain/recognition/closed-shape-fit";
import { observeSchemaArray } from "../../../fixtures/domain/schema-array-work";
import { maximumRectangle } from "../../../unit/domain/recognition/recognition-fixtures";

afterEach(() => vi.restoreAllMocks());

it("bounds actual rectangle side reads and reuses prepared rotations at normalized capacity", () => {
  const source = maximumRectangle(256);
  const points = Array.from({ length: 256 }, (_, index) => ({
    x: source[index * 3]! + Math.sin(index) * 0.5,
    y: source[index * 3 + 1]! + Math.cos(index) * 0.5,
  }));
  const prepared = prepareClosedPath(points, 0)!;
  const { observed, work } = observeSchemaArray(prepared.local);
  const pivot = vi.spyOn(geometry, "rotatePointClockwise");
  const rotation = vi.spyOn(geometry, "rotatePointsClockwise");
  const fit = fitClosedShape({ ...prepared, local: observed }, "rectangle", 40);
  expect(fit).toMatchObject({ shape: { kind: "rectangle" } });
  expect(fit!.maxError).toBeLessThan(0.01);
  // One traced-side pass and one contour metric; seam checks may read both ends once.
  expect(work.indexedReads).toBeGreaterThan(points.length);
  expect(work.indexedReads).toBeLessThanOrEqual(2 * points.length + 2);
  expect(pivot).toHaveBeenCalledOnce();
  expect(rotation).not.toHaveBeenCalled();
});
