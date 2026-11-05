import type { PointV1 } from "../../../../src/domain/schema/types";

// Unequal sides, hand-rounded corners and different closing seams, beginning within an edge.
export const ROUGH_RECTANGLES = [
  [
    [78, 2],
    [149, 0],
    [177, 4],
    [186, 13],
    [188, 38],
    [187, 85],
    [180, 104],
    [164, 109],
    [100, 108],
    [22, 111],
    [5, 105],
    [-1, 90],
    [1, 52],
    [0, 15],
    [8, 5],
    [29, 1],
    [40, 2],
  ],
  [
    [44, 2],
    [81, 0],
    [102, 5],
    [108, 15],
    [105, 68],
    [108, 96],
    [97, 107],
    [63, 105],
    [14, 108],
    [2, 97],
    [-1, 51],
    [1, 14],
    [8, 4],
    [44, 0],
    [65, 1],
  ],
  [
    [75, 0],
    [166, 2],
    [182, 9],
    [186, 49],
    [190, 92],
    [183, 111],
    [143, 116],
    [53, 113],
    [8, 114],
    [-4, 100],
    [-2, 72],
    [1, 15],
    [10, 3],
    [58, -2],
  ],
] as const;

export const BROAD_ROUNDED_LOOP = [
  [80, 0],
  [135, 1],
  [160, 6],
  [179, 19],
  [184, 39],
  [184, 75],
  [177, 98],
  [154, 112],
  [120, 117],
  [37, 116],
  [14, 105],
  [0, 86],
  [-3, 48],
  [2, 22],
  [13, 8],
  [35, 1],
  [69, 0],
] as const;

export function roughRectanglePath(vertices: readonly (readonly [number, number])[]): PointV1[] {
  return vertices.flatMap(([x, y], index) => {
    const next = vertices[index + 1];
    if (next === undefined) return [{ x, y }];
    const count = Math.max(2, Math.ceil(Math.hypot(next[0] - x, next[1] - y) / 3));
    return Array.from({ length: count }, (_, sample) => {
      const t = sample / count;
      const wobble = Math.sin(Math.PI * t) * Math.sin(index * 1.7 + t * 5) * 1.3;
      return { x: x + (next[0] - x) * t + wobble, y: y + (next[1] - y) * t - wobble * 0.7 };
    });
  });
}
