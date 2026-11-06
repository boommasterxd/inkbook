import { POLYGON_KINDS, polygonExample } from "./closed-traces";
import type { PolygonRecipe } from "./closed-traces";

const RECIPES: readonly PolygonRecipe[] = [
  { name: "corner-start-hesitant", corner: 4, wave: 2.7 },
  { name: "counterclockwise-fast", reverse: true, uneven: true, corner: 3.5 },
  { name: "mid-side-start", start: 0.095, wave: 3.5 },
  { name: "rounded-turns", round: 0.095, corner: 3, wave: 1.8 },
  { name: "short-closing-gap", gap: 0.008, corner: 4, wave: 2.6 },
  { name: "closure-overrun", overrun: 0.025, start: 0.19, corner: 3.2 },
  { name: "unequal-corners", corner: 8, wave: 1.5 },
  { name: "wavy-sides", wave: 10.3, corner: 3.4, uneven: true },
  { name: "slow-corners-fast-sides", uneven: true, start: 0.34, wave: 2.8 },
  { name: "slanted-handedness", skew: 0.065, reverse: true, corner: 3.8, angle: -0.28 },
  { name: "brief-start-correction", retrace: true, start: 0.11, wave: 2.1 },
  {
    name: "compact-balanced-outline",
    square: true,
    round: 0.035,
    reverse: true,
    corner: 2.4,
    angle: 0.51,
  },
];

export function polygonDevelopmentExamples() {
  return POLYGON_KINDS.flatMap((kind) =>
    RECIPES.map((recipe) => polygonExample(kind, recipe, "development")),
  );
}
