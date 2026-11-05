import { samplesFromTrace, tracePolyline } from "./trace-primitives";
import type { CorpusSplit, RecognitionExample, TracePoint } from "./types";

export interface LineRecipe {
  name: string;
  line: "straight" | "curved";
  control?: TracePoint;
  arc?: number;
  waypoints?: readonly TracePoint[];
  wave?: number;
  reverse?: boolean;
  uneven?: boolean;
  angle?: number;
  endpoint?: number;
}

function curvedTrace(recipe: LineRecipe): TracePoint[] {
  return Array.from({ length: 151 }, (_, index): TracePoint => {
    const raw = index / 150;
    const t = recipe.uneven ? raw ** 1.31 : raw;
    const wobble = (recipe.wave ?? 1.8) * Math.sin(t * 13 + 0.3) * Math.sin(t * Math.PI);
    if (recipe.arc !== undefined) {
      const angle = Math.PI + t * recipe.arc;
      return [122 + 122 * Math.cos(angle), 122 * Math.sin(angle) + wobble];
    }
    const [cx, cy] = recipe.control ?? [125, 70];
    return [2 * (1 - t) * t * cx + t * t * 250, 2 * (1 - t) * t * cy + wobble];
  });
}

export function lineExample(recipe: LineRecipe, split: CorpusSplit): RecognitionExample {
  let points =
    recipe.waypoints === undefined
      ? curvedTrace(recipe)
      : tracePolyline(recipe.waypoints, {
          wave: recipe.wave ?? 1.8,
          uneven: recipe.uneven ?? false,
        });
  if (recipe.endpoint !== undefined) {
    points = points.map(([x, y], index): TracePoint => {
      const t = index / (points.length - 1);
      return [x, y + recipe.endpoint! * Math.exp(-20 * t) * Math.sin(18 * t)];
    });
  }
  if (recipe.reverse) points.reverse();
  return {
    id: `${split}-line-${recipe.name}`,
    kind: "line",
    variation: recipe.name,
    split,
    samples: samplesFromTrace(points, recipe.angle),
    expected: { kinds: ["line"], line: recipe.line },
  };
}
