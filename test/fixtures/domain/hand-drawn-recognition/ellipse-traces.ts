import { samplesFromTrace } from "./trace-primitives";
import type { CorpusSplit, RecognitionExample, TracePoint } from "./types";

export interface EllipseRecipe {
  name: string;
  phase?: number;
  reverse?: boolean;
  egg?: number;
  flat?: number;
  wave?: number;
  gap?: number;
  overrun?: number;
  uneven?: boolean;
  nearCircle?: boolean;
  angle?: number;
  drift?: number;
}

export function ellipseExample(recipe: EllipseRecipe, split: CorpusSplit): RecognitionExample {
  const count = 241;
  const progress = 1 - (recipe.gap ?? 0) + (recipe.overrun ?? 0);
  const points = Array.from({ length: count }, (_, index): TracePoint => {
    const raw = index / (count - 1);
    const t = recipe.uneven ? raw + 0.065 * Math.sin(raw * 2 * Math.PI) : raw;
    const angle = (recipe.phase ?? 0) + (recipe.reverse ? -1 : 1) * t * progress * 2 * Math.PI;
    const hand =
      (recipe.wave ?? 1.8) * (0.63 * Math.sin(7 * angle + 0.4) + 0.37 * Math.sin(11 * angle - 0.9));
    const rx = 112 + (recipe.egg ?? 0) * Math.sin(angle);
    const ry = recipe.nearCircle ? 105 : 74;
    const flatten = 1 - (recipe.flat ?? 0) * Math.max(0, Math.cos(angle - 0.7)) ** 4;
    return [
      (rx + hand) * Math.cos(angle) + (recipe.drift ?? 0) * raw,
      (ry + hand) * Math.sin(angle) * flatten,
    ];
  });
  return {
    id: `${split}-ellipse-${recipe.name}`,
    kind: "ellipse",
    variation: recipe.name,
    split,
    samples: samplesFromTrace(points, recipe.angle),
    expected: { kinds: ["ellipse"] },
  };
}
