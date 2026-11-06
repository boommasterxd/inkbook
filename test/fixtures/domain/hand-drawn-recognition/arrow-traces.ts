import type { ArrowNodeV1 } from "../../../../src/domain/schema/types";
import { samplesFromTrace, tracePolyline } from "./trace-primitives";
import type { CorpusSplit, RecognitionExample, TracePoint } from "./types";

export interface ArrowRecipe {
  name: string;
  start: ArrowNodeV1;
  end: ArrowNodeV1;
  attachment?: "tip" | "edge" | "rear";
  bend?: number;
  wave?: number;
  headWave?: number;
  returnOffset?: number;
  unequal?: number;
  reverse?: boolean;
  uneven?: boolean;
  angle?: number;
  headScale?: number;
}

function headContour(node: ArrowNodeV1, recipe: ArrowRecipe): TracePoint[] {
  if (node === "none") return [[0, 0]];
  const imbalance = recipe.unequal ?? 1.17;
  const upper: TracePoint = [-41, 23 * imbalance];
  const lower: TracePoint = [-44 * imbalance, -22];
  const tip: TracePoint = [0, 0];
  const offset = recipe.returnOffset ?? 1.8;
  if (node === "arrow") return [tip, upper, [offset, -offset * 0.65], lower];
  if (node === "circle") {
    const phase = recipe.attachment === "edge" ? Math.PI / 2 : Math.PI;
    return Array.from({ length: 65 }, (_, index): TracePoint => {
      const angle = phase + (index * Math.PI) / 32;
      const ripple = 0.9 * Math.sin(angle * 3 + 0.4);
      return [-22 + (22 + ripple) * Math.cos(angle), (21 * imbalance + ripple) * Math.sin(angle)];
    });
  }
  if (node === "triangle") {
    if (recipe.attachment === "edge" || recipe.attachment === "rear") {
      const attachment: TracePoint = [(upper[0] + lower[0]) / 2, (upper[1] + lower[1]) / 2];
      return [attachment, lower, tip, upper, attachment];
    }
    return [tip, upper, lower, tip];
  }
  const top: TracePoint = [-23, 24 * imbalance];
  const back: TracePoint = [-49, 1.2];
  const bottom: TracePoint = [-26 * imbalance, -22];
  if (recipe.attachment === "edge") return [top, back, bottom, tip, top];
  if (recipe.attachment === "rear") return [back, bottom, tip, top, back];
  return [tip, top, back, bottom, tip];
}

function endpointTrace(node: ArrowNodeV1, recipe: ArrowRecipe, start: boolean): TracePoint[] {
  const vertices = headContour(node, recipe);
  const attachment = vertices[0]!;
  const contour =
    node === "none"
      ? vertices
      : tracePolyline(vertices, {
          wave: recipe.headWave ?? 1.1,
          uneven: recipe.uneven ?? false,
        });
  const tangentY = -(2 * (recipe.bend ?? 0)) / 340;
  const tangentX = start ? -1 : 1;
  const length = Math.hypot(tangentX, tangentY);
  const dx = tangentX / length;
  const dy = tangentY / length;
  const scale = recipe.headScale ?? 1;
  const placed = contour.map(([x, y]): TracePoint => [
    (start ? 0 : 340) + scale * ((x - attachment[0]) * dx - (y - attachment[1]) * dy),
    scale * ((x - attachment[0]) * dy + (y - attachment[1]) * dx),
  ]);
  return start ? placed.reverse() : placed;
}

export function arrowExample(recipe: ArrowRecipe, split: CorpusSplit): RecognitionExample {
  const shaft = Array.from({ length: 141 }, (_, index): TracePoint => {
    const raw = index / 140;
    const t = recipe.uneven ? raw ** 1.23 : raw;
    const wobble =
      (recipe.wave ?? 2.8) * (Math.sin(t * 17) + 0.42 * Math.sin(t * 29)) * Math.sin(Math.PI * t);
    return [340 * t, 2 * t * (1 - t) * (recipe.bend ?? 0) + wobble];
  });
  let points = [
    ...endpointTrace(recipe.start, recipe, true),
    ...shaft.slice(1, -1),
    ...endpointTrace(recipe.end, recipe, false),
  ];
  if (recipe.reverse) points = points.reverse();
  return {
    id: `${split}-arrow-${recipe.name}`,
    kind: "arrow",
    variation: recipe.name,
    split,
    samples: samplesFromTrace(points, recipe.angle),
    expected: {
      kinds: ["arrow"],
      line: recipe.bend === undefined || recipe.bend === 0 ? "straight" : "curved",
      startNode: recipe.reverse ? recipe.end : recipe.start,
      endNode: recipe.reverse ? recipe.start : recipe.end,
    },
  };
}
