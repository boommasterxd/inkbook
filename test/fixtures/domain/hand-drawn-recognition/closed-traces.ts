import {
  roundClosedCorners,
  samplesFromTrace,
  startClosedTrace,
  tracePolyline,
} from "./trace-primitives";
import type { CorpusSplit, RecognitionExample, RecognitionKind, TracePoint } from "./types";

export type PolygonKind = Exclude<RecognitionKind, "line" | "arrow" | "ellipse">;

export interface PolygonRecipe {
  name: string;
  start?: number;
  reverse?: boolean;
  round?: number;
  wave?: number;
  skew?: number;
  corner?: number;
  gap?: number;
  overrun?: number;
  uneven?: boolean;
  angle?: number;
  square?: boolean;
  retrace?: boolean;
}

const CORNER_DRIFT: readonly TracePoint[] = [
  [-0.7, 0.4],
  [0.3, -0.8],
  [0.9, 0.2],
  [-0.4, 0.7],
  [0.5, -0.3],
];

export const POLYGON_KINDS: readonly PolygonKind[] = [
  "rectangle",
  "triangle",
  "star",
  "octagon",
  "parallelogram",
  "diamond",
];

function verticesFor(kind: PolygonKind, square: boolean): TracePoint[] {
  if (kind === "rectangle")
    return [
      [-110, -73],
      [110, -73],
      [110, square ? 147 : 73],
      [-110, square ? 147 : 73],
    ];
  if (kind === "triangle")
    return [
      [0, -110],
      [112, 82],
      [-112, 82],
    ];
  if (kind === "diamond")
    return [
      [0, square ? -110 : -82],
      [110, 0],
      [0, square ? 110 : 82],
      [-110, 0],
    ];
  if (kind === "parallelogram")
    return [
      [-65, -80],
      [125, -80],
      [65, 80],
      [-125, 80],
    ];
  if (kind === "octagon")
    return [
      [-64, -105],
      [64, -105],
      [110, -59],
      [110, 59],
      [64, 105],
      [-64, 105],
      [-110, 59],
      [-110, -59],
    ];
  return Array.from({ length: 10 }, (_, index): TracePoint => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = index % 2 === 0 ? 118 : 53;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
}

export function polygonExample(
  kind: PolygonKind,
  recipe: PolygonRecipe,
  split: CorpusSplit,
): RecognitionExample {
  const vertices = verticesFor(kind, recipe.square ?? false).map(([x, y], index): TracePoint => {
    const drift = CORNER_DRIFT[index % CORNER_DRIFT.length]!;
    return [
      x + y * (recipe.skew ?? 0) + drift[0] * (recipe.corner ?? 2.5),
      y + drift[1] * (recipe.corner ?? 2.5),
    ];
  });
  const contour =
    recipe.round === undefined ? vertices : roundClosedCorners(vertices, recipe.round);
  let points = tracePolyline([...contour, contour[0]!], {
    wave: recipe.wave ?? 2,
    uneven: recipe.uneven ?? false,
  });
  points = startClosedTrace(points, recipe.start ?? 0);
  if (recipe.reverse) points.reverse();
  if (recipe.retrace)
    points = [...points.slice(0, 7), ...points.slice(2, 7).reverse(), ...points.slice(3)];
  if (recipe.gap !== undefined)
    points = points.slice(0, -Math.max(1, Math.round(points.length * recipe.gap)));
  if (recipe.overrun !== undefined)
    points.push(...points.slice(1, Math.max(2, Math.round(points.length * recipe.overrun))));
  const kinds: RecognitionKind[] =
    recipe.square && (kind === "rectangle" || kind === "diamond")
      ? ["rectangle", "diamond"]
      : [kind];
  // Shearing a rhombus leaves the equal-side family; both native fits may explain this intent.
  if (kind === "diamond" && recipe.skew !== undefined && recipe.skew !== 0)
    kinds.push("parallelogram");
  return {
    id: `${split}-${kind}-${recipe.name}`,
    kind,
    variation: recipe.name,
    split,
    samples: samplesFromTrace(points, recipe.angle),
    expected: { kinds },
  };
}
