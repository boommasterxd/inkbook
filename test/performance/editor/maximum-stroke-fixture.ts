import type { StrokeElementV1 } from "../../../src/domain/schema/public";

const MAXIMUM_POINTS = 4_096;

export function maximumStroke(index: number): StrokeElementV1 {
  const points: number[] = [];
  for (let point = 0; point < MAXIMUM_POINTS; point += 1) {
    points.push(point, point === MAXIMUM_POINTS - 1 ? 0 : 100 + index * 0.001, 0.5);
  }
  Object.freeze(points);
  return {
    createdAt: index,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    kind: "stroke",
    pivot: { x: MAXIMUM_POINTS / 2, y: 50 },
    points,
    rotation: 0,
    style: {
      color: { type: "theme-text" },
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 2,
    },
    tool: "pen",
  };
}
