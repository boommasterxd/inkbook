import { arrowExample } from "./arrow-traces";
import type { ArrowRecipe } from "./arrow-traces";

const FROZEN_RECIPES: readonly ArrowRecipe[] = [
  {
    name: "curved-open-wrist-return",
    start: "none",
    end: "arrow",
    bend: 88,
    unequal: 0.88,
    returnOffset: 4.6,
    uneven: true,
    wave: 3.7,
    angle: -0.93,
  },
  {
    name: "reverse-triangle-side-to-circle",
    start: "triangle",
    end: "circle",
    attachment: "edge",
    reverse: true,
    unequal: 1.31,
    headWave: 1.4,
    wave: 3.2,
    angle: 0.79,
  },
  {
    name: "curved-diamond-start-loose-launch",
    start: "diamond",
    end: "none",
    attachment: "rear",
    bend: -123,
    unequal: 0.83,
    headScale: 1.13,
    uneven: true,
    wave: 3.6,
    angle: 0.18,
  },
  {
    name: "circle-to-triangle-sweeping-up",
    start: "circle",
    end: "triangle",
    attachment: "rear",
    bend: 103,
    unequal: 1.08,
    headWave: 1.8,
    angle: -1.12,
  },
  {
    name: "open-to-diamond-oblique-tremor",
    start: "arrow",
    end: "diamond",
    attachment: "edge",
    returnOffset: 3.9,
    unequal: 1.28,
    wave: 7.6,
    uneven: true,
    headScale: 0.94,
    angle: 2.38,
  },
];

export function arrowEvaluationExamples() {
  return FROZEN_RECIPES.map((recipe) => arrowExample(recipe, "evaluation"));
}
