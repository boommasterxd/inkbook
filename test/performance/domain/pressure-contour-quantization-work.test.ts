import { describe, expect, it, vi } from "vitest";
import { iteratePressureContourQuantization } from "../../../src/domain/geometry/pressure-contour-quantization";
import type { PointV1 } from "../../../src/domain/schema/types";
import { finishGeometrySteps } from "../../fixtures/domain/geometry-steps";
import { referencePressureQuantization } from "../../fixtures/domain/pressure-quantization-reference";

const points: readonly PointV1[] = Array.from({ length: 4095 }, (_, index) => {
  const angle = (-2 * Math.PI * index) / 4095;
  return { x: Math.cos(angle) * 1024 + 0.137, y: Math.sin(angle) * 1024 - 0.251 };
});
const closed = [...points, points[0]!];

describe("bounded pressure contour quantization work", () => {
  it("rejects impossible candidates before distance calculations at polyline capacity", () => {
    let reads = 0;
    const observed = points.map((point) => ({
      get x() {
        reads += 1;
        return point.x;
      },
      get y() {
        reads += 1;
        return point.y;
      },
    }));
    const distances = vi.spyOn(Math, "hypot");
    try {
      const expected = referencePressureQuantization(closed, 0.1);
      expect(distances).toHaveBeenCalledTimes(points.length * 16);
      distances.mockClear();
      const count = { count: 0 };
      const result = finishGeometrySteps(
        iteratePressureContourQuantization([...observed, observed[0]!], 0.1, count),
      );
      // Legacy evaluates all 16 candidates per vertex. Bounds and unchanged side products
      // reject at least half before the expensive exact Euclidean calculation.
      expect(distances.mock.calls.length).toBeGreaterThan(points.length);
      expect(distances.mock.calls.length).toBeLessThanOrEqual(points.length * 8);
      // Original immutable coordinates are prepared once; generated candidate arithmetic
      // and quantized survivor reads are outside this source-scalar counter.
      expect(reads).toBeLessThanOrEqual(points.length * 16);
      expect(result).toEqual(expected.points);
      expect(count.count).toBe(expected.additions.length);
    } finally {
      distances.mockRestore();
    }
  });

  it("cancels candidate preparation at the existing checkpoint without further distance work", () => {
    const distances = vi.spyOn(Math, "hypot");
    try {
      const additions: (readonly PointV1[])[] = [];
      const job = iteratePressureContourQuantization(closed, 0.1, additions);
      while (distances.mock.calls.length === 0) expect(job.next().done).toBe(false);
      const completed = distances.mock.calls.length;
      expect(completed).toBeLessThanOrEqual(16 * 8);
      job.return([]);
      expect(job.next()).toEqual({ done: true, value: undefined });
      expect(distances).toHaveBeenCalledTimes(completed);
      // The caller owns staging; cancellation never mutates the original contour.
      expect(closed).toHaveLength(4096);
    } finally {
      distances.mockRestore();
    }
  });
});
