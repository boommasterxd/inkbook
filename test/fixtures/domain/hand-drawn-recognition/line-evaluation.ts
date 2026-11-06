import { lineExample } from "./line-traces";
import type { LineRecipe } from "./line-traces";

const FROZEN_RECIPES: readonly LineRecipe[] = [
  {
    name: "descending-wrist-drift",
    line: "straight",
    waypoints: [
      [0, 0],
      [25, -1.5],
      [76, 2.3],
      [150, 3.2],
      [217, -0.8],
      [250, 0.5],
    ],
    reverse: true,
    uneven: true,
    angle: -1.23,
    wave: 2.3,
  },
  {
    name: "long-shallow-sweep-tremor",
    line: "straight",
    control: [92, -10.4],
    endpoint: 5.5,
    wave: 2.7,
    angle: 2.63,
  },
  {
    name: "off-center-quadratic-return",
    line: "curved",
    control: [68, -119],
    reverse: true,
    uneven: true,
    endpoint: 5,
    wave: 3.1,
    angle: 0.43,
  },
  {
    name: "almost-half-circle-fast-center",
    line: "curved",
    arc: 3.04,
    uneven: true,
    wave: 3.6,
    angle: -0.76,
  },
  {
    name: "upright-late-round-bend",
    line: "curved",
    control: [186, 95],
    endpoint: -6.5,
    wave: 3,
    angle: 1.31,
  },
];

export function lineEvaluationExamples() {
  return FROZEN_RECIPES.map((recipe) => lineExample(recipe, "evaluation"));
}
