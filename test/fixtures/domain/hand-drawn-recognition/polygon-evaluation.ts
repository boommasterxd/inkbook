import { POLYGON_KINDS, polygonExample } from "./closed-traces";
import type { PolygonRecipe } from "./closed-traces";

// Frozen before recognizer execution. Independent combined gestures, not seeds of development traces.
const FROZEN_RECIPES: readonly PolygonRecipe[] = [
  {
    name: "rounded-mid-side-counterclockwise",
    start: 0.137,
    reverse: true,
    round: 0.075,
    uneven: true,
    corner: 5.1,
    angle: 0.19,
  },
  {
    name: "lopsided-gap-after-fast-return",
    start: 0.413,
    gap: 0.011,
    corner: 6.7,
    wave: 3.2,
    uneven: true,
    angle: -0.41,
  },
  {
    name: "wavy-retraced-launch",
    start: 0.277,
    retrace: true,
    wave: 9.1,
    skew: -0.047,
    corner: 4.5,
    angle: 0.72,
  },
  {
    name: "soft-overlap-reversed",
    start: 0.631,
    reverse: true,
    overrun: 0.018,
    round: 0.045,
    wave: 3.6,
    corner: 4.1,
    angle: -0.16,
  },
  {
    name: "balanced-tilted-hesitant-closure",
    square: true,
    start: 0.824,
    gap: 0.004,
    round: 0.025,
    uneven: true,
    corner: 3.3,
    wave: 3,
    angle: 0.93,
  },
];

export function polygonEvaluationExamples() {
  return POLYGON_KINDS.flatMap((kind) =>
    FROZEN_RECIPES.map((recipe) => polygonExample(kind, recipe, "evaluation")),
  );
}
