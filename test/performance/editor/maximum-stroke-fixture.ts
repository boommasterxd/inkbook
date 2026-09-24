import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import type { StrokeElementV1 } from "../../../src/domain/schema/public";

export function maximumStroke(
  index: number,
  points: StrokeElementV1["points"] = maximumStrokePoints(index),
): StrokeElementV1 {
  return {
    createdAt: index,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    kind: "stroke",
    pivot: { x: MAX_STROKE_POINTS / 2, y: 50 },
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

function maximumStrokePoints(index: number): StrokeElementV1["points"] {
  const points: number[] = [];
  for (let point = 0; point < MAX_STROKE_POINTS; point += 1) {
    points.push(point, point === MAX_STROKE_POINTS - 1 ? 0 : 100 + index * 0.001, 0.5);
  }
  Object.freeze(points);
  return points;
}
