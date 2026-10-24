import type { RawStrokeSample } from "../../../src/domain/geometry/public";
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

export function denseWaveSamples(): readonly RawStrokeSample[] {
  return Array.from({ length: 900 }, (_, index) => ({
    x: (100 * index) / 899,
    y: 20 * Math.sin((6 * Math.PI * index) / 899),
    pressure: 0.6,
    time: index,
  }));
}

export function tightPressureLoopSamples(count = 1536, turns = 12): RawStrokeSample[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (2 * turns * Math.PI * index) / (count - 1);
    return {
      x: 400 + 8 * Math.sin(angle),
      y: 250 - 6 * Math.cos(angle),
      pressure: 0.2 + 0.65 * (0.5 - 0.5 * Math.cos(angle / 3)),
      time: (index * 1000) / 240,
    };
  });
}
