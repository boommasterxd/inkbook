import type { StrokeElementV1 } from "../../../src/domain/schema/public";

export function indexedStroke(index: number): StrokeElementV1 {
  const x = 20 + (index % 100) * 10;
  const y = 20 + Math.floor(index / 100) * 10;
  return {
    createdAt: index,
    id: `00000000-0000-4000-8000-${String(index + 1_000).padStart(12, "0")}`,
    kind: "stroke",
    pivot: { x, y },
    points: [x, y, 0.5],
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
