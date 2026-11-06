import { describe, expect, it } from "vitest";
import { shapeVertices } from "../../../../src/domain/geometry/creation";
import { pointDistance, rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import { recognizePentagram } from "../../../../src/domain/recognition/pentagram-recognition";
import { recognizeStrokeSteps } from "../../../../src/domain/recognition/stroke-recognition";
import type { PointV1 } from "../../../../src/domain/schema/types";

function pentagram(width: number, height: number, rotation = 0): PointV1[] {
  const pivot = { x: 230, y: 180 };
  const tips = shapeVertices({
    kind: "star",
    x: 230 - width / 2,
    y: 180 - height / 2,
    width,
    height,
  })
    .filter((_, index) => index % 2 === 0)
    .map((point) => rotatePointClockwise(point, pivot, rotation));
  return samplePolygon([0, 2, 4, 1, 3].map((index) => tips[index]!));
}

function samplePolygon(vertices: readonly PointV1[]): PointV1[] {
  const points = vertices.flatMap((start, index) => {
    const end = vertices[(index + 1) % vertices.length]!;
    return Array.from({ length: 20 }, (_, step) => ({
      x: start.x + ((end.x - start.x) * step) / 20,
      y: start.y + ((end.y - start.y) * step) / 20,
    }));
  });
  return [...points, points[0]!];
}

function shiftPath(points: readonly PointV1[], offset: number): PointV1[] {
  const open = points.slice(0, -1);
  const shifted = [...open.slice(offset), ...open.slice(0, offset)];
  return [...shifted, shifted[0]!];
}

describe("pentagram gesture recognition", () => {
  it("recognizes a noisy crossing gesture through the complete normalized stroke pipeline", () => {
    const path = shiftPath(pentagram(220, 150, 29), 7).map((point, index) => ({
      x: point.x + Math.sin(index * 1.7) * 0.8,
      y: point.y + Math.cos(index * 2.3) * 0.8,
    }));
    for (const points of [path, [...path].reverse()]) {
      const steps = recognizeStrokeSteps(
        points.flatMap((point) => [point.x, point.y, 0.5]),
        { zoom: 1 },
      );
      let step = steps.next();
      while (!step.done) step = steps.next();
      expect(step.value?.kind).toBe("star");
    }
  });

  it.each([
    [200, 200, 0, 0, false],
    [240, 130, 37, 9, false],
    [120, 250, -71, 33, true],
    [210, 170, 179, 53, true],
  ] as const)(
    "recognizes %s by %s tips at %s degrees and offset %s",
    (width, height, angle, offset, reverse) => {
      const path = shiftPath(pentagram(width, height, angle), offset);
      const shape = recognizePentagram(reverse ? path.reverse() : path, 1);
      expect(shape?.kind).toBe("star");
      expect(shape!.rotation).toBeGreaterThanOrEqual(-180);
      expect(shape!.rotation).toBeLessThan(180);
      expect(shape!.pivot.x).toBeCloseTo(shape!.x + shape!.width / 2, 2);
      expect(shape!.pivot.y).toBeCloseTo(shape!.y + shape!.height / 2, 2);
      const actual = shapeVertices(shape!)
        .filter((_, index) => index % 2 === 0)
        .map((point) => rotatePointClockwise(point, shape!.pivot, shape!.rotation));
      const expected = pentagram(width, height, angle).filter(
        (_, index) => index < 100 && index % 20 === 0,
      );
      for (const tip of expected)
        expect(Math.min(...actual.map((point) => pointDistance(point, tip)))).toBeLessThan(0.02);
    },
  );

  it("accepts one-pixel sampling noise without converting the crossing into outline vertices", () => {
    const path = shiftPath(pentagram(220, 150, 21), 7).map((point, index) => ({
      x: point.x + Math.sin(index * 2) * 0.8,
      y: point.y + Math.cos(index * 3) * 0.8,
    }));
    expect(recognizePentagram(path, 1)?.kind).toBe("star");
  });

  it("coalesces a small closing gap at one outer tip in either direction", () => {
    const path = pentagram(300, 280, 19)
      .slice(0, -1)
      .map((point, index) => ({
        x: point.x + Math.sin(index * 0.7) * 1.5,
        y: point.y + Math.cos(index * 0.9) * 1.5,
      }));
    expect(recognizePentagram(path, 1)?.kind).toBe("star");
    expect(recognizePentagram([...path].reverse(), 1)?.kind).toBe("star");
  });
});

describe("rejected pentagram gestures", () => {
  it("rejects repeated tracing and an open pentagram", () => {
    const path = pentagram(200, 180);
    expect(recognizePentagram([...path, ...path.slice(1)], 1)).toBeNull();
    expect(recognizePentagram(path.slice(0, -12), 1)).toBeNull();
  });

  it("rejects an interior detour even when all five outer tips remain correct", () => {
    const path = pentagram(240, 200);
    const start = path[0]!;
    const end = path[20]!;
    const length = pointDistance(start, end);
    const bent = path.map((point, index) => {
      const offset = index < 20 ? Math.sin((index * Math.PI) / 20) * 50 : 0;
      return {
        x: point.x - ((end.y - start.y) / length) * offset,
        y: point.y + ((end.x - start.x) / length) * offset,
      };
    });
    expect(recognizePentagram(bent, 1)).toBeNull();
  });

  it("rejects a bow tie, a pentagon, and a deformed five-tip scribble", () => {
    const bowTie = samplePolygon([
      { x: 0, y: 0 },
      { x: 200, y: 120 },
      { x: 0, y: 120 },
      { x: 200, y: 0 },
    ]);
    const tips = shapeVertices({ kind: "star", x: 0, y: 0, width: 200, height: 180 }).filter(
      (_, index) => index % 2 === 0,
    );
    const scribble = pentagram(200, 180).map((point, index) => ({
      x: point.x + (index >= 40 && index <= 60 ? 55 : 0),
      y: point.y,
    }));
    for (const path of [bowTie, samplePolygon(tips), scribble])
      expect(recognizePentagram(path, 1)).toBeNull();
  });

  it("rejects unbounded, degenerate, and invalid-scale inputs", () => {
    expect(recognizePentagram([], 1)).toBeNull();
    expect(recognizePentagram(pentagram(200, 180), 0)).toBeNull();
    expect(recognizePentagram(pentagram(2, 2), 1)).toBeNull();
    expect(
      recognizePentagram(
        Array.from({ length: 257 }, () => ({ x: 1, y: 1 })),
        1,
      ),
    ).toBeNull();
  });
});
