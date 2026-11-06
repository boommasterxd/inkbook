import { ellipseExample } from "./ellipse-traces";
import type { EllipseRecipe } from "./ellipse-traces";

const FROZEN_RECIPES: readonly EllipseRecipe[] = [
  {
    name: "low-start-egg-gap",
    phase: 1.23,
    egg: -7.2,
    gap: 0.009,
    uneven: true,
    wave: 3.7,
    angle: 0.31,
  },
  {
    name: "reverse-round-overshoot",
    phase: -2.47,
    reverse: true,
    nearCircle: true,
    overrun: 0.019,
    wave: 4.1,
    angle: -0.17,
  },
  {
    name: "flattened-drifting-oblique",
    phase: 2.73,
    flat: 0.055,
    drift: -4.8,
    wave: 3.3,
    angle: 0.87,
  },
  {
    name: "upper-left-fast-return",
    phase: -2.11,
    reverse: true,
    egg: 6.3,
    uneven: true,
    gap: 0.005,
    wave: 6.5,
    angle: -0.48,
  },
  {
    name: "soft-wobble-overlap",
    phase: 0.38,
    flat: 0.042,
    egg: -4.4,
    overrun: 0.014,
    uneven: true,
    wave: 3.9,
    angle: 1.04,
  },
];

export function ellipseEvaluationExamples() {
  return FROZEN_RECIPES.map((recipe) => ellipseExample(recipe, "evaluation"));
}
