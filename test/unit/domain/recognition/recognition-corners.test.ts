import { describe, expect, it } from "vitest";
import {
  mergeRecognitionCorners,
  retainRecognitionCorner,
  type PositionedRecognitionPath,
  type RecognitionCorner,
} from "../../../../src/domain/recognition/recognition-corners";

function corner(position: number, salience = 1): RecognitionCorner {
  return { point: { x: position, y: salience }, position, salience };
}

describe("recognition corner retention", () => {
  it("keeps a late strong tip after early weak turns fill the budget", () => {
    const corners: RecognitionCorner[] = [];
    for (let position = 0; position < 24; position += 1)
      retainRecognitionCorner(corners, corner(position, position + 1));
    const lateTip = corner(90, 50);
    retainRecognitionCorner(corners, lateTip);
    retainRecognitionCorner(corners, corner(100, 0.5));
    expect(corners).toHaveLength(24);
    expect(corners).toContain(lateTip);
    expect(corners.map((entry) => entry.position).sort((a, b) => a - b)).toEqual([
      ...Array.from({ length: 23 }, (_, index) => index + 1),
      90,
    ]);
  });

  it("resolves equal strengths by earlier arc position regardless of insertion order", () => {
    const corners: RecognitionCorner[] = [];
    for (let position = 30; position >= 0; position -= 1)
      retainRecognitionCorner(corners, corner(position));
    retainRecognitionCorner(corners, corner(40));
    expect(corners).toHaveLength(24);
    expect(corners.map((entry) => entry.position).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    );
  });
});

describe("positioned recognition corner merge", () => {
  it("merges full-capacity samples and unsorted corners with their original arc positions", () => {
    const path: PositionedRecognitionPath = {
      points: Array.from({ length: 225 }, (_, index) => ({ x: index * 2, y: 0 })),
      positions: Array.from({ length: 225 }, (_, index) => index * 2),
    };
    const corners = Array.from({ length: 24 }, (_, index) => corner(47 - index * 2));
    const originalPath = structuredClone(path);
    const originalCorners = structuredClone(corners);
    const result = mergeRecognitionCorners(path, corners);
    expect(result.points).toHaveLength(249);
    expect(result.positions).toEqual([
      ...Array.from({ length: 49 }, (_, index) => index),
      ...Array.from({ length: 200 }, (_, index) => 50 + index * 2),
    ]);
    for (let index = 0; index < result.points.length; index += 1)
      expect(result.points[index]!.x).toBe(result.positions[index]);
    expect(path).toEqual(originalPath);
    expect(corners).toEqual(originalCorners);
  });

  it("prefers a retained raw corner over an interpolated sample at the same position", () => {
    const path = {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      positions: [0, 1, 2],
    };
    const retained = corner(1, 3);
    expect(mergeRecognitionCorners(path, [retained, corner(1, 2)])).toEqual({
      points: [path.points[0], retained.point, path.points[2]],
      positions: [0, 1, 2],
    });
  });

  it("deduplicates consecutive coordinates while preserving the surviving sample's position", () => {
    const path = {
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
      ],
      positions: [0, 3],
    };
    const corners = [
      { point: { x: 0, y: 0 }, position: 1, salience: 2 },
      { point: { x: 1, y: 0 }, position: 2, salience: 3 },
    ];
    expect(mergeRecognitionCorners(path, corners)).toEqual({
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      positions: [0, 2, 3],
    });
  });

  it("handles a path without retained corners and a corner-only path", () => {
    const path = { points: [{ x: 2, y: 4 }], positions: [0] };
    const result = mergeRecognitionCorners(path, []);
    expect(result).toEqual(path);
    expect(result.points).not.toBe(path.points);
    expect(result.positions).not.toBe(path.positions);
    const retained = corner(4);
    expect(mergeRecognitionCorners({ points: [], positions: [] }, [retained])).toEqual({
      points: [retained.point],
      positions: [4],
    });
  });
});
